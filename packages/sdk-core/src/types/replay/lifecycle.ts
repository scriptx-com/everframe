// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// REPLAY-02 — platform-neutral session-replay lifecycle state machine.
// Also owns CONFIG-04 (sampling gate) and REPLAY-06 (shared session epoch).
//
// State machine (locked, RESEARCH §"Lifecycle state machine"):
//   IDLE → BUFFERING → FROZEN → (SUBMITTED | DISCARDED) → BUFFERING
//   - IDLE→BUFFERING (tryStart):  effective-enabled (serverEnabled && !locallyDisabled)
//                                 AND sampling gate passes (random() < samplingRate).
//   - BUFFERING→FROZEN (freeze):  freeze() at top of reporter-open (before modal mount).
//   - FROZEN→SUBMITTED (complete):takeFrozen() → resume start() → BUFFERING.
//   - FROZEN→DISCARDED (cancel):  discardAndResume() (zeroize) → resume start() → BUFFERING.
//   - Any→DISCARDED (forceDiscard): logout/identity change → zeroize → IDLE (no auto-resume).
//   - Idempotency:                open while FROZEN = no-op (never a second buffer).
//
// sdk-core stays DOM-free: this module calls `adapter.replay?.*` but never imports a recorder library.
import { __traceReplay } from '../../debug/replay-trace.js';
import type { PlatformAdapter, ReplayCapture } from '../platform.js';
import type { ReplayConfig } from './config-provider.js';

export type ReplayState = 'IDLE' | 'BUFFERING' | 'FROZEN' | 'SUBMITTED' | 'DISCARDED';

export interface ReplayLifecycleDeps {
  /** Only the optional replay seam is needed. The recorder lives in the platform package. */
  adapter: Pick<PlatformAdapter, 'replay'>;
  /** Source of the current server config (replayEnabled + samplingRate + durationSec). */
  getConfig: () => ReplayConfig;
  /** Client veto (EverframeConfig.sessionReplay.disabled). Can turn OFF, never ON. */
  locallyDisabled: boolean;
  /** Injectable RNG for the sampling gate (CONFIG-04). Defaults to Math.random. */
  random?: () => number;
  /** Injectable monotonic clock (ms). Defaults to performance.now (or Date.now). */
  now?: () => number;
}

export interface ReplayLifecycle {
  /** Current state. */
  readonly state: ReplayState;
  /** Shared monotonic session epoch (REPLAY-06) minted once at creation. */
  readonly sessionEpoch: number;
  /**
   * IDLE→BUFFERING. Returns true if buffering started. Evaluates the sampling gate
   * EXACTLY ONCE (CONFIG-04). Guarded no-op (returns false) in any non-IDLE state.
   */
  tryStart(): boolean;
  /** BUFFERING→FROZEN. Guarded no-op if not BUFFERING (idempotent open). */
  freeze(): void;
  /** FROZEN→SUBMITTED→BUFFERING. Returns the capture (or null). Guarded no-op if not FROZEN. */
  complete(): Promise<ReplayCapture | null>;
  /** FROZEN→DISCARDED→BUFFERING (zeroize, resume). Guarded no-op if not FROZEN. */
  cancel(): void;
  /** Any→DISCARDED→IDLE (logout/identity change). Always zeroizes; no auto-resume. */
  forceDiscard(): void;
}

function defaultNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

