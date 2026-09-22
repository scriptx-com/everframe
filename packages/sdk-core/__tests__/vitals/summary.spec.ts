// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
import { describe, expect, it } from 'vitest';
import { SessionSummary } from '@traceitx/protocol';
import { createSummaryAccumulator } from '../../src/vitals/summary.js';

const DIMS = { platform: 'web' as const, appVersion: '1.0.0', sdkVersion: '0.7.0' };
const SID = '3b2e2f9a-1111-4222-8333-944444444444';
const acc = () => createSummaryAccumulator({ sessionId: SID, startedAt: 1000, dims: DIMS });

describe('summary accumulator', () => {
  it('counts rebuffers from buffer_start/buffer_end pairs', () => {
    const a = acc();
    a.onEntry({ kind: 'player', t: 2000, type: 'buffer_start' });
    a.onEntry({ kind: 'player', t: 4500, type: 'buffer_end', data: { durationMs: 2500 } });
    const s = a.snapshot({ final: false, now: 5000 });
    expect(s.rebufferCount).toBe(1);
    expect(s.rebufferDurationMs).toBe(2500);
    expect(s.durationMs).toBe(4000);
  });

  it('takes the FIRST startup ttff and averages bitrates', () => {
    const a = acc();
    a.onEntry({ kind: 'player', t: 1500, type: 'startup', data: { ttffMs: 800 } });
    a.onEntry({ kind: 'player', t: 9000, type: 'startup', data: { ttffMs: 300 } });
    a.onEntry({ kind: 'player', t: 2000, type: 'bitrate_change', data: { bitrate: 4_000_000 } });
    a.onEntry({ kind: 'player', t: 3000, type: 'bitrate_change', data: { bitrate: 6_000_000 } });
    const s = a.snapshot({ final: false, now: 9500 });
    expect(s.startupTimeMs).toBe(800);
    expect(s.bitrateMean).toBe(5_000_000);
  });

  it('accumulates playtime across play/pause spans, open span closed by snapshot', () => {
    const a = acc();
    a.onEntry({ kind: 'player', t: 2000, type: 'play' });
    a.onEntry({ kind: 'player', t: 5000, type: 'pause' });
    a.onEntry({ kind: 'player', t: 6000, type: 'play' });
    expect(a.snapshot({ final: false, now: 8000 }).playtimeMs).toBe(5000);
  });

  it('tracks mem peak/avg from samples and errors from error events', () => {
    const a = acc();
    a.onEntry({ kind: 'sample', t: 2000, mem: 100 });
    a.onEntry({ kind: 'sample', t: 3000, mem: 300 });
    a.onEntry({ kind: 'player', t: 3500, type: 'error', data: { message: 'MEDIA_ERR' } });
    const s = a.snapshot({ final: true, now: 4000 });
    expect(s.memPeak).toBe(300);
    expect(s.memAvg).toBe(200);
    expect(s.errorCount).toBe(1);
    expect(s.final).toBe(true);
  });

  // Fix T3-upgrade (final review): a backwards clock jump — the CLOSING
  // event's `t` earlier than the span's OPEN timestamp — must not produce a
  // negative rebufferDurationMs/playtimeMs. The route's SessionSummary
  // schema requires `.nonnegative()` on both; an unclamped negative would
  // 400 EVERY subsequent summary of the session, not just this one.
  it('clamps rebufferDurationMs/playtimeMs to 0 on a backwards clock jump, and the summary still validates', () => {
    const a = acc();
    // buffer_start at t=5000, buffer_end at t=4000 — BEFORE the open
    // timestamp. No durationMs on the close event, so it's computed from
    // timestamps: a raw `t - openBufferStartT` would be -1000.
    a.onEntry({ kind: 'player', t: 5000, type: 'buffer_start' });
    a.onEntry({ kind: 'player', t: 4000, type: 'buffer_end' });
    // play at t=5000, pause at t=4500 — same backwards-jump shape for the
    // playtime span.
    a.onEntry({ kind: 'player', t: 5000, type: 'play' });
    a.onEntry({ kind: 'player', t: 4500, type: 'pause' });

    const snapshot = a.snapshot({ final: true, now: 6000 });
    expect(snapshot.rebufferDurationMs).toBe(0);
    expect(snapshot.playtimeMs).toBe(0);

    // Pin schema validity, not just the raw numbers — this is the exact
    // check the ingest route runs, and a negative value would 400 here.
    const parsed = SessionSummary.parse(snapshot);
    expect(parsed.rebufferDurationMs).toBe(0);
    expect(parsed.playtimeMs).toBe(0);
  });

  // Codex round-2 finding R8 — round-1's clamp (test above) covered the
  // CLOSED-span accumulation paths (a buffer_end/pause event whose `t` is
  // earlier than the span's open). The OPEN-span closures computed directly
  // INSIDE snapshot() (`adjusted*` locals, from `now - openT`) were still
  // unclamped: a `now` earlier than the still-open buffer_start/play
  // timestamps produces the same negative-duration hazard, just via a
  // different code path (snapshot's own math, not onEntry's).
  it('clamps open-span snapshot math to 0 when now is earlier than the open spans, and the summary still validates', () => {
    const a = acc();
    // Neither span is ever closed — both are still open when snapshot runs.
    a.onEntry({ kind: 'player', t: 5000, type: 'buffer_start' });
    a.onEntry({ kind: 'player', t: 5000, type: 'play' });

    // `now` (4000) is EARLIER than both open timestamps (5000) — a
    // backwards clock relative to the still-open spans.
    const snapshot = a.snapshot({ final: true, now: 4000 });
    expect(snapshot.rebufferDurationMs).toBe(0);
    expect(snapshot.playtimeMs).toBe(0);
    expect(snapshot.rebufferCount).toBe(1); // the open span still counts as one rebuffer

    // Pin schema validity — an unclamped negative would 400 at ingest.
    const parsed = SessionSummary.parse(snapshot);
    expect(parsed.rebufferDurationMs).toBe(0);
    expect(parsed.playtimeMs).toBe(0);
  });

  it('null startup/bitrate when never observed; open rebuffer closed by snapshot now', () => {
    const a = acc();
    a.onEntry({ kind: 'player', t: 2000, type: 'buffer_start' });
    const s = a.snapshot({ final: false, now: 3000 });
    expect(s.startupTimeMs).toBeNull();
    expect(s.bitrateMean).toBeNull();
    expect(s.rebufferCount).toBe(1);
    expect(s.rebufferDurationMs).toBe(1000);
  });

  // Codex round-3 finding F2 — multi-player COUNT-based union semantics.
  // Two attached elements feed the SAME accumulator (one VitalsCollector
  // per session, not per element); a plain boolean/single-open-span design
  // has the FIRST element's pause close a span the SECOND element is still
  // keeping open, undercounting playtime the instant more than one player
  // is ever attached at once.
  describe('multi-player union semantics (Codex round-3 finding F2)', () => {
    it('two interleaved players: playtime keeps accruing after the FIRST pauses, only closes when the LAST does', () => {
      const a = acc();
      a.onEntry({ kind: 'player', t: 1000, type: 'play' }); // player A starts — union span opens
      a.onEntry({ kind: 'player', t: 1500, type: 'play' }); // player B starts — span already open, count 1->2
      a.onEntry({ kind: 'player', t: 3000, type: 'pause' }); // player A stops — B still playing, count 2->1

      // Still accruing: the union span never closed (count is 1, not 0).
      expect(a.snapshot({ final: false, now: 3500 }).playtimeMs).toBe(2500); // 3500 - 1000

      a.onEntry({ kind: 'player', t: 4000, type: 'pause' }); // player B stops — count 1->0, span closes
      const s = a.snapshot({ final: true, now: 4000 });
      expect(s.playtimeMs).toBe(3000); // 4000 - 1000, NOT 1500 (A's span) + 500 (B's span) = 2000
    });

    it('overlapping buffer spans from two players collapse into ONE rebuffer, duration spanning first-open to last-close (union, not sum)', () => {
      const a = acc();
      // Element A buffers 1000->1800 (800ms); element B buffers 1200->2600
      // (1400ms), overlapping A's span. Union: 1000->2600 = 1600ms — deliberately
      // NOT equal to the sum of the two elements' own durations (2200ms), so a
      // regression back to per-element summing would fail this assertion.
      a.onEntry({ kind: 'player', t: 1000, type: 'buffer_start' }); // A opens — union opens, rebuffer #1
      a.onEntry({ kind: 'player', t: 1200, type: 'buffer_start' }); // B opens — union already open, no new rebuffer
      a.onEntry({ kind: 'player', t: 1800, type: 'buffer_end' }); // A recovers — union still open (B open)
      a.onEntry({ kind: 'player', t: 2600, type: 'buffer_end' }); // B recovers — union closes

      const s = a.snapshot({ final: true, now: 3000 });
      expect(s.rebufferCount).toBe(1);
      expect(s.rebufferDurationMs).toBe(1600);
    });

    it('ignores each buffer_end\'s own data.durationMs — a multi-player union always uses the span\'s own open/close transition times', () => {
      const a = acc();
      a.onEntry({ kind: 'player', t: 1000, type: 'buffer_start' });
      a.onEntry({ kind: 'player', t: 1200, type: 'buffer_start' });
      // A hostile/misleading per-element durationMs must not leak into the
      // union's own duration math.
      a.onEntry({ kind: 'player', t: 1800, type: 'buffer_end', data: { durationMs: 1 } });
      a.onEntry({ kind: 'player', t: 2600, type: 'buffer_end', data: { durationMs: 999999 } });

      const s = a.snapshot({ final: true, now: 3000 });
      expect(s.rebufferCount).toBe(1);
      expect(s.rebufferDurationMs).toBe(1600); // 2600 - 1000, ignoring both data.durationMs values
    });

    it('floors playCount/bufferCount at 0 — a stray pause/buffer_end (no matching open) does not go negative or corrupt the next real span', () => {
      const a = acc();
      a.onEntry({ kind: 'player', t: 1000, type: 'pause' }); // stray — no prior play
      a.onEntry({ kind: 'player', t: 1000, type: 'buffer_end' }); // stray — no prior buffer_start
      a.onEntry({ kind: 'player', t: 2000, type: 'play' });
      a.onEntry({ kind: 'player', t: 2500, type: 'pause' });

      const s = a.snapshot({ final: true, now: 3000 });
      expect(s.playtimeMs).toBe(500); // 2500 - 2000, unaffected by the stray pause
      expect(s.rebufferCount).toBe(0);
      expect(s.rebufferDurationMs).toBe(0);
    });
  });
});

