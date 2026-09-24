// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// REPLAY-01/04/05 + RWEB-01 — the rrweb rolling-buffer recorder behind the
// `PlatformAdapter.replay` seam (sdk-core owns the lifecycle; this owns the DOM
// serializer).
//
// Behaviour:
//   - LAZY-LOAD: rrweb is imported via dynamic `import('rrweb')` ONLY when start()
//     is called (the lifecycle only calls start() when config.replayEnabled). With
//     replay OFF the module is never evaluated → ~0 KB always-loaded (REPLAY-05).
//   - ROLLING BUFFER: emit→buffer with two-buffer checkout rotation + time/byte
//     pruning (buffer.ts). Self-disable on >150 ms/checkout serialization OR a
//     buffer-cap breach (RESEARCH §"Open Item 2").
//   - FREEZE/TRIM: freeze() captures freezeTs and stops appending; takeFrozen()
//     trims frames with ts > freezeTs (REPLAY-02 freeze-half).
//   - SCRUB + COMPRESS: takeFrozen() runs the post-serialization Luhn/JWT +
//     attribute-allowlist scrub (scrub.ts), then gzips via the sdk-core path,
//     yielding a ReplayCapture{ format:'rrweb', bytes, durationMs }.
//
// `import('rrweb')` is referenced ONLY inside start() so the lazy-load grep gate
// holds and a static `import … from 'rrweb'` never appears in this file.
import { gzipBytes, __traceReplay, type RedactionEngineConfig } from '@everframe/sdk-core';
import type { ReplayCapture } from '@everframe/sdk-core';

import {
  createRollingBuffer,
  FULL_SNAPSHOT,
  type BufferEvent,
  type RollingBuffer,
} from './buffer.js';
import { buildRecordOptions, REDACTION_DISABLED } from './mask-mapping.js';
import { scrubReplayEvents } from './scrub.js';

// NOTE — no per-checkout serialization budget. A previous revision measured
// "serialization cost" as (checkout emit − previous emit) and self-disabled
// past 150 ms; with checkoutEveryNms = 15s by design, the second checkout of
// EVERY session measured ~15,000 ms and killed replay on all platforms
// (field bug 2026-08-27). rrweb's emit offers no start-of-serialization
// signal to measure against, so hostile-page protection is owned entirely by
// the buffer caps below (MAX_BUFFER_BYTES / MAX_BUFFER_EVENTS → selfDisable).

/**
 * Ceiling on cap-overflow re-anchors per session — see recoverFromOverflow.
 * Generous: a legitimate navigation burst costs one or two; only a page that
 * overflows on every reset (rAF/canvas spam) burns through all of them.
 */
export const MAX_OVERFLOW_RESETS = 20;

/** rrweb module surface we depend on (kept minimal so the lazy import is typed). */
interface RrwebModule {
  record: ((options: Record<string, unknown>) => (() => void) | undefined) & {
    takeFullSnapshot?: (isCheckout?: boolean) => void;
  };
}

export interface ReplayRecorderDeps {
  /**
   * Lazy importer for rrweb. Defaults to `() => import('rrweb')`. Injectable so
   * the lazy-load spec can assert it is NOT called when replay is OFF, and the
   * perf-budget spec can drive a deterministic fake recorder.
   */
  importRrweb?: () => Promise<RrwebModule>;
  /** Source of the elements to map onto rr-block (host-marked sensitive). */
  sensitiveElements?: () => Element[];
  /** Customer redaction config threaded into the scrub pass. */
  redaction?: RedactionEngineConfig;
  /** Shared monotonic session epoch (REPLAY-06) — frame ts are offsets from this. */
  sessionEpoch?: number;
  /** Injectable clock for serialization timing (ms). Defaults to performance.now/Date.now. */
  now?: () => number;
  /**
   * Injectable clock for the FREEZE cutoff (ms). Defaults to `Date.now` — the SAME
   * epoch as rrweb frame timestamps (wall-clock ~1.7e12). WR-01: the freeze cutoff
   * must NOT use `performance.now()` (monotonic-from-process-start ~1e4), or it can
   * never exceed a buffered frame ts and the trim becomes dead code. Kept separate
   * from `now` so per-checkout serialization timing can stay on a monotonic clock.
   */
  freezeNow?: () => number;
  /** Injectable gzip (testing). Defaults to the sdk-core gzipBytes path. */
  gzip?: (input: Uint8Array) => Promise<Uint8Array>;
}

