// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// REPLAY-02 — platform-neutral session-replay lifecycle state machine.
// Also owns CONFIG-04 (sampling gate) and REPLAY-06 (shared session epoch).
//
// State machine (locked, RESEARCH §"Lifecycle state machine"):
//   IDLE → BUFFERING → FROZEN → (SUBMITTED | DISCARDED) → BUFFERING
//   - IDLE→BUFFERING (tryStart):  effective-enabled (serverEnabled && !locallyDisabled)
//                                 AND sampling gate passes (one held draw < the rate
//                                 for the session's kind, see `replaySamplingRate`).
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

/**
 * Which replay coverage a session samples against (crash-only sessions spec
 * 2026-10-12). `'report'` is the default: a session that can file a report.
 * `'crashOnly'` is a session whose host turned the reporter off
 * (`reporter.disabled`). `'upgraded'` was such a session after a Companion
 * bond; Companion has been removed and no SDK produces it any more, but the
 * value stays accepted until the next major.
 */
export type ReplaySessionKind = 'report' | 'crashOnly' | 'upgraded';

/**
 * The sampling rate for a session kind. A crash-only session uses
 * `crashOnlySamplingRate`, and an absent field (an older server, or one that
 * was not sent the `crashonly` feature token) means 0: such a session never
 * records. An upgraded session uses the higher of the two rates, so an
 * upgrade never stops a recording the crash-only rate admitted.
 */
export function replaySamplingRate(config: ReplayConfig, kind: ReplaySessionKind): number {
  const crashOnlyRate = config.crashOnlySamplingRate ?? 0;
  switch (kind) {
    case 'crashOnly':
      return crashOnlyRate;
    case 'upgraded':
      return Math.max(config.samplingRate, crashOnlyRate);
    default:
      return config.samplingRate;
  }
}

export interface ReplayLifecycleDeps {
  /** Only the optional replay seam is needed. The recorder lives in the platform package. */
  adapter: Pick<PlatformAdapter, 'replay'>;
  /** Source of the current server config (replayEnabled + samplingRate + durationSec). */
  getConfig: () => ReplayConfig;
  /**
   * Client veto (EverframeConfig.sessionReplay.disabled). Can turn OFF, never
   * ON. A function is read on every start attempt.
   */
  locallyDisabled: boolean | (() => boolean);
  /**
   * The session's current kind, read on every start attempt. Defaults to
   * `'report'`, which samples against `samplingRate` exactly as before.
   */
  sessionKind?: () => ReplaySessionKind;
  /** Injectable RNG for the sampling gate (CONFIG-04). Defaults to Math.random. */
  random?: () => number;
  /** Injectable monotonic clock (ms). Defaults to performance.now (or Date.now). */
  now?: () => number;
  /**
   * Real-device quick capture (spec 2026-10-23): true while quick capture is
   * armed on a linked or debug device with `captureHotkey.replay`. Bypasses
   * `replayEnabled` and the sampling draw. `locallyDisabled` still wins. Read
   * on every start attempt and by `reevaluate()`; a throw reads as false.
   */
  forced?: () => boolean;
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
  /**
   * Re-check a buffer that only `forced` started. Once forcing ends, the
   * buffer is kept (and from then on owned by sampling) when the normal gate
   * admits the session, and otherwise discarded and stopped (state IDLE). Any
   * other state, or a buffer the sampling gate admitted, is left alone.
   */
  reevaluate(): void;
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
  const sessionKind = deps.sessionKind ?? ((): ReplaySessionKind => 'report');
  const forcedDep = deps.forced;

  let state: ReplayState = 'IDLE';
  /** What opened the current buffer. Kept across complete()/cancel() resumes. */
  let startedBy: 'sampling' | 'forced' | null = null;
  /** A reevaluate() that arrived while FROZEN, applied when the buffer resumes. */
  let reevaluatePending = false;
  /** The session's single sampling draw (CONFIG-04), compared against the live rate. */
  let samplingDraw: number | null = null;
  /** Kinds whose rate has admitted this session. Kept for the whole session. */
  const admittedKinds = new Set<ReplaySessionKind>();
  // REPLAY-06: one monotonic session epoch minted at creation, reused for the
  // envelope stamp and replay event ts so they align against one origin.
  const sessionEpoch = now();

  const replay = adapter.replay;

