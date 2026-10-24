// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Real-device quick capture (web TVs): "record on device". A config for a
// linked TV can carry `deviceLinking.link.recording { id, expiresAt }`; the TV
// then records the remote keys pressed over the next 10 s and posts them with
// its device token. Lazy chunk.
//
// The token is taken when the recording starts, and the upload goes through
// the client of the runtime that started it. If the stored link is no longer
// that token when the 10 s end (unlinked, relinked, or the runtime torn
// down), nothing is posted. A failed upload shows nothing. DEFE-02: nothing
// here throws into the host.
import { COPY } from './copy.js';
import type { DeviceLinkController } from './device-link.js';
import { RECORDING_ID_RE, type RecordingClient } from './link-client.js';
import type { Overlay } from './overlay.js';
import { DURATION_MS, GestureRecorder } from './recorder.js';

export interface GestureRecordingTimers {
  set(fn: () => void, ms: number): unknown;
  clear(h: unknown): void;
}

export interface GestureRecordingDeps {
  client: RecordingClient;
  link: Pick<DeviceLinkController, 'snapshot'>;
  overlay: Pick<Overlay, 'toast'>;
  /** The key listener's monotonic clock (the recorder's times). */
  now(): number;
  /** Wall-clock milliseconds, for `expiresAt`. */
  wallNow(): number;
  timers: GestureRecordingTimers;
  /** The recorder came or went: the key listener re-arms. */
  onActiveChanged(): void;
  /** Tizen: register every registrable contract key for the recording. */
  registerAllKeys(): void;
}

export interface GestureRecording {
  onRequest(req: { id: string; expiresAt: string } | null | undefined): void;
  readonly active: GestureRecorder | null;
  teardown(): void;
}

function guard(fn: () => void): void {
  try {
    fn();
  } catch {
    /* DEFE-02 */
  }
}

export function createGestureRecording(deps: GestureRecordingDeps): GestureRecording {
  const handled: { [id: string]: true } = {};
  let active: GestureRecorder | null = null;
  let timer: unknown = null;
  let tornDown = false;

  function currentToken(): string | null {
    try {
      return deps.link.snapshot()?.token ?? null;
    } catch {
      return null;
    }
  }

  function finish(id: string, token: string, recorder: GestureRecorder): void {
    timer = null;
    if (tornDown || active !== recorder) return;
    let events: ReturnType<GestureRecorder['finish']> = [];
    try {
      events = recorder.finish(deps.now());
    } catch {
      events = [];
    }
    active = null;
    guard(() => deps.onActiveChanged());
    if (currentToken() !== token) return;
    let upload: Promise<boolean>;
    try {
      upload = deps.client.postRecording(id, token, events);
    } catch {
      return;
    }
    upload.then(
      (ok) =>
        guard(() => {
          if (ok && !tornDown && currentToken() === token) deps.overlay.toast(COPY.RECORDING_SENT);
        }),
      () => undefined,
    );
  }

  return {
    get active(): GestureRecorder | null {
      return active;
    },

    onRequest(req): void {
      try {
        if (tornDown || !req || active) return;
        const id = req.id;
        if (typeof id !== 'string' || !RECORDING_ID_RE.test(id) || handled[id] === true) return;
        const expires = typeof req.expiresAt === 'string' ? Date.parse(req.expiresAt) : NaN;
        if (!(expires > deps.wallNow())) return;
        const token = currentToken();
        if (token === null) return;
        handled[id] = true;
        const recorder = new GestureRecorder();
        active = recorder;
        guard(() => deps.overlay.toast(COPY.RECORDING_STARTED));
        guard(() => deps.registerAllKeys());
        guard(() => deps.onActiveChanged());
        timer = deps.timers.set(() => guard(() => finish(id, token, recorder)), DURATION_MS);
      } catch {
        /* DEFE-02 */
      }
    },

    teardown(): void {
      if (tornDown) return;
      tornDown = true;
      const h = timer;
      timer = null;
      active = null;
      if (h !== null) guard(() => deps.timers.clear(h));
    },
  };
}