/**
 * Live recorder state, read off a device through the debug seam. Counts and
 * state only — never frame contents.
 */
export interface ReplayRecorderDiagnostics {
  disabled: boolean;
  frozen: boolean;
  freezeTs: number | null;
  /** rrweb loaded and `record()` handed back a stop handle. */
  recording: boolean;
  /** `takeFullSnapshot` bound — without it a cap breach cannot re-anchor. */
  canReanchor: boolean;
  frames: number;
  bytes: number;
  /** A window with no FullSnapshot is unplayable, so `takeFrozen()` drops it. */
  hasAnchor: boolean;
  oldestTs: number | null;
  newestTs: number | null;
  overflowResets: number;
  capBreached: boolean;
}

/** The recorder also exposes a couple of test/diagnostic accessors beyond the seam. */
export interface ReplayRecorder {
  start(durationSec: number): void;
  freeze(): void;
  discardAndResume(): void;
  takeFrozen(): Promise<ReplayCapture | null>;
  stop(): void;
  /**
   * Codex round-3 finding 2 (P1) — TERMINAL shutdown for the consent /
   * GDPR kill switch, and deliberately not `stop()`.
   *
   * `stop()` is reversible: it tears down the rrweb observers but leaves the
   * recorder willing to `start()` again, which is exactly what the lifecycle
   * does on its own initiative — `complete()` and `cancel()` both end in
   * `beginBuffering()` → `start()`. So a `destroy()` that lands while the
   * reporter is open (init.ts's `unwindOpen` → `lifecycle.cancel()` →
   * resume) would restart the observers *after* teardown had stopped them.
   *
   * `kill()` sets a latch that makes every later `start()`, `freeze()` and
   * `emit` a no-op no matter who calls it or in which order — nothing has to
   * be sequenced correctly for the switch to hold.
   */
  kill(): void;
  /**
   * Codex round-4 finding 2 (P1) — undo `kill()`, and ONLY `kill()`.
   *
   * `kill()` originally set the same permanent latch a self-disable uses. That
   * is correct for a host that pulled the consent switch and wrong for React
   * StrictMode, whose simulated unmount runs the REAL teardown
   * (provider.tsx → `client.kill()` → `adapter.onKill()` → `kill()` here) and
   * then remounts: session replay was permanently dead in every React dev
   * environment, and no rebind could bring it back.
   *
   * So the kill latch is revivable and the self-disable latch is not. The
   * adapter calls this from `__rebindCrumbHooks()` — the seam that means "a
   * live host mount owns this adapter", already the documented StrictMode /
   * Fast-Refresh recovery hook. A genuine `kill()` is never followed by one,
   * so the consent switch still holds; this is the same shape round 2 used for
   * the adapter's `reportingKilled`, not a second mechanism.
   *
   * Codex round-5 finding 2 (P1) — and it RESTARTS a window `kill()` stopped.
   *
   * Round 4's revive cleared the latch and restored nothing, on the reasoning
   * that the next `start()` rebuilds the buffer anyway. There is no next
   * `start()`: `kill()` does not touch the sdk-core lifecycle, so a recorder
   * killed while BUFFERING leaves the lifecycle in BUFFERING, and the remount's
   * `tryStart()` is a guarded no-op in every state but IDLE. Recording stayed
   * off with the lifecycle certain it was on — the next report froze an absent
   * buffer and shipped without a replay, and only completing or cancelling
   * that report (`complete()`/`cancel()` → `beginBuffering()` → `start()`)
   * ever brought it back. Fast Refresh, or any effect teardown/remount after
   * replay had started, was enough.
   *
   * So `revive()` is the exact inverse of `kill()`: it gives back the latch AND
   * the rolling window, at the duration that window was running at, but only if
   * one was actually running when the switch was pulled. A recorder killed
   * while IDLE (or while FROZEN, where the report that owned the window is over
   * either way) comes back armed but not recording, exactly as before — the
   * lifecycle's own `tryStart()` owns that case.
   */
  revive(): void;
  /**
   * True once recording is off: the session self-disabled (>150ms checkout or
   * buffer cap — permanent), or it was killed and not yet revived.
   */
  readonly disabled: boolean;
  /** Test seam — current retained frame count. */
  readonly __size: number;
  /** Debug seam — see ReplayRecorderDiagnostics. */
  __diagnostics(): ReplayRecorderDiagnostics;
}

