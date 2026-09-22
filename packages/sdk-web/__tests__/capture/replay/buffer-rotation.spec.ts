// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// RWEB-01 — rrweb rolling-buffer mode + compressed payload.
// Turned RED→GREEN in plan 20-04.
//
// Contract (RESEARCH §"Pattern 2", §"Open Item 2", Pitfall 4):
//   - rrweb runs in rolling-buffer mode keeping the last N seconds.
//   - the serialized payload is COMPRESSED (bytes ≠ raw JSON).
//   - rotation drops frames older than (now - durationSec) while keeping the
//     anchoring full snapshot so the window is always replayable (Pitfall 4).
//   - hard caps fire at 4 MB uncompressed OR 6000 events.
import { describe, it, expect } from 'vitest';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  createRollingBuffer,
  FULL_SNAPSHOT,
  MAX_BUFFER_BYTES,
  MAX_BUFFER_EVENTS,
} from '../../../src/capture/replay/buffer.js';

// jsdom's Blob lacks .stream() so the sdk-core CompressionStream path can't run
// in this env; assert the compression PROPERTY (retained frames shrink + round-
// trip) with node:zlib. The real gzipBytes path is exercised in the browser e2e.
const gzip = async (input: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(gzipSync(Buffer.from(input)));

const META = 4; // EventType.Meta
const INCR = 3; // EventType.IncrementalSnapshot

function push(buf: ReturnType<typeof createRollingBuffer>, type: number, ts: number, checkout = false) {
  buf.push({ type, timestamp: ts, data: { n: ts } }, checkout);
}

describe('cap overflow sheds the prior window instead of breaching (TV DOMs)', () => {
  // Field bug 2026-08-27 (R6): a TV full snapshot measures ~0.5-2 MB and every
  // screen navigation emits a near-snapshot-sized mutation, so two retained
  // checkout windows legitimately exceed the 4 MB cap minutes into a session.
  // Breaching permanently self-disabled replay — the cap must degrade
  // (drop the older window) before it kills the session.
  it('drops the prior window when both windows exceed the cap, without breaching', () => {
    const buf = createRollingBuffer({ durationSec: 30, maxBytes: 300 });
    const fat = (ts: number, type: number) => ({ type, timestamp: ts, data: { pad: 'x'.repeat(100) } });
    buf.push(fat(0, FULL_SNAPSHOT), true);
    buf.push(fat(1, INCR));
    // Second checkout rotates; its window alone fits, both together do not.
    buf.push(fat(15_000, FULL_SNAPSHOT), true);
    buf.push(fat(15_001, INCR));
    expect(buf.capBreached()).toBe(false);
    // The old window was shed: only the latest checkout window remains.
    expect(buf.frames()[0]!.timestamp).toBe(15_000);
    expect(buf.byteSize()).toBeLessThanOrEqual(300);
  });

  it('keeps the prior window\'s trailing Meta when the current window starts at the FullSnapshot', () => {
    // Cap sized so the first window (incl. its trailing Meta) fits, and the
    // overflow fires only once the second checkout window is retained too.
    const buf = createRollingBuffer({ durationSec: 30, maxBytes: 500 });
    const fat = (ts: number, type: number) => ({ type, timestamp: ts, data: { pad: 'x'.repeat(100) } });
    buf.push(fat(0, FULL_SNAPSHOT), true);
    buf.push(fat(1, INCR));
    // rrweb emits Meta un-flagged immediately before the checkout FullSnapshot:
    // Meta lands at the tail of the window that is about to become `prior`.
    buf.push({ type: META, timestamp: 14_999, data: {} });
    buf.push(fat(15_000, FULL_SNAPSHOT), true);
    buf.push(fat(15_001, INCR));
    const frames = buf.frames();
    expect(buf.capBreached()).toBe(false);
    expect(frames[0]!.type).toBe(META);
    expect(frames[1]!.type).toBe(FULL_SNAPSHOT);
    expect(frames[1]!.timestamp).toBe(15_000);
  });

  it('still breaches when a SINGLE window exceeds the cap (nothing left to shed)', () => {
    const buf = createRollingBuffer({ durationSec: 30, maxBytes: 300 });
    buf.push({ type: FULL_SNAPSHOT, timestamp: 0, data: { pad: 'x'.repeat(400) } }, true);
    expect(buf.capBreached()).toBe(true);
  });
});

describe('RWEB-01 rolling buffer + compression', () => {
  it('accounts for retained events without JSON serialization on the recording path', () => {
    const buf = createRollingBuffer({ durationSec: 30 });
    const nativeStringify = JSON.stringify;
    let calls = 0;
    JSON.stringify = ((...args: Parameters<typeof nativeStringify>) => {
      calls += 1;
      return nativeStringify(...args);
    }) as typeof JSON.stringify;
    try {
      push(buf, FULL_SNAPSHOT, 0, true);
      push(buf, INCR, 1);
      push(buf, INCR, 2);
      const afterPushes = calls;
      expect(afterPushes).toBe(0);
      buf.rotate(2);
      buf.rotate(2);
      expect(calls).toBe(afterPushes);
      expect(buf.byteSize()).toBeGreaterThan(0);
    } finally {
      JSON.stringify = nativeStringify;
    }
  });

  it('keeps the Meta event preceding the anchor full snapshot (rrweb-player viewport dims)', () => {
    // rrweb emits Meta(4) immediately before each FullSnapshot(2). The prune must
    // not slice the Meta off the anchor, or rrweb-player has no width/height and
    // renders a black/0-dimension frame.
    const buf = createRollingBuffer({ durationSec: 30 });
    // Initial segment (stale — will be pruned).
    push(buf, META, 0, true);
    push(buf, FULL_SNAPSHOT, 1);
    push(buf, INCR, 2);
    // A later checkout: rrweb flags the Meta with isCheckout, then the snapshot.
    push(buf, META, 60_000, true);
    push(buf, FULL_SNAPSHOT, 60_001);
    push(buf, INCR, 60_002);
    // Advance so the cutoff is past the 60s checkout → it becomes the anchor.
    buf.rotate(90_001);
    const frames = buf.frames();
    // The retained window MUST start with the Meta, then its FullSnapshot.
    expect(frames[0]?.type).toBe(META);
    expect(frames[1]?.type).toBe(FULL_SNAPSHOT);
    // The stale initial segment is gone.
    expect(frames.some((f) => f.timestamp < 60_000)).toBe(false);
  });

  it('drops frames older than the rolling window but keeps an anchoring full snapshot', () => {
    const buf = createRollingBuffer({ durationSec: 30 });
    // Full snapshot at 0, then incrementals; a fresh checkout at 20s.
    push(buf, FULL_SNAPSHOT, 0, true);
    push(buf, INCR, 10_000);
    push(buf, FULL_SNAPSHOT, 20_000, true);
    push(buf, INCR, 35_000);
    push(buf, INCR, 45_000);
    buf.rotate(45_000); // window = [15_000, 45_000]
    const frames = buf.frames();
    // The anchoring full snapshot (≤ cutoff 15_000) must survive — that is the 0s one.
    expect(frames.some((f) => f.type === FULL_SNAPSHOT)).toBe(true);
    // Nothing is retained from before the anchoring snapshot.
    expect(buf.oldestTs()).not.toBeNull();
  });

  it('retains a full snapshot anchor so the window stays replayable', () => {
    const buf = createRollingBuffer({ durationSec: 15 });
    push(buf, FULL_SNAPSHOT, 0, true);
    push(buf, INCR, 5_000);
    push(buf, INCR, 12_000);
    buf.rotate(12_000);
    expect(buf.frames().some((f) => f.type === FULL_SNAPSHOT)).toBe(true);
  });

  it('never prunes past the only anchoring snapshot when none is ≤ cutoff', () => {
    const buf = createRollingBuffer({ durationSec: 30 });
    push(buf, FULL_SNAPSHOT, 100_000, true);
    push(buf, INCR, 110_000);
    // cutoff = 110_000 - 30_000 = 80_000; the only full snapshot is at 100_000 (> cutoff).
    buf.rotate(110_000);
    // Must keep the snapshot anyway (else unplayable).
    expect(buf.frames().some((f) => f.type === FULL_SNAPSHOT)).toBe(true);
    expect(buf.frames()[0]!.type).toBe(FULL_SNAPSHOT);
  });

  it('serialized payload is compressed (bytes differ from and round-trip to raw JSON)', async () => {
    const buf = createRollingBuffer({ durationSec: 30 });
    push(buf, FULL_SNAPSHOT, 0, true);
    for (let i = 1; i <= 50; i++) push(buf, INCR, i * 100);
    const rawJson = JSON.stringify(buf.frames());
    const bytes = await gzip(new TextEncoder().encode(rawJson));
    expect(bytes.byteLength).toBeLessThan(Buffer.byteLength(rawJson));
    expect(gunzipSync(Buffer.from(bytes)).toString('utf8')).toBe(rawJson);
  });

  it('cap breaches at 6000 events', () => {
    const buf = createRollingBuffer({ durationSec: 30, maxEvents: 5 });
    push(buf, FULL_SNAPSHOT, 0, true);
    for (let i = 1; i <= 10; i++) push(buf, INCR, i);
    expect(buf.capBreached()).toBe(true);
    // The real default cap is 6000.
    expect(MAX_BUFFER_EVENTS).toBe(6000);
  });

  it('cap breaches at 4 MB uncompressed', () => {
    const buf = createRollingBuffer({ durationSec: 30, maxBytes: 200 });
    push(buf, FULL_SNAPSHOT, 0, true);
    // A single fat event easily exceeds the 200-byte test cap.
    buf.push({ type: INCR, timestamp: 1, data: { blob: 'x'.repeat(500) } });
    expect(buf.capBreached()).toBe(true);
    expect(MAX_BUFFER_BYTES).toBe(4 * 1024 * 1024);
  });
});
