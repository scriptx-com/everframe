// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Replays on errors (spec 2026-10-11, "Which errors get a replay"): which
// errors take one, the per-page cap, the size limit and the 3-second deadline.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReplayCapture, ReplayState } from '@everframe/sdk-core';
import {
  beginErrorReplay,
  ERROR_REPLAY_DEADLINE_MS,
  MAX_ERROR_REPLAYS_PER_PAGE,
  __resetErrorReplayBudgetForTesting,
} from '../../../src/capture/replay/error-replay.js';
import { REPLAY_BYTE_CAP } from '../../../src/transport/draft-to-envelope.js';

const capture = (byteLength = 3): ReplayCapture => ({
  format: 'rrweb',
  bytes: new Uint8Array(byteLength),
  durationMs: 1_000,
  contentType: 'application/octet-stream',
});

/** A controllable deadline timer. */
function clock() {
  const armed: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  return {
    armed,
    setTimer: (fn: () => void, ms: number): unknown => {
      const timer = { fn, ms, cleared: false };
      armed.push(timer);
      return timer;
    },
    clearTimer: (handle: unknown): void => {
      (handle as { cleared: boolean }).cleared = true;
    },
    expire: (): void => {
      for (const timer of armed) if (!timer.cleared) timer.fn();
    },
  };
}

function begin(
  snapshot: (() => Promise<ReplayCapture | null>) | undefined,
  state: ReplayState | null = 'BUFFERING',
  timers = clock(),
) {
  return beginErrorReplay({
    lifecycleState: () => state,
    snapshot,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
}

afterEach(() => {
  __resetErrorReplayBudgetForTesting();
  vi.unstubAllGlobals();
});

describe('which errors get a replay', () => {
  it('takes no replay and uses no slot on an engine without CompressionStream (no synchronous gzip)', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    const snapshot = vi.fn(async () => capture());
    expect(begin(snapshot)).toBeNull();
    expect(snapshot).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    // CompressionStream back (Node's): both slots are still free.
    expect(typeof CompressionStream).toBe('function');
    await expect(begin(async () => capture())).resolves.toMatchObject({ kind: 'attach' });
    await expect(begin(async () => capture())).resolves.toMatchObject({ kind: 'attach' });
    expect(begin(async () => capture())).toBeNull();
  });

  it('attaches the snapshot of a recording page and disarms the deadline', async () => {
    const timers = clock();
    const replay = capture();
    const outcome = begin(async () => replay, 'BUFFERING', timers);
    expect(timers.armed[0]?.ms).toBe(ERROR_REPLAY_DEADLINE_MS);
    await expect(outcome).resolves.toEqual({ kind: 'attach', capture: replay });
    expect(timers.armed[0]?.cleared).toBe(true);
  });

  it.each<ReplayState | null>(['IDLE', 'FROZEN', null])('takes no snapshot when the lifecycle is %s', (state) => {
    const snapshot = vi.fn(async () => capture());
    expect(begin(snapshot, state)).toBeNull();
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('takes none without a recorder that can snapshot (host-rendered replay)', () => {
    expect(begin(undefined)).toBeNull();
  });

  it('sends at most 2 per page session', async () => {
    expect(MAX_ERROR_REPLAYS_PER_PAGE).toBe(2);
    await begin(async () => capture());
    await begin(async () => capture());
    const third = vi.fn(async () => capture());
    expect(begin(third)).toBeNull();
    expect(third).not.toHaveBeenCalled();
  });

  it('counts exports still running against the cap', () => {
    const never = () => new Promise<ReplayCapture | null>(() => undefined);
    expect(begin(never)).not.toBeNull();
    expect(begin(never)).not.toBeNull();
    expect(begin(never)).toBeNull();
  });

  it('keeps timed-out exports in the concurrency budget until they actually settle', async () => {
    const timers = clock();
    const finishes: Array<(value: ReplayCapture | null) => void> = [];
    const snapshot = vi.fn(() => new Promise<ReplayCapture | null>((resolve) => finishes.push(resolve)));
    const first = begin(snapshot, 'BUFFERING', timers);
    const second = begin(snapshot, 'BUFFERING', timers);
    timers.expire();
    await expect(first).resolves.toEqual({ kind: 'omitted', reason: 'deadline' });
    await expect(second).resolves.toEqual({ kind: 'omitted', reason: 'deadline' });
    for (let i = 0; i < 20; i++) expect(begin(snapshot)).toBeNull();
    expect(snapshot).toHaveBeenCalledTimes(2);
    finishes[0]!(capture());
    await Promise.resolve();
    await expect(begin(async () => capture())).resolves.toMatchObject({ kind: 'attach' });
    expect(begin(snapshot)).toBeNull();
    finishes[1]!(null);
    await Promise.resolve();
    await expect(begin(async () => capture())).resolves.toMatchObject({ kind: 'attach' });
    expect(begin(snapshot)).toBeNull();
  });

  it('gives the slot back when there was nothing to send', async () => {
    await expect(begin(async () => null)).resolves.toEqual({ kind: 'none' });
    await expect(begin(async () => {
      throw new Error('gzip failed');
    })).resolves.toEqual({ kind: 'none' });
    await begin(async () => capture());
    await begin(async () => capture());
    expect(begin(async () => capture())).toBeNull();
  });

  it('omits a replay over the 8,000,000-byte limit and gives the slot back', async () => {
    await expect(begin(async () => capture(REPLAY_BYTE_CAP + 1))).resolves.toEqual({ kind: 'omitted', reason: 'over_cap' });
    await expect(begin(async () => capture(REPLAY_BYTE_CAP))).resolves.toMatchObject({ kind: 'attach' });
  });

  it('omits the replay at the 3-second deadline and ignores a late export', async () => {
    const timers = clock();
    let finish!: (value: ReplayCapture) => void;
    const outcome = begin(
      () => new Promise<ReplayCapture | null>((resolve) => {
        finish = resolve;
      }),
      'BUFFERING',
      timers,
    );
    timers.expire();
    await expect(outcome).resolves.toEqual({ kind: 'omitted', reason: 'deadline' });
    finish(capture());
    await Promise.resolve();
    // The slot came back: two more replays still fit.
    await begin(async () => capture());
    await begin(async () => capture());
    expect(begin(async () => capture())).toBeNull();
  });

  it('takes no slot when the snapshot throws synchronously', async () => {
    expect(begin(() => {
      throw new Error('boom');
    })).toBeNull();
    await begin(async () => capture());
    await begin(async () => capture());
    expect(begin(async () => capture())).toBeNull();
  });
});
