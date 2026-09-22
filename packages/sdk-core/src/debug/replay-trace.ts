// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Replay flight recorder — a bounded ring of lifecycle/recorder transitions,
// read back off a device to explain why a report shipped without a replay.
// OFF by default and zeroized on disable, so a shipped build pays nothing and
// retains nothing.
//
// Entries carry COUNTS AND STATE NAMES ONLY — never frame contents, URLs, or
// any recorded DOM. Keep it that way: this is readable from a debug build.

/** Ring capacity. A report's worth of transitions is a few dozen entries. */
export const REPLAY_TRACE_MAX = 100;

export interface ReplayTraceEntry {
  /** Date.now() at the moment the event was recorded. */
  t: number;
  ev: string;
  [k: string]: unknown;
}

let enabled = false;
let ring: ReplayTraceEntry[] = [];

/** Arm or disarm the recorder. Disarming zeroizes what was collected. */
export function __enableReplayTrace(on: boolean): void {
  enabled = on;
  if (!on) ring = [];
}

export function __isReplayTraceEnabled(): boolean {
  return enabled;
}

/**
 * Append a transition. No-op while disarmed.
 *
 * Pass a THUNK for any detail that costs something to build — a plain object
 * argument is constructed by the caller before this function can decline it,
 * so an expensive one is paid on every call in a shipped build.
 */
export function __traceReplay(
  ev: string,
  detail?: Record<string, unknown> | (() => Record<string, unknown>),
): void {
  if (!enabled) return;
  const resolved = typeof detail === 'function' ? detail() : detail;
  ring.push({ t: Date.now(), ev, ...resolved });
  if (ring.length > REPLAY_TRACE_MAX) ring.shift();
}

/** Snapshot of the ring, oldest → newest. */
export function __getReplayTrace(): ReplayTraceEntry[] {
  return ring.slice();
}

/** Test seam. */
export function __resetReplayTrace(): void {
  enabled = false;
  ring = [];
}
