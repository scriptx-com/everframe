// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Replay flight recorder — the diagnostic ring the lifecycle and the platform
// recorder write transitions into. OFF by default: a shipped build must pay
// nothing for it and retain nothing.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  __enableReplayTrace,
  __getReplayTrace,
  __resetReplayTrace,
  __traceReplay,
  REPLAY_TRACE_MAX,
} from '../../src/debug/replay-trace.js';

describe('replay trace ring', () => {
  beforeEach(() => {
    __resetReplayTrace();
  });

  it('records nothing while disabled', () => {
    __traceReplay('freeze', { from: 'BUFFERING' });
    expect(__getReplayTrace()).toEqual([]);
  });

  it('records event name and detail once enabled', () => {
    __enableReplayTrace(true);
    __traceReplay('freeze', { from: 'BUFFERING', frames: 12 });
    const [entry] = __getReplayTrace();
    expect(entry).toMatchObject({ ev: 'freeze', from: 'BUFFERING', frames: 12 });
  });

  it('stamps each entry with a wall-clock time', () => {
    __enableReplayTrace(true);
    __traceReplay('freeze');
    expect(typeof __getReplayTrace()[0]!.t).toBe('number');
  });

  it('drops the oldest entry past the ring cap', () => {
    __enableReplayTrace(true);
    for (let i = 0; i < REPLAY_TRACE_MAX + 5; i++) __traceReplay('tick', { i });
    const entries = __getReplayTrace();
    expect(entries).toHaveLength(REPLAY_TRACE_MAX);
    expect(entries[0]).toMatchObject({ i: 5 });
  });

  it('stops recording and zeroizes when disabled again', () => {
    __enableReplayTrace(true);
    __traceReplay('freeze');
    __enableReplayTrace(false);
    expect(__getReplayTrace()).toEqual([]);
    __traceReplay('freeze');
    expect(__getReplayTrace()).toEqual([]);
  });

  // Detail objects are built by the CALLER before the ring sees them, so an
  // expensive detail (a full replay-buffer copy on freeze, an unbounded Zod
  // issue map) was paid on every production report with tracing off. Callers
  // pass a thunk; the ring only calls it when armed.
  it('does not evaluate a detail thunk while disabled', () => {
    let built = 0;
    __traceReplay('freeze', () => {
      built += 1;
      return { frames: 999 };
    });
    expect(built).toBe(0);
  });

  it('evaluates a detail thunk once when armed', () => {
    __enableReplayTrace(true);
    let built = 0;
    __traceReplay('freeze', () => {
      built += 1;
      return { frames: 999 };
    });
    expect(built).toBe(1);
  });

  it('records the thunk result as the entry detail', () => {
    __enableReplayTrace(true);
    __traceReplay('freeze', () => ({ frames: 999 }));
    expect(__getReplayTrace()[0]).toMatchObject({ ev: 'freeze', frames: 999 });
  });

  it('returns a copy so a reader cannot mutate the ring', () => {
    __enableReplayTrace(true);
    __traceReplay('freeze');
    __getReplayTrace().push({ t: 0, ev: 'forged' });
    expect(__getReplayTrace()).toHaveLength(1);
  });
});
