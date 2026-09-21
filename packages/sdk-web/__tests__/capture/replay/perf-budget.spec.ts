// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// PHASE-GATE PERF BENCHMARK — owns the self-disable + buffer-cap proof.
// Turned RED→GREEN in plan 20-04.
//
// Contract (RESEARCH §"Open Item 2", §"Validation Architecture"):
//   Against a hostile fixture (virtualized 10k-row list + rAF + canvas spam) the
//   replay must NOT jank the host. This benchmark proves, deterministically:
//     (a) the heavy-DOM SELF-DISABLE fires when per-checkout serialization
//         exceeds 150 ms — the session disables (no further events buffered) with
//         the diagnostic flag set;
//     (b) the BUFFER CAP fires at 4 MB uncompressed OR 6000 events, pruning by
//         time AND bytes and never retaining past the anchoring full snapshot.
//   The thresholds are FORCED (fake serialization clock / injected heavy DOM) so
//   the gate is stable and not wall-clock-flaky.
import { describe, it, expect } from 'vitest';
import { createReplayRecorder, MAX_OVERFLOW_RESETS } from '../../../src/capture/replay/recorder.js';
import {
  createRollingBuffer,
  MAX_BUFFER_BYTES,
  MAX_BUFFER_EVENTS,
} from '../../../src/capture/replay/buffer.js';

const FULL = 2;
const INCR = 3;

/** A hostile fixture row — a fat serialized subtree (virtualized 10k-row list). */
function hostileRow(i: number) {
  return {
    type: 2,
    tagName: 'div',
    attributes: { class: `row-${i}` },
    childNodes: Array.from({ length: 8 }, (_, j) => ({
      type: 3,
      textContent: `row ${i} cell ${j} ${'x'.repeat(40)}`,
      id: i * 100 + j,
    })),
    id: i,
  };
}