export function createReplayLifecycle(deps: ReplayLifecycleDeps): ReplayLifecycle {
  const { adapter, getConfig, locallyDisabled } = deps;
  const random = deps.random ?? Math.random;
  const now = deps.now ?? defaultNow;

  let state: ReplayState = 'IDLE';
  /** The session's single sampling draw (CONFIG-04), compared against the live rate. */
  let samplingDraw: number | null = null;
  // REPLAY-06: one monotonic session epoch minted at creation, reused for the
  // envelope stamp and replay event ts so they align against one origin.
  const sessionEpoch = now();

  const replay = adapter.replay;

  /** Effective enablement: server says ON AND the client has not vetoed (never force-ON). */
  function effectiveEnabled(): boolean {
    return getConfig().replayEnabled === true && locallyDisabled !== true;
  }

  /** Begin (or resume) the rolling buffer at the current configured duration. */
  function beginBuffering(): void {
    const durationSec = getConfig().replayDurationSec;
    replay?.start(durationSec);
    state = 'BUFFERING';
    __traceReplay('lifecycle.buffering', { durationSec });
  }

  return {
    get state(): ReplayState {
      return state;
    },
    get sessionEpoch(): number {
      return sessionEpoch;
    },

    tryStart(): boolean {
      const from = state;
      // Guarded: only IDLE may open a fresh buffer (idempotent open elsewhere).
      if (state !== 'IDLE') {
        __traceReplay('lifecycle.tryStart', { from, started: false, reason: 'not_idle' });
        return false;
      }
      if (!effectiveEnabled()) {
        __traceReplay('lifecycle.tryStart', { from, started: false, reason: 'disabled' });
        return false;
      }
      // CONFIG-04 — ONE draw per session, held and compared against the live
      // rate. The start is retried on every config resolution now, and a fresh
      // draw per attempt would hand a sampled-out session repeated chances;
      // re-drawing on a rate change compounds the same way (out at 0.5 then
      // re-drawn at 0.6 ⇒ 0.8 cumulative, not 0.6). Holding the draw makes
      // inclusion exactly P(draw < rate) however often it is evaluated, while
      // a genuine server rate change still applies in both directions.
      // samplingRate 0 ⇒ never (0 < 0 false); 1 ⇒ always (draw < 1 always true).
      if (samplingDraw === null) {
        samplingDraw = random();
      }
      if (!(samplingDraw < getConfig().samplingRate)) {
        __traceReplay('lifecycle.tryStart', { from, started: false, reason: 'sampled_out' });
        return false;
      }
      beginBuffering();
      __traceReplay('lifecycle.tryStart', { from, started: true });
      return true;
    },

    freeze(): void {
      const from = state;
      // Idempotent open: only BUFFERING transitions; freeze while FROZEN is a no-op.
      if (state !== 'BUFFERING') {
        __traceReplay('lifecycle.freeze', { from, applied: false });
        return;
      }
      replay?.freeze();
      state = 'FROZEN';
      __traceReplay('lifecycle.freeze', { from, applied: true });
    },

    async complete() {
      const from = state;
      if (state !== 'FROZEN') {
        __traceReplay('lifecycle.complete', { from, applied: false, bytes: null });
        return null;
      }
      const capture = (await replay?.takeFrozen()) ?? null;
      state = 'SUBMITTED';
      __traceReplay('lifecycle.complete', {
        from,
        applied: true,
        bytes: capture ? capture.bytes.byteLength : null,
        ...(capture ? { durationMs: capture.durationMs } : {}),
      });
      // Resume a fresh buffer for the next report.
      beginBuffering();
      return capture;
    },

    cancel(): void {
      const from = state;
      if (state !== 'FROZEN') {
        __traceReplay('lifecycle.cancel', { from, applied: false });
        return;
      }
      replay?.discardAndResume();
      state = 'DISCARDED';
      __traceReplay('lifecycle.cancel', { from, applied: true });
      // Resume a fresh (zeroized) buffer for the next report.
      beginBuffering();
    },

    forceDiscard(): void {
      const from = state;
      // Forced discard fires from ANY state (logout/identity change). Always
      // zeroize via the adapter, then return to IDLE — no auto-resume, since the
      // identity that owned the buffer is gone.
      if (state === 'IDLE') {
        __traceReplay('lifecycle.forceDiscard', { from, applied: false });
        return;
      }
      replay?.discardAndResume();
      state = 'IDLE';
      __traceReplay('lifecycle.forceDiscard', { from, applied: true });
    },
  };
}
