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
  presenter: Pick<Presenter, 'toast'>;
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

export function createGestureRecording(deps: GestureRecordingDeps): GestureRecording {
  let session: Session | null = null;
  const handled: string[] = [];

  const stillLinked = (s: Session): boolean =>
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

  return {
    onRequest(request) {
      if (!request || typeof request.id !== 'string' || typeof request.expiresAt !== 'number')
        return;
      if (session || handled.includes(request.id)) return;
      if (!(request.expiresAt > deps.wallNow())) return;
      const link = deps.deviceLink.current();
      if (!link) return;
      handled.push(request.id);
      if (handled.length > HANDLED_MAX) handled.shift();
      const s: Session = {
        id: request.id,
        token: link.token,
        generation: deps.deviceLink.generation(),
        firstDown: undefined,
        events: [],
        open: new Map(),
      };
      session = s;
      deps.presenter.toast(RECORDING_STARTED);
      deps.setTimeout(() => finish(s), RECORDING_MS);
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