/** A window with no FullSnapshot cannot be played back. */
function hasAnchor(frames: readonly BufferEvent[]): boolean {
  return frames.some((f) => f.type === FULL_SNAPSHOT);
}

function defaultNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

export function createReplayRecorder(deps: ReplayRecorderDeps = {}): ReplayRecorder {
  const importRrweb =
    deps.importRrweb ?? (() => import('rrweb') as unknown as Promise<RrwebModule>);
  const now = deps.now ?? defaultNow;
  // WR-01 — the freeze cutoff shares rrweb's Date.now() wall-clock epoch.
  const freezeNow = deps.freezeNow ?? Date.now;
  const gzip = deps.gzip ?? gzipBytes;
  const sessionEpoch = deps.sessionEpoch ?? 0;

  let buffer: RollingBuffer | null = null;
  let durationSec = 30;
  let stopFn: (() => void) | null = null;
  let frozen = false;
  let freezeTs: number | null = null;
  // The PERMANENT performance latch: a session that self-disabled (>150ms
  // checkout, or a cap breach with no re-anchor budget left) never records
  // again on this page. Distinct from `killed` below since round 4 — see
  // `revive()`.
  let selfDisabled = false;
  // Codex round-4 finding 2 (P1) — the CONSENT latch, and it is REVIVABLE.
  // `kill()` used to set `selfDisabled`, which nothing can clear; React
  // StrictMode's simulated unmount runs the real teardown (provider.tsx calls
  // `client.kill()` → `adapter.onKill()` → `recorder.kill()`) and then
  // remounts, so a terminal latch here left session replay permanently dead
  // for every StrictMode host. Cleared ONLY by `revive()`, which the adapter
  // calls from `__rebindCrumbHooks()` — the seam that means "a live host mount
  // owns this adapter". A genuine kill is never followed by one.
  let killed = false;
  /**
   * Codex round-5 finding 2 (P1) — was a rolling window LIVE when `kill()`
   * landed? `kill()` releases the buffer and the rrweb stop handle, and nothing
   * else ever restarts them (the sdk-core lifecycle is not told about a kill,
   * so it stays in BUFFERING and its `tryStart()` refuses). This is what lets
   * `revive()` put back exactly what was taken. See `ReplayRecorder.revive`.
   */
  let killedWhileRecording = false;
  let restoreMasks: (() => void) | null = null;
  let takeFullSnapshotFn: ((isCheckout?: boolean) => void) | null = null;
  let overflowResets = 0;
  let resettingOverflow = false;
  /**
   * Bumped by every start() and by stop()/selfDisable(). rrweb is imported
   * asynchronously, so two starts inside one import window both used to reach
   * `record()` and the second overwrote `stopFn` — leaving the first recorder's
   * observers running with nothing able to stop them.
   */
  let startGeneration = 0;

  /** Recording is off for good (self-disabled) or until revived (killed). */
  function inert(): boolean {
    return selfDisabled || killed;
  }

  function selfDisable(reason: string): void {
    __traceReplay('recorder.selfDisable', { reason, overflowResets });
    selfDisabled = true;
    startGeneration += 1; // stand down any import still in flight
    frozen = false;
    try {
      stopFn?.();
    } catch {
      /* swallow — DEFE-02 */
    }
    stopFn = null;
    takeFullSnapshotFn = null;
    buffer?.clear();
  }

  /**
   * Cap breach with nothing left to shed (buffer.ts already dropped the prior
   * window): clear and re-anchor with a fresh checkout instead of killing the
   * session — a navigation burst on a TV legitimately overflows one window
   * (field bug 2026-08-27, R6). Budgeted so a genuinely hostile page (every
   * reset instantly overflows again) still self-disables rather than churning
   * full snapshots forever.
   */
  function recoverFromOverflow(): void {
    if (takeFullSnapshotFn === null || overflowResets >= MAX_OVERFLOW_RESETS) {
      selfDisable(
        takeFullSnapshotFn === null ? 'overflow_no_reanchor' : 'overflow_budget_exhausted',
      );
      return;
    }
    overflowResets += 1;
    __traceReplay('recorder.overflowReset', { n: overflowResets, bytes: buffer?.byteSize() ?? 0 });
    buffer?.clear();
    resettingOverflow = true;
    try {
      takeFullSnapshotFn(true);
    } catch {
      selfDisable('reanchor_threw');
    } finally {
      resettingOverflow = false;
    }
    // Codex round-1 finding 3: the guard above suppresses the nested emit's
    // breach handling, so a recovery snapshot that ITSELF exceeds the cap
    // would otherwise leave the recorder enabled holding an oversized buffer.
    // Nothing smaller than a full snapshot can anchor a window — disable.
    if (buffer?.capBreached()) {
      selfDisable('reanchor_breached');
    }
  }

  function handleEmit(event: unknown, isCheckout?: boolean): void {
    if (inert() || frozen || !buffer) return;
    const e = event as BufferEvent;
    buffer.push(e, isCheckout === true);
    if (buffer.capBreached()) {
      // takeFullSnapshot emits synchronously back into this function; the
      // guard stops a same-tick breach from recursing into another reset.
      if (!resettingOverflow) recoverFromOverflow();
      return;
    }
    buffer.rotate(e.timestamp);
  }

  /**
   * The rolling window's one start path, hoisted out of the returned object so
   * `revive()` can re-open a window `kill()` closed (round-5 finding 2) without
   * routing through a public method.
   */
  function startRecording(reqDurationSec: number): void {
    // A self-disabled session never restarts; a killed one restarts only
    // after a live host mount revives it (round 4, finding 2).
    if (inert()) return;
    durationSec = reqDurationSec;
    frozen = false;
    freezeTs = null;
    if (!buffer) buffer = createRollingBuffer({ durationSec });
    // Map host-sensitive elements onto rr-block so rrweb omits their subtree.
    const els = deps.sensitiveElements?.() ?? [];
    // applyReplayMaskClasses is applied lazily where DOM exists; import here to
    // avoid a hard DOM dependency in non-DOM test contexts.
    if (els.length > 0 && typeof document !== 'undefined') {
      // Defer to a dynamic require-free path: add the class directly.
      for (const el of els) {
        try {
          (el as Element).classList?.add('rr-block');
        } catch {
          /* ignore */
        }
      }
      restoreMasks = () => {
        for (const el of els) {
          try {
            (el as Element).classList?.remove('rr-block');
          } catch {
            /* ignore */
          }
        }
      };
    }
    const options = buildRecordOptions({
      durationSec,
      emit: handleEmit,
      errorHandler: () => true,
    });
    const myGeneration = ++startGeneration;
    __traceReplay('recorder.start', { durationSec, frames: buffer.size() });
    // LAZY import — only evaluated here, never statically.
    void importRrweb()
      .then((mod) => {
        // A freeze landing between start() and this callback leaves the
        // session with a recorder that never actually ran — the trace names
        // it rather than letting the report ship an empty window silently.
        // A superseded generation stands down for the same reason: its
        // recorder would be unstoppable once a newer start owns `stopFn`.
        if (inert() || frozen || myGeneration !== startGeneration) {
          __traceReplay('recorder.rrwebSkipped', {
            reason:
              myGeneration !== startGeneration
                ? 'superseded'
                : inert()
                  ? 'disabled'
                  : 'frozen',
          });
          return;
        }
        try {
          const handle = mod.record(options as unknown as Record<string, unknown>);
          stopFn = typeof handle === 'function' ? handle : null;
          takeFullSnapshotFn =
            typeof mod.record.takeFullSnapshot === 'function'
              ? mod.record.takeFullSnapshot.bind(mod.record)
              : null;
          __traceReplay('recorder.rrwebStarted', {
            stopHandle: stopFn !== null,
            canReanchor: takeFullSnapshotFn !== null,
          });
        } catch {
          /* swallow — DEFE-02; a recorder failure must never crash the host */
          __traceReplay('recorder.rrwebThrew');
        }
      })
      .catch(() => {
        /* swallow — rrweb failed to load; replay silently unavailable */
        __traceReplay('recorder.rrwebImportFailed');
      });
  }

  return {
    start(reqDurationSec: number): void {
      startRecording(reqDurationSec);
    },

    freeze(): void {
      if (inert() || !buffer) {
        __traceReplay('recorder.freeze', {
          applied: false,
          reason: inert() ? 'disabled' : 'no_buffer',
        });
        return;
      }
      // Capture freezeTs FIRST (REPLAY-02), then stop appending. WR-01: the cutoff
      // is the MOMENT freeze() is called, on the Date.now epoch shared with rrweb
      // frame timestamps — NOT Math.max against the latest buffered frame (that
      // made the cutoff dead code, so a reporter-UI frame emitted synchronously
      // after freeze() with a later ts could survive trim).
      freezeTs = freezeNow();
      frozen = true;
      try {
        stopFn?.();
      } catch {
        /* swallow */
      }
      stopFn = null;
      restoreMasks?.();
      restoreMasks = null;
      // Thunked: `frames()` copies the whole retained window and the anchor
      // scan walks it — thousands of events on a TV, on every report, for a
      // detail a shipped build discards. Bound to THIS buffer, not the mutable
      // slot, so the deferred read cannot see a later one.
      const frozenBuffer = buffer;
      __traceReplay('recorder.freeze', () => ({
        applied: true,
        frames: frozenBuffer.size(),
        bytes: frozenBuffer.byteSize(),
        hasAnchor: hasAnchor(frozenBuffer.frames()),
      }));
    },

    discardAndResume(): void {
      __traceReplay('recorder.discardAndResume', { frames: buffer?.size() ?? 0 });
      buffer?.clear();
      frozen = false;
      freezeTs = null;
      restoreMasks?.();
      restoreMasks = null;
      // The lifecycle calls start() again to resume; we leave the (cleared)
      // buffer in place so a subsequent start() reuses it.
    },

    async takeFrozen(): Promise<ReplayCapture | null> {
      // Each early return is a distinct way a report ships with no replay, and
      // they were indistinguishable in the field — name them in the trace.
      if (!buffer) {
        __traceReplay('recorder.takeFrozen', { result: 'no_buffer' });
        return null;
      }
      const all = buffer.frames();
      if (all.length === 0) {
        __traceReplay('recorder.takeFrozen', { result: 'empty', disabled: inert() });
        return null;
      }
      // REPLAY-02 — trim every frame with ts > freezeTs (post-freeze noise such
      // as the reporter modal animation must never appear).
      const cutoff = freezeTs ?? Number.POSITIVE_INFINITY;
      const trimmed = all.filter((f) => f.timestamp <= cutoff);
      if (trimmed.length === 0) {
        __traceReplay('recorder.takeFrozen', {
          result: 'trimmed_empty',
          frames: all.length,
          cutoff,
          newestTs: all[all.length - 1]!.timestamp,
        });
        return null;
      }
      // The window must be anchored by a full snapshot or it is unplayable.
      if (!hasAnchor(trimmed)) {
        __traceReplay('recorder.takeFrozen', {
          result: 'no_anchor',
          frames: all.length,
          kept: trimmed.length,
        });
        return null;
      }
      // REPLAY-04 — post-serialization scrub gets the LAST word.
      // ⚠ TEMP: skipped when REDACTION_DISABLED (end-to-end replay verification).
      const scrubbed = REDACTION_DISABLED
        ? trimmed
        : scrubReplayEvents(trimmed, deps.redaction);
      const rawJson = JSON.stringify(scrubbed);
      const bytes = await gzip(new TextEncoder().encode(rawJson));
      const first = trimmed[0]!.timestamp;
      const last = trimmed[trimmed.length - 1]!.timestamp;
      const durationMs = Math.max(0, last - first);
      __traceReplay('recorder.takeFrozen', {
        result: 'ok',
        frames: all.length,
        kept: trimmed.length,
        bytes: bytes.byteLength,
        durationMs,
      });
      return {
        format: 'rrweb',
        bytes,
        durationMs,
        contentType: 'application/octet-stream',
      };
    },

    stop(): void {
      startGeneration += 1; // stand down any import still in flight
      try {
        stopFn?.();
      } catch {
        /* swallow */
      }
      stopFn = null;
      restoreMasks?.();
      restoreMasks = null;
      buffer?.clear();
      buffer = null;
      frozen = false;
      freezeTs = null;
    },

    kill(): void {
      // Codex round-5 finding 2 (P1) — remember what is being taken away, and
      // only on the FIRST kill: a second one finds the buffer already released
      // and would answer "nothing was running", erasing the window the first
      // one closed. A frozen window is deliberately not counted — the report
      // that owned it is over either way, and re-opening a rolling buffer
      // under a FROZEN lifecycle would let post-kill frames into a capture the
      // freeze cutoff no longer bounds.
      if (!killed) killedWhileRecording = buffer !== null && !frozen;
      // See the interface doc: the latch FIRST, because it is what makes every
      // later entry point (start / freeze / handleEmit) inert regardless of
      // what the lifecycle does next. Everything after it is just releasing
      // what is currently held.
      killed = true;
      startGeneration += 1; // stand down any import still in flight
      takeFullSnapshotFn = null;
      try {
        stopFn?.();
      } catch {
        /* swallow — DEFE-02 */
      }
      stopFn = null;
      restoreMasks?.();
      restoreMasks = null;
      buffer?.clear();
      buffer = null;
      frozen = false;
      freezeTs = null;
      __traceReplay('recorder.kill', {});
    },

    revive(): void {
      // Codex round-4 finding 2 (P1) — clears the CONSENT latch. A
      // self-disabled session stays disabled: that latch is a page-performance
      // verdict this recorder reached about itself, and a host remount is no
      // evidence against it.
      if (!killed) return;
      killed = false;
      const resume = killedWhileRecording;
      killedWhileRecording = false;
      __traceReplay('recorder.revive', { selfDisabled, resume });
      // Codex round-5 finding 2 (P1) — and re-opens the window `kill()` closed.
      // Round 4 stopped at the latch, on the reasoning that the next `start()`
      // rebuilds the buffer. Nothing calls one: `kill()` never told the
      // sdk-core lifecycle anything, so it is still in BUFFERING and its
      // `tryStart()` is a guarded no-op outside IDLE. The lifecycle believed it
      // was recording while the recorder held no buffer and no rrweb handle,
      // and the next report froze an absent window and shipped without a
      // replay. `selfDisabled` is re-checked inside `startRecording` (via
      // `inert()`), so a self-disabled page still restarts nothing.
      if (resume) startRecording(durationSec);
    },

    get disabled(): boolean {
      return inert();
    },

    get __size(): number {
      return buffer?.size() ?? 0;
    },

    __diagnostics(): ReplayRecorderDiagnostics {
      const frames = buffer?.frames() ?? [];
      return {
        disabled: inert(),
        frozen,
        freezeTs,
        recording: stopFn !== null,
        canReanchor: takeFullSnapshotFn !== null,
        frames: frames.length,
        bytes: buffer?.byteSize() ?? 0,
        hasAnchor: hasAnchor(frames),
        oldestTs: buffer?.oldestTs() ?? null,
        newestTs: frames.length > 0 ? frames[frames.length - 1]!.timestamp : null,
        overflowResets,
        capBreached: buffer?.capBreached() ?? false,
      };
    },
  };
}