describe('phase-gate perf benchmark — self-disable + buffer cap', () => {
  it('(a) survives the normal checkout cadence — periodic checkouts must NEVER self-disable', async () => {
    // Field bug 2026-08-27: the old "per-checkout serialization" heuristic
    // measured the gap between the PREVIOUS emit and the checkout emit. With
    // checkoutEveryNms = 15s by design, the second checkout always measured
    // ~15,000 ms > 150 ms and self-disabled — on every platform, every
    // session, ~15s after start. There is no start-of-serialization signal
    // available inside rrweb's emit, so the heuristic is gone; buffer caps
    // (b1–b3 below) own the hostile-page protection.
    let clock = 0;
    let emit: ((e: unknown, isCheckout?: boolean) => void) | undefined;
    const rec = createReplayRecorder({
      importRrweb: async () => ({
        record: (o: Record<string, unknown>) => {
          emit = o['emit'] as typeof emit;
          return () => undefined;
        },
      }),
      now: () => clock,
    });
    rec.start(30);
    await Promise.resolve();
    await Promise.resolve();
    // Three checkouts on the real 15s cadence, idle stretches in between —
    // exactly what a TV left on the home screen produces.
    for (const t of [0, 15_000, 30_000]) {
      clock = t;
      emit!({ type: FULL, timestamp: t, data: { node: hostileRow(t) } }, true);
      expect(rec.disabled).toBe(false);
    }
    expect(rec.__size).toBeGreaterThan(0);
  });

  it('(b1) buffer cap fires at 6000 events', () => {
    const buf = createRollingBuffer({ durationSec: 30 });
    buf.push({ type: FULL, timestamp: 0, data: {} }, true);
    for (let i = 1; i <= MAX_BUFFER_EVENTS + 5 && !buf.capBreached(); i++) {
      buf.push({ type: INCR, timestamp: i, data: {} });
    }
    expect(buf.capBreached()).toBe(true);
    expect(buf.size()).toBeGreaterThan(MAX_BUFFER_EVENTS);
    expect(MAX_BUFFER_EVENTS).toBe(6000);
  });

  it('(b2) buffer cap fires at 4 MB uncompressed (hostile 10k-row spam)', () => {
    const buf = createRollingBuffer({ durationSec: 30 });
    buf.push({ type: FULL, timestamp: 0, data: {} }, true);
    let i = 1;
    // Spam hostile rows until the 4 MB byte cap trips (well under 6000 events).
    while (!buf.capBreached() && i < MAX_BUFFER_EVENTS) {
      buf.push({ type: INCR, timestamp: i, data: { node: hostileRow(i) } });
      i++;
    }
    expect(buf.capBreached()).toBe(true);
    expect(buf.byteSize()).toBeGreaterThan(MAX_BUFFER_BYTES);
    expect(MAX_BUFFER_BYTES).toBe(4 * 1024 * 1024);
  });

  it('(b3) the recorder self-disables on a buffer-cap breach (rAF/canvas spam)', async () => {
    let emit: ((e: unknown, isCheckout?: boolean) => void) | undefined;
    const rec = createReplayRecorder({
      importRrweb: async () => ({
        record: (o: Record<string, unknown>) => {
          emit = o['emit'] as typeof emit;
          return () => undefined;
        },
      }),
      now: () => 0,
    });
    rec.start(30);
    await Promise.resolve();
    await Promise.resolve();
    emit!({ type: FULL, timestamp: 0, data: {} }, true);
    // rAF + canvas spam — fat incrementals until the cap trips. The recorder's
    // own buffer uses the real 4 MB cap; spam big payloads to breach it fast.
    let n = 1;
    while (!rec.disabled && n < MAX_BUFFER_EVENTS) {
      emit!({ type: INCR, timestamp: n, data: { blob: 'x'.repeat(2048), node: hostileRow(n) } });
      n++;
    }
    expect(rec.disabled).toBe(true);
    // 60s, not the 10s default. This case deliberately drives the REAL 4 MB
    // cap (see the comment above) rather than a shrunken test cap, so filling
    // it is thousands of iterations of genuine serialisation work — the assert
    // is about self-disabling behaviour, and the runtime is incidental to it.
    // At the default it passed standalone and timed out inside `pnpm test`,
    // where 19 packages compete for the same cores: a load-dependent verdict
    // on a load-independent claim. The generous ceiling keeps the test honest
    // about what it checks; it is not a perf budget in disguise.
  }, 60_000);

  it('(b4) recovers from a cap breach by re-anchoring when rrweb exposes takeFullSnapshot', async () => {
    // Field bug 2026-08-27 (R6): a burst of screen navigations can overflow a
    // single checkout window on a TV. Permanent self-disable threw the whole
    // session away; with takeFullSnapshot available the recorder clears the
    // buffer and re-anchors instead — replay survives with a shorter window.
    let emit: ((e: unknown, isCheckout?: boolean) => void) | undefined;
    let snapshots = 0;
    const record = (o: Record<string, unknown>) => {
      emit = o['emit'] as typeof emit;
      return () => undefined;
    };
    record.takeFullSnapshot = (isCheckout?: boolean) => {
      snapshots += 1;
      emit!({ type: FULL, timestamp: 100_000 + snapshots, data: {} }, isCheckout);
    };
    const rec = createReplayRecorder({ importRrweb: async () => ({ record }), now: () => 0 });
    rec.start(30);
    await Promise.resolve();
    await Promise.resolve();
    emit!({ type: FULL, timestamp: 0, data: {} }, true);
    // Overflow one window fast: 5 x ~1 MB incrementals breach the 4 MB cap.
    for (let i = 1; i <= 5; i++) {
      emit!({ type: INCR, timestamp: i, data: { blob: 'x'.repeat(1_000_000) } });
    }
    expect(rec.disabled).toBe(false);
    expect(snapshots).toBeGreaterThanOrEqual(1);
    // The buffer was re-anchored: retained events start at the fresh snapshot.
    expect(rec.__size).toBeGreaterThan(0);
  });

  it('(b4b) self-disables when the recovery snapshot itself breaches the cap', async () => {
    // Codex round-1 finding 3: the re-anchor guard suppressed the nested
    // emit's breach handling and never re-checked afterwards — the recorder
    // stayed enabled holding an oversized buffer.
    let emit: ((e: unknown, isCheckout?: boolean) => void) | undefined;
    const record = (o: Record<string, unknown>) => {
      emit = o['emit'] as typeof emit;
      return () => undefined;
    };
    record.takeFullSnapshot = (isCheckout?: boolean) => {
      // A pathological page whose FULL SNAPSHOT alone exceeds the 4 MB cap.
      emit!({ type: FULL, timestamp: 999, data: { blob: 'x'.repeat(5_000_000) } }, isCheckout);
    };
    const rec = createReplayRecorder({ importRrweb: async () => ({ record }), now: () => 0 });
    rec.start(30);
    await Promise.resolve();
    await Promise.resolve();
    emit!({ type: FULL, timestamp: 0, data: {} }, true);
    for (let i = 1; i <= 5; i++) {
      emit!({ type: INCR, timestamp: i, data: { blob: 'x'.repeat(1_000_000) } });
    }
    expect(rec.disabled).toBe(true);
  });

  it('(b5) self-disables once the overflow-reset budget is exhausted (churn guard)', async () => {
    let emit: ((e: unknown, isCheckout?: boolean) => void) | undefined;
    const record = (o: Record<string, unknown>) => {
      emit = o['emit'] as typeof emit;
      return () => undefined;
    };
    record.takeFullSnapshot = (isCheckout?: boolean) => {
      emit!({ type: FULL, timestamp: 0, data: {} }, isCheckout);
    };
    const rec = createReplayRecorder({ importRrweb: async () => ({ record }), now: () => 0 });
    rec.start(30);
    await Promise.resolve();
    await Promise.resolve();
    emit!({ type: FULL, timestamp: 0, data: {} }, true);
    // Hostile page: every reset immediately overflows again. The budget
    // (MAX_OVERFLOW_RESETS) must eventually stop the churn.
    let i = 0;
    while (!rec.disabled && i < (MAX_OVERFLOW_RESETS + 2) * 6) {
      emit!({ type: INCR, timestamp: ++i, data: { blob: 'x'.repeat(1_000_000) } });
    }
    expect(rec.disabled).toBe(true);
  }, 60_000);

  it('pruning never retains past the anchoring full snapshot (main-thread budget holds)', () => {
    const buf = createRollingBuffer({ durationSec: 10 });
    buf.push({ type: FULL, timestamp: 0, data: {} }, true);
    for (let i = 1; i <= 5; i++) buf.push({ type: INCR, timestamp: i * 1000, data: {} });
    buf.push({ type: FULL, timestamp: 6000, data: {} }, true);
    for (let i = 7; i <= 20; i++) buf.push({ type: INCR, timestamp: i * 1000, data: {} });
    buf.rotate(20_000); // window [10_000, 20_000]
    // An anchoring full snapshot is always retained ahead of the oldest kept frame.
    expect(buf.frames().some((f) => f.type === FULL)).toBe(true);
    expect(buf.frames()[0]!.type).toBe(FULL);
  });
});