  function isVetoed(): boolean {
    const vetoed = typeof locallyDisabled === 'function' ? locallyDisabled() : locallyDisabled;
    return vetoed === true;
  }

  /** Effective enablement: server says ON AND the client has not vetoed (never force-ON). */
  function effectiveEnabled(): boolean {
    return getConfig().replayEnabled === true && !isVetoed();
  }

  function isForced(): boolean {
    if (!forcedDep) return false;
    try {
      return forcedDep() === true;
    } catch {
      return false;
    }
  }

  /**
   * The sampling gate for the session's current kind, against the ONE held
   * draw (see tryStart). Records an admission, which then lasts the session.
   */
  function samplingAdmits(): { admitted: boolean; kind: ReplaySessionKind } {
    if (samplingDraw === null) {
      samplingDraw = random();
    }
    const kind = sessionKind();
    // An upgrade never stops a recording: an upgraded session inherits the
    // crash-only admission, even after a later cut to both rates.
    if (kind === 'upgraded' && admittedKinds.has('crashOnly')) admittedKinds.add('upgraded');
    if (!admittedKinds.has(kind)) {
      if (!(samplingDraw < replaySamplingRate(getConfig(), kind))) {
        return { admitted: false, kind };
      }
      admittedKinds.add(kind);
    }
    return { admitted: true, kind };
  }

  /**
   * Resume after complete()/cancel(), applying a reevaluation remembered
   * while FROZEN: a buffer only forcing started, whose forcing has ended and
   * which the normal gate does not admit, is not restarted (IDLE, recorder
   * stopped).
   */
  function resumeOrEnd(): void {
    const pending = reevaluatePending;
    reevaluatePending = false;
    if (pending && startedBy === 'forced' && !isForced()) {
      if (effectiveEnabled() && samplingAdmits().admitted) {
        startedBy = 'sampling';
      } else {
        state = 'IDLE';
        startedBy = null;
        replay?.stop();
        __traceReplay('lifecycle.reevaluate', { applied: true, reason: 'on_resume' });
        return;
      }
    }
    beginBuffering();
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
      // Quick capture's forcing bypasses the server switch and the sampling
      // draw, never the client veto.
      if (!isVetoed() && isForced()) {
        startedBy = 'forced';
        beginBuffering();
        __traceReplay('lifecycle.tryStart', { from, started: true, reason: 'forced' });
        return true;
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
      //
      // Crash-only sessions (spec 2026-10-12): the rate depends on the
      // session's kind, and every kind compares the SAME draw. Once a kind's
      // rate has admitted the session, that kind stays admitted for the rest
      // of the session, so a later rate cut cannot keep a session that was
      // already recording from resuming (after a forced discard, say). A kind
      // that has not admitted the session is still compared against its live
      // rate, as before.
      const { admitted, kind } = samplingAdmits();
      if (!admitted) {
        __traceReplay('lifecycle.tryStart', {
          from,
          started: false,
          reason: 'sampled_out',
          kind,
        });
        return false;
      }
      startedBy = 'sampling';
      beginBuffering();
      __traceReplay('lifecycle.tryStart', { from, started: true, kind });
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
      resumeOrEnd();
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
      resumeOrEnd();
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
      startedBy = null;
      reevaluatePending = false;
      __traceReplay('lifecycle.forceDiscard', { from, applied: true });
    },

    reevaluate(): void {
      if (state === 'FROZEN' && startedBy === 'forced') {
        // The freeze belongs to a capture in progress; decide at its resume.
        reevaluatePending = true;
        __traceReplay('lifecycle.reevaluate', { applied: false, reason: 'pending_frozen' });
        return;
      }
      if (state !== 'BUFFERING' || startedBy !== 'forced' || isForced()) {
        __traceReplay('lifecycle.reevaluate', { applied: false });
        return;
      }
      if (effectiveEnabled() && samplingAdmits().admitted) {
        startedBy = 'sampling';
        __traceReplay('lifecycle.reevaluate', { applied: false, reason: 'sampled_in' });
        return;
      }
      replay?.discardAndResume();
      state = 'IDLE';
      startedBy = null;
      // discardAndResume leaves the recorder observing; nothing owns this
      // buffer any more, so stop it until a later tryStart.
      replay?.stop();
      __traceReplay('lifecycle.reevaluate', { applied: true });
    },
  };
}