describe('phase 4 — playerCount', () => {
  it('counts distinct playerIds across ANY player event, and unnamed events once', () => {
    const a = acc();
    a.onEntry({ kind: 'player', t: 1, type: 'play', playerId: 'p1' });
    a.onEntry({ kind: 'player', t: 2, type: 'player_attach', playerId: 'p2', data: { tag: 'video', library: 'native' } });
    a.onEntry({ kind: 'player', t: 3, type: 'pause', playerId: 'p1' });
    a.onEntry({ kind: 'player', t: 4, type: 'seek' }); // phase-3 style, no id
    a.onEntry({ kind: 'player', t: 5, type: 'seek' });
    a.onEntry({ kind: 'custom', t: 6, name: 'x', playerId: 'p9' }); // custom entries do not count
    expect(a.snapshot({ final: false, now: 10 }).playerCount).toBe(3);
  });
  it('is 0 with no player events, and the summary still validates', () => {
    const s = acc().snapshot({ final: true, now: 10 });
    expect(s.playerCount).toBe(0);
    expect(() => SessionSummary.parse(s)).not.toThrow();
  });

  // Codex round-3 item 4 — distinct-player accounting had no cardinality
  // cap: an infinite-scroll feed (or any pathological churn) spawning one
  // new auto-attached element after another retains every id it has ever
  // seen for the rest of the session, unbounded. `playerCount` must
  // saturate at a fixed ceiling instead of growing forever.
  it('caps distinct playerId cardinality at 1000 instead of growing without bound', () => {
    const a = acc();
    for (let i = 0; i < 5000; i++) {
      a.onEntry({ kind: 'player', t: i, type: 'player_attach', playerId: `p${i}`, data: { tag: 'video', library: 'native' } });
    }
    expect(a.snapshot({ final: false, now: 6000 }).playerCount).toBe(1000);
  });

  // The cap bounds NEW ids only — an id already tracked before the cap was
  // reached must keep behaving exactly as it did before this fix (still
  // counted once, not double-counted, not evicted).
  it('an id already tracked before the cap is reached is unaffected by later cap-refused ids', () => {
    const a = acc();
    a.onEntry({ kind: 'player', t: 1, type: 'play', playerId: 'p1' });
    for (let i = 0; i < 1000; i++) {
      a.onEntry({ kind: 'player', t: i + 2, type: 'player_attach', playerId: `filler${i}`, data: { tag: 'video', library: 'native' } });
    }
    // p1 was already tracked before the cap filled up with the filler ids —
    // a repeat event for it must still be recognised, not silently dropped.
    a.onEntry({ kind: 'player', t: 2000, type: 'pause', playerId: 'p1' });
    expect(a.snapshot({ final: false, now: 3000 }).playerCount).toBe(1000);
  });

  // Codex round-4 finding 4 — `playerCount` silently saturating at 1000
  // with no signal is exactly the bug: a session with 1001 distinct
  // players reports the same "1000" a session with EXACTLY 1000 does.
  // `playerCountSaturated` must distinguish the two.
  describe('playerCountSaturated', () => {
    it('is false when the distinct count never reaches the cap', () => {
      const a = acc();
      for (let i = 0; i < 5; i++) {
        a.onEntry({ kind: 'player', t: i, type: 'play', playerId: `p${i}` });
      }
      const s = a.snapshot({ final: false, now: 10 });
      expect(s.playerCount).toBe(5);
      expect(s.playerCountSaturated).toBe(false);
    });

    it('is false when the distinct count lands EXACTLY on the cap with no further new ids', () => {
      const a = acc();
      for (let i = 0; i < 1000; i++) {
        a.onEntry({ kind: 'player', t: i, type: 'player_attach', playerId: `p${i}`, data: { tag: 'video', library: 'native' } });
      }
      const s = a.snapshot({ final: false, now: 2000 });
      expect(s.playerCount).toBe(1000);
      // Exactly 1000 distinct players, no MORE were ever seen — this is
      // NOT saturation, it is the true count landing on the cap by chance.
      expect(s.playerCountSaturated).toBe(false);
    });

    it('is true once a distinct id beyond the cap is refused', () => {
      const a = acc();
      for (let i = 0; i < 1001; i++) {
        a.onEntry({ kind: 'player', t: i, type: 'player_attach', playerId: `p${i}`, data: { tag: 'video', library: 'native' } });
      }
      const s = a.snapshot({ final: false, now: 2000 });
      expect(s.playerCount).toBe(1000);
      expect(s.playerCountSaturated).toBe(true);
    });

    it('repeat events for already-tracked ids after the cap fills do not spuriously flip saturation on', () => {
      const a = acc();
      for (let i = 0; i < 1000; i++) {
        a.onEntry({ kind: 'player', t: i, type: 'player_attach', playerId: `p${i}`, data: { tag: 'video', library: 'native' } });
      }
      // Repeats of already-tracked ids only — no GENUINELY new id appears.
      for (let i = 0; i < 1000; i++) {
        a.onEntry({ kind: 'player', t: 2000 + i, type: 'pause', playerId: `p${i}` });
      }
      const s = a.snapshot({ final: false, now: 5000 });
      expect(s.playerCount).toBe(1000);
      expect(s.playerCountSaturated).toBe(false);
    });
  });
});
