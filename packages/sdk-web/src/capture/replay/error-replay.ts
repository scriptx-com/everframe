// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Replays on errors (spec 2026-10-11): which errors take a replay, and when the
// wait for it ends.
//
// An error qualifies when, at the moment it is captured:
//   - this page records (lifecycle BUFFERING: replay on and sampled in);
//   - no bug report owns the window (FROZEN: the reporter froze it);
//   - fewer than MAX_ERROR_REPLAYS_PER_PAGE replays were attached or are still
//     exporting in this page session (this module's state: one page load).
//   - the engine has CompressionStream. Without it, gzip falls back to a
//     synchronous fflate pass over up to 4 MB, which an automatic,
//     error-triggered replay must not cost the page (plan ruling, 2026-10-11).
//     User bug reports keep that fallback.
// A hidden tab (recording paused) or nothing playable resolves `none` from the
// recorder's own snapshot. Only the crash sink calls this: every web error
// it sees is reported while the page still runs.
//
// The snapshot is non-destructive (recorder.ts `snapshot()`). The wait ends
// after ERROR_REPLAY_DEADLINE_MS whatever the export does: an export that
// misses it, or exceeds REPLAY_BYTE_CAP, is `omitted` and the error ships
// flagged `replayOmitted`, as bug reports do.
import { __traceReplay, type ReplayCapture, type ReplayState } from '@everframe/sdk-core';
import { REPLAY_BYTE_CAP } from '../../transport/draft-to-envelope.js';

export const MAX_ERROR_REPLAYS_PER_PAGE = 2;
export const ERROR_REPLAY_DEADLINE_MS = 3_000;

export type ErrorReplayOutcome =
  | { kind: 'attach'; capture: ReplayCapture }
  | { kind: 'omitted'; reason: 'deadline' | 'over_cap' }
  | { kind: 'none' };

export interface ErrorReplayDeps {
  /** The live replay lifecycle state; null when replay is not wired. */
  lifecycleState: () => ReplayState | null;
  /** The recorder's snapshot. Undefined for host-rendered replay, which has none. */
  snapshot: (() => Promise<ReplayCapture | null>) | undefined;
  /** Injectable deadline timer (tests). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Slots taken this page session: replays attached, plus exports still running. */
let pageBudget = { slotsTaken: 0 };

/**
 * Take a replay for an error being captured right now. SYNCHRONOUS up to the
 * snapshot's copy, so call it inside the crash sink, before anything awaits.
 * Null when the error does not qualify (no slot taken). Otherwise a promise
 * that always resolves, within ERROR_REPLAY_DEADLINE_MS.
 */
export function beginErrorReplay(deps: ErrorReplayDeps): Promise<ErrorReplayOutcome> | null {
  if (deps.snapshot === undefined) return null;
  // A bare `typeof`, never `globalThis.…` (a ReferenceError on Chrome < 71 TVs).
  // Checked before any snapshot or slot: the error simply ships without a replay.
  if (typeof CompressionStream !== 'function') {
    __traceReplay('errorReplay.skipped', { reason: 'no_compression_stream' });
    return null;
  }
  if (deps.lifecycleState() !== 'BUFFERING') {
    __traceReplay('errorReplay.skipped', { reason: 'not_buffering' });
    return null;
  }
  const budget = pageBudget;
  if (budget.slotsTaken >= MAX_ERROR_REPLAYS_PER_PAGE) {
    __traceReplay('errorReplay.skipped', { reason: 'page_cap' });
    return null;
  }
  let exported: Promise<ReplayCapture | null>;
  try {
    exported = deps.snapshot();
  } catch {
    return null;
  }
  budget.slotsTaken += 1;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const clearTimer =
    deps.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));
  return new Promise<ErrorReplayOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: ErrorReplayOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      __traceReplay(
        'errorReplay.settled',
        outcome.kind === 'omitted' ? { kind: outcome.kind, reason: outcome.reason } : { kind: outcome.kind },
      );
      resolve(outcome);
    };
    const exportedOutcome = (outcome: ErrorReplayOutcome): void => {
      // A deadline releases the error, but cannot cancel snapshot/gzip work.
      // Keep that work in the concurrency budget until it actually settles.
      // Late results are discarded; only an on-time attachment keeps its slot.
      if (settled || outcome.kind !== 'attach') budget.slotsTaken -= 1;
      finish(outcome);
    };
    const timer = setTimer(() => finish({ kind: 'omitted', reason: 'deadline' }), ERROR_REPLAY_DEADLINE_MS);
    exported.then(
      (capture) => {
        if (capture === null || capture.bytes.byteLength === 0) exportedOutcome({ kind: 'none' });
        else if (capture.bytes.byteLength > REPLAY_BYTE_CAP) exportedOutcome({ kind: 'omitted', reason: 'over_cap' });
        else exportedOutcome({ kind: 'attach', capture });
      },
      () => exportedOutcome({ kind: 'none' }),
    );
  });
}

/** Test seam: a fresh page session. */
export function __resetErrorReplayBudgetForTesting(): void {
  pageBudget = { slotsTaken: 0 };
}
