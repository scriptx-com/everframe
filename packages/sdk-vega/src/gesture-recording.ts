// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Record on device: a teammate picks the capture gesture in the dashboard by
// pressing it on a linked TV. The config reply carries a recording request;
// the device records its remote keys for 10 seconds and uploads them.
//
// Rules (from the other SDKs' reviews):
// - The token and the link generation are taken when the recording starts.
//   The upload goes out with that token, and only while the device still
//   holds it: a relink or unlink during the window posts nothing.
// - While a recording runs, the capture gesture is off (the client checks
//   `active()`), so pressing the current gesture never files a capture.
// - The 10 s window starts only once the prompt is on screen (the overlay
//   may be showing other toasts, have no root mounted yet, or the app may be
//   in the background). A request whose prompt could not be shown before it
//   expired is not used up: the server can offer it again.
import type { CurrentLink, Presenter } from './device-link.js';
import type { RecordingClient } from './link-client.js';
import { RECORDING_SENT, RECORDING_STARTED } from './link-copy.js';
import type { GestureKey } from './remote-keys.js';

export const RECORDING_MS = 10_000;
export const RECORDING_MAX_EVENTS = 32;
/** The upload's own deadline; longer than the other link calls' request timeout. */
export const RECORDING_POST_TIMEOUT_MS = 30_000;
/** Request ids remembered so a request repeated by every config reply runs once. */
const HANDLED_MAX = 16;

/** One key press, in ms from the recording's first key down. */
export interface RecordedKey {
  key: GestureKey;
  downMs: number;
  upMs: number;
}

export interface RecordingRequest {
  id: string;
  /** Wall-clock ms. */
  expiresAt: number;
}

export interface GestureRecordingDeps {
  client: RecordingClient;
  deviceLink: { current(): CurrentLink | null; generation(): number };
  presenter: Pick<Presenter, 'toast'> & {
    /** Shows `text`; `onShown` runs once it is on screen. Returns a withdraw. */
    prompt(text: string, onShown: () => void): () => void;
  };
  /** Monotonic enough for key timing. */
  now: () => number;
  /** Wall clock, for the request's expiry. */
  wallNow: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface GestureRecording {
  onRequest(request: RecordingRequest): void;
  active(): boolean;
  /** A key event; `null` is a key with no contract name, which is dropped. */
  onKey(key: GestureKey | null, action: 'down' | 'up'): void;
}

interface Session {
  id: string;
  token: string;
  generation: number;
  firstDown: number | undefined;
  events: RecordedKey[];
  /** Keys down now, by their event's index. */
  open: Map<GestureKey, number>;
}

/** A request whose prompt is queued but not on screen yet. */
interface Waiting {
  id: string;
  expiresAt: number;
  token: string;
  generation: number;
  withdraw: () => void;
  expiry: unknown;
}

export function createGestureRecording(deps: GestureRecordingDeps): GestureRecording {
  let session: Session | null = null;
  let waiting: Waiting | null = null;
  const handled: string[] = [];

  const stillLinked = (s: { token: string; generation: number }): boolean =>
    deps.deviceLink.generation() === s.generation && deps.deviceLink.current()?.token === s.token;

  function finish(s: Session): void {
    if (session !== s) return;
    session = null;
    if (s.firstDown !== undefined) {
      const end = Math.max(0, deps.now() - s.firstDown);
      s.open.forEach((index) => {
        const event = s.events[index]!;
        event.upMs = Math.max(event.downMs, end);
      });
    }
    if (!stillLinked(s)) return;
    const events = s.events.map(({ key, downMs, upMs }) => ({ key, downMs, upMs }));
    let upload: Promise<boolean>;
    try {
      upload = deps.client.postRecording(s.id, s.token, events);
    } catch {
      return;
    }
    upload.then(
      (ok) => {
        if (ok && stillLinked(s)) deps.presenter.toast(RECORDING_SENT);
      },
      () => undefined,
    );
  }

  /** The prompt is on screen: the window starts now. */
  function begin(w: Waiting): void {
    if (waiting !== w) return;
    waiting = null;
    deps.clearTimeout(w.expiry);
    if (!(w.expiresAt > deps.wallNow()) || !stillLinked(w)) return;
    handled.push(w.id);
    if (handled.length > HANDLED_MAX) handled.shift();
    const s: Session = {
      id: w.id,
      token: w.token,
      generation: w.generation,
      firstDown: undefined,
      events: [],
      open: new Map(),
    };
    session = s;
    deps.setTimeout(() => finish(s), RECORDING_MS);
  }

  return {
    onRequest(request) {
      if (!request || typeof request.id !== 'string' || typeof request.expiresAt !== 'number')
        return;
      if (session || waiting || handled.includes(request.id)) return;
      const left = request.expiresAt - deps.wallNow();
      if (!(left > 0)) return;
      const link = deps.deviceLink.current();
      if (!link) return;
      const w: Waiting = {
        id: request.id,
        expiresAt: request.expiresAt,
        token: link.token,
        generation: deps.deviceLink.generation(),
        withdraw: () => undefined,
        expiry: undefined,
      };
      waiting = w;
      // Not shown before the request expires: withdraw the prompt, keep the
      // request unused.
      w.expiry = deps.setTimeout(() => {
        if (waiting !== w) return;
        waiting = null;
        w.withdraw();
      }, left);
      w.withdraw = deps.presenter.prompt(RECORDING_STARTED, () => begin(w));
    },
    active: () => session !== null,
    onKey(key, action) {
      const s = session;
      if (!s || key === null) return;
      if (action === 'up') {
        const index = s.open.get(key);
        if (index === undefined) return;
        s.open.delete(key);
        const event = s.events[index]!;
        event.upMs = Math.max(event.downMs, deps.now() - (s.firstDown ?? 0));
        return;
      }
      // A held key's repeated downs are one press.
      if (s.open.has(key) || s.events.length >= RECORDING_MAX_EVENTS) return;
      const now = deps.now();
      if (s.firstDown === undefined) s.firstDown = now;
      const at = now - s.firstDown;
      s.open.set(key, s.events.length);
      s.events.push({ key, downMs: at, upMs: at });
    },
  };
}
