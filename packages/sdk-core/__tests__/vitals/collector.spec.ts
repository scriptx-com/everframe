// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_PLAYER_EVENT_DATA_BYTES, utf8ByteLength } from '@everframe/protocol';
import { createVitalsCollector } from '../../src/vitals/collector.js';
import { IdentityTokenHolder } from '../../src/reporter/identity-token.js';

const DIMS = { platform: 'web' as const, appVersion: '1', sdkVersion: '1' };

function make(over: Record<string, unknown> = {}) {
  const sent: Array<{ body: any; beacon: boolean; token: string | undefined }> = [];
  let clock = 1_000_000;
  let n = 0;
  vi.useFakeTimers();
  const c = createVitalsCollector({
    dims: DIMS,
    now: () => clock,
    newSessionId: () => `00000000-0000-4000-8000-00000000000${n++}`,
    send: (body, opts) => sent.push({ body, beacon: opts.beacon, token: opts.identityToken }),
    ...over,
  });
  return { c, sent, tick: (ms: number) => { clock += ms; vi.advanceTimersByTime(ms); } };
}

/**
 * A decodable (never verifiable — the SDK holds no secret) JWT with the given
 * `exp`, for driving the real `IdentityTokenHolder` below.
 */
function jwtExpiringAt(expSec: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(expSec) })}.sig`;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createVitalsCollector', () => {
  // 1. Initial non-final summary on creation.
  it('sends an initial non-final summary on creation', () => {
    const { sent } = make();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.kind).toBe('summary');
    expect(sent[0]!.body.final).toBe(false);
  });

  // 2a. Chunk flushed at 50 entries, without waiting for the timer; seq starts at 0.
  it('flushes a chunk at 50 entries without waiting for the timer', () => {
    const { c, sent } = make();
    for (let i = 0; i < 50; i++) c.recordPlayerEvent({ t: 1_000_000 + i, type: 'play' });
    const chunk = sent.find((s) => s.body.kind === 'chunk');
    expect(chunk?.body.entries).toHaveLength(50);
    expect(chunk?.body.seq).toBe(0);
  });

  // 2b. Chunk flushed on the 30s interval when the buffer is non-empty; seq increments.
  it('flushes a non-empty buffer on the 30s interval and increments seq', () => {
    const { c, sent, tick } = make();
    c.recordPlayerEvent({ t: 1_000_000, type: 'play' });
    tick(30_000);
    const chunks = sent.filter((s) => s.body.kind === 'chunk');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.body.entries).toHaveLength(1);
    expect(chunks[0]!.body.seq).toBe(0);

    c.recordPlayerEvent({ t: 1_030_000, type: 'pause' });
    tick(30_000);
    const chunks2 = sent.filter((s) => s.body.kind === 'chunk');
    expect(chunks2).toHaveLength(2);
    expect(chunks2[1]!.body.seq).toBe(1);
  });

  // 2c. Empty interval ticks send nothing.
  it('sends nothing on an interval tick when the buffer is empty', () => {
    const { sent, tick } = make();
    const before = sent.length;
    tick(30_000);
    expect(sent).toHaveLength(before);
  });

  // 3. Every 5th chunk is followed by a fresh non-final summary.
  it('sends a fresh non-final summary after every 5th chunk', () => {
    const { c, sent } = make();
    // 5 chunks x 50 entries = 250 entries.
    for (let i = 0; i < 250; i++) c.recordPlayerEvent({ t: 1_000_000 + i, type: 'play' });
    const chunks = sent.filter((s) => s.body.kind === 'chunk');
    expect(chunks).toHaveLength(5);
    const summaries = sent.filter((s) => s.body.kind === 'summary');
    // Initial creation summary + one after the 5th chunk.
    expect(summaries).toHaveLength(2);
    expect(summaries[1]!.body.final).toBe(false);
    // The summary must come after the 5th chunk in send order.
    const fifthChunkIdx = sent.indexOf(chunks[4]!);
    const secondSummaryIdx = sent.indexOf(summaries[1]!);
    expect(secondSummaryIdx).toBeGreaterThan(fifthChunkIdx);
  });

  // 3b. Codex round-6 item 3 — `SessionSummary.seq` (protocol/src/vitals.ts)
  // must increment once per summary send, starting at 0, independently of
  // the chunk `seq` counter: the ingest route needs a signal that actually
  // orders summaries, since `durationMs` is millisecond-rounded and ties
  // legitimately.
  it('stamps each summary with a monotonically increasing seq, starting at 0', () => {
    const { c, sent } = make();
    // 5 chunks x 50 entries = 250 entries -> one summary after the 5th chunk.
    for (let i = 0; i < 250; i++) c.recordPlayerEvent({ t: 1_000_000 + i, type: 'play' });
    const summaries = sent.filter((s) => s.body.kind === 'summary');
    expect(summaries).toHaveLength(2); // initial + post-5th-chunk
    expect(summaries[0]!.body.seq).toBe(0);
    expect(summaries[1]!.body.seq).toBe(1);
  });

  // 4. Byte cap drops oldest entries, never throws, never grows unbounded.
  it('drops oldest entries once the byte cap is exceeded, without throwing', () => {
    const { c, sent, tick } = make({ maxBufferBytes: 500, maxEntriesPerChunk: 1000 });
    const bigData = { message: 'x'.repeat(100) };
    expect(() => {
      for (let i = 0; i < 20; i++) {
        c.recordPlayerEvent({ t: 1_000_000 + i, type: 'error', data: bigData });
      }
    }).not.toThrow();
    tick(30_000);
    const chunk = sent.find((s) => s.body.kind === 'chunk');
    expect(chunk).toBeDefined();
    // Each entry costs well over 100 bytes; 20 of them would blow past the
    // 500-byte cap, so only a handful of the most recent should survive.
    expect(chunk!.body.entries.length).toBeLessThan(20);
    const totalBytes = chunk!.body.entries.reduce(
      (sum: number, e: unknown) => sum + JSON.stringify(e).length,
      0
    );
    expect(totalBytes).toBeLessThanOrEqual(500);
  });

  // 4b. Codex round-1 item 4 — the byte cap must measure UTF-8 bytes, not
  // UTF-16 code units. A surrogate-pair emoji is 2 code units but 4 UTF-8
  // bytes, so a cap measured with `.length` would let this payload's real
  // wire cost run well past the budget — exactly what caused the 64 KiB
  // keepalive body budget to be exceeded upstream.
  it('caps buffered size in UTF-8 bytes, not UTF-16 code units — multibyte content flushes before exceeding the byte budget', () => {
    const emoji = '\u{1F600}'.repeat(50); // 50 emoji: 100 UTF-16 code units, 200 UTF-8 bytes, per occurrence
    const bigData = { message: emoji };
    const { c, sent, tick } = make({ maxBufferBytes: 1000, maxEntriesPerChunk: 1000 });
    expect(() => {
      for (let i = 0; i < 20; i++) {
        c.recordPlayerEvent({ t: 1_000_000 + i, type: 'error', data: bigData });
      }
    }).not.toThrow();
    tick(30_000);
    const chunk = sent.find((s) => s.body.kind === 'chunk');
    expect(chunk).toBeDefined();
    expect(chunk!.body.entries.length).toBeLessThan(20);

    const totalBytes = chunk!.body.entries.reduce(
      (sum: number, e: unknown) => sum + utf8ByteLength(JSON.stringify(e)),
      0,
    );
    expect(totalBytes).toBeLessThanOrEqual(1000);

    // Sanity check that this payload actually exercises the UTF-16/UTF-8
    // gap: measuring the SAME retained entries by `.length` alone reports
    // fewer units than real bytes, which is exactly the undercount that let
    // the buffer grow past the transport's real budget before this fix.
    const totalLength = chunk!.body.entries.reduce(
      (sum: number, e: unknown) => sum + JSON.stringify(e).length,
      0,
    );
    expect(totalBytes).toBeGreaterThan(totalLength);
  });

  // 4c. Codex round-2 item 3 — summing each entry's OWN serialised size
  // (as the two tests above do) missed the array's separating commas and
  // the chunk's own envelope (`kind`/`sessionId`/`seq`/brackets), and the
  // web transport wraps the chunk in one further `{"payload": ...}` layer
  // before it ever reaches `fetch(..., { keepalive: true })` — reproduced
  // upstream as 32 entries individually summing to 65,408 bytes producing a
  // 65,539-byte FINAL body, over the browser's ~65,536-byte keepalive
  // limit, losing the whole chunk on both the send and its retry. This
  // constructs a chunk at the DEFAULT 65,536-byte cap whose entries, summed
  // naively, land just UNDER it (the exact shape that used to slip through)
  // and asserts the actual final request body — envelope, commas, and the
  // transport's own wrapper included — stays under the real limit.
  it('keeps the FINAL framed+wrapped request body under the browser keepalive limit even right at the byte-cap boundary', () => {
    const { c, sent, tick } = make(); // default maxBufferBytes (65,536)
    const bigData = { message: 'x'.repeat(1982) }; // 32 of these sum (per-entry) to exactly 65,536 bytes — right at the naive cap
    for (let i = 0; i < 32; i++) {
      c.recordPlayerEvent({ t: 1_000_000 + i, type: 'error', data: bigData });
    }
    tick(30_000);
    const chunk = sent.find((s) => s.body.kind === 'chunk');
    expect(chunk).toBeDefined();

    // Sanity check this payload actually exercises the gap: the naive
    // per-entry sum alone is already at/under the cap, which is exactly
    // what let the old accounting through.
    const naiveSum = chunk!.body.entries.reduce(
      (sum: number, e: unknown) => sum + utf8ByteLength(JSON.stringify(e)),
      0,
    );
    expect(naiveSum).toBeLessThanOrEqual(65_536);

    // The real web transport wraps the chunk one level further:
    // `JSON.stringify({ payload: chunk })` (packages/sdk-web/src/vitals/transport.ts).
    const finalBody = JSON.stringify({ payload: chunk!.body });
    expect(utf8ByteLength(finalBody)).toBeLessThan(65_536);
  });

  // 4d. Codex round-3 item 8 — round-2's fixed 32-byte reserve above covered
  // the FETCH wrapper (12 bytes) but not the BEACON wrapper, which
  // additionally embeds the apiKey: `{"apiKey":"<key>","payload":<chunk>}`
  // (sdk-web's transport.ts's pagehide/beacon path — sendBeacon can't set
  // headers, so the key rides in the body). With the documented 41-char SDK
  // key format, the beacon wrapper alone costs 65 bytes — over double the
  // old reserve — so a chunk admitted under the old cap produced a
  // beacon body over the 64 KiB limit. Passing the real apiKey length via
  // `apiKeyByteLength` sizes the reserve to cover the ACTUAL wrapper this
  // key produces, at the same byte-cap boundary the 4c test above exercises
  // for the fetch path.
  it('keeps the FINAL beacon-wrapped request body (apiKey embedded) under the keepalive limit at the byte-cap boundary', () => {
    const apiKey = 'txx_live_' + '0'.repeat(32); // documented 41-char SDK key format
    const { c, sent, tick } = make({ apiKeyByteLength: apiKey.length }); // default maxBufferBytes (65,536)
    const bigData = { message: 'x'.repeat(1982) }; // same boundary shape as the 4c fetch test
    for (let i = 0; i < 32; i++) {
      c.recordPlayerEvent({ t: 1_000_000 + i, type: 'error', data: bigData });
    }
    tick(30_000);
    const chunk = sent.find((s) => s.body.kind === 'chunk');
    expect(chunk).toBeDefined();

    // The real beacon path additionally embeds the apiKey alongside the
    // chunk (packages/sdk-web/src/vitals/transport.ts's beacon branch).
    const finalBeaconBody = JSON.stringify({ apiKey, payload: chunk!.body });
    expect(utf8ByteLength(finalBeaconBody)).toBeLessThan(65_536);
  });

  // 4e. Same boundary, but with NO `apiKeyByteLength` supplied at all — every
  // platform/test constructed without it must still fall back to a reserve
  // that provably covers the documented 41-char key format, not silently
  // regress to the old (too-small) fixed 32-byte reserve.
  it('with no apiKeyByteLength supplied, the fallback reserve still covers the documented 41-char key at the byte-cap boundary', () => {
    const apiKey = 'txx_live_' + '0'.repeat(32);
    const { c, sent, tick } = make(); // no apiKeyByteLength — DEFAULT_API_KEY_RESERVE_BYTES fallback
    const bigData = { message: 'x'.repeat(1982) };
    for (let i = 0; i < 32; i++) {
      c.recordPlayerEvent({ t: 1_000_000 + i, type: 'error', data: bigData });
    }
    tick(30_000);
    const chunk = sent.find((s) => s.body.kind === 'chunk');
    expect(chunk).toBeDefined();
    const finalBeaconBody = JSON.stringify({ apiKey, payload: chunk!.body });
    expect(utf8ByteLength(finalBeaconBody)).toBeLessThan(65_536);
  });

  // 5. recent() reads from a separate ring; flushing pending does not empty it.
  it('recent() returns entries from a ring independent of the pending flush', () => {
    const { c, tick } = make();
    // Player events, not samples: samples deliberately never enter the ring
    // (see "samples are not transported" below).
    c.recordPlayerEvent({ t: 1_000_000, type: 'seek', data: { n: 100 } });
    c.recordPlayerEvent({ t: 1_000_010, type: 'seek', data: { n: 200 } });
    tick(30_000); // flushes pending via the interval
    const recent = c.recent(60_000);
    expect(recent).toHaveLength(2);
    expect(recent.map((e: any) => e.data.n)).toEqual([100, 200]);
  });

  it('recent() prunes entries outside the requested window', () => {
    const { c, tick } = make();
    c.recordPlayerEvent({ t: 1_000_000, type: 'seek', data: { n: 100 } });
    tick(70_000);
    c.recordPlayerEvent({ t: 1_070_000, type: 'seek', data: { n: 200 } });
    const recent = c.recent(60_000);
    expect(recent.map((e: any) => e.data.n)).toEqual([200]);
  });

  // 6. Idle split rotates the session.
  it('finalizes and rotates the session on an idle gap over maxIdleMs', () => {
    const { c, sent, tick } = make({ maxIdleMs: 1_800_000 });
    const firstSessionId = c.sessionId;
    c.recordPlayerEvent({ t: 1_000_000, type: 'play' });
    tick(1_800_001);
    c.recordPlayerEvent({ t: 2_800_001, type: 'play' });

    expect(c.sessionId).not.toBe(firstSessionId);

    const finalSummaries = sent.filter((s) => s.body.kind === 'summary' && s.body.final === true);
    expect(finalSummaries).toHaveLength(1);
    expect(finalSummaries[0]!.body.sessionId).toBe(firstSessionId);

    const initialSummaries = sent.filter(
      (s) => s.body.kind === 'summary' && s.body.final === false && s.body.sessionId === c.sessionId
    );
    expect(initialSummaries).toHaveLength(1);

    // The triggering entry landed in the NEW session, not the old one.
    const chunksOldSession = sent.filter(
      (s) => s.body.kind === 'chunk' && s.body.sessionId === firstSessionId
    );
    expect(chunksOldSession).toHaveLength(1);
    expect(chunksOldSession[0]!.body.entries).toHaveLength(1);
  });

  // 6a2. Codex round-6 item 3 — the summary `seq` counter is per-SESSION
  // (mirrors the chunk `seq`, which also resets on rotation): a rotated
  // session is a fresh DB row (vitals-route.ts upserts on (appId, sessionId)),
  // so there is no cross-session ordering for it to preserve, and reusing
  // the old session's running count would just be meaningless on the new row.
  it('resets the summary seq counter to 0 on session rotation', () => {
    const { c, sent, tick } = make({ maxIdleMs: 1_800_000 });
    const firstSessionId = c.sessionId;
    c.recordPlayerEvent({ t: 1_000_000, type: 'play' });
    tick(1_800_001);
    c.recordPlayerEvent({ t: 2_800_001, type: 'play' }); // triggers rotation

    const oldSessionSummaries = sent.filter(
      (s) => s.body.kind === 'summary' && s.body.sessionId === firstSessionId,
    );
    // The subject here is the SEQ NUMBERING, not how many summaries went out.
    // A live session now also emits a periodic non-final summary every
    // `summaryEveryChunks` flush intervals while it is accumulating (see
    // `bumpSummaryCadence`), so the old session's run is: initial, zero or
    // more periodic, then the rotation's final — numbered from 0, contiguously.
    expect(oldSessionSummaries.map((s) => s.body.seq)).toEqual(
      oldSessionSummaries.map((_, i) => i),
    );
    expect(oldSessionSummaries.at(-1)!.body.final).toBe(true);

    const newSessionSummaries = sent.filter(
      (s) => s.body.kind === 'summary' && s.body.sessionId === c.sessionId,
    );
    expect(newSessionSummaries[0]!.body.seq).toBe(0);
  });

  // 6b. Fix I2 (final review): the recent() ring must be CLEARED on
  // rotation, not merely left to drain via its own time-window pruning — a
  // report built just after an idle split must never carry the OLD
  // session's entries under the NEW sessionId. Requesting a window far
  // larger than the elapsed idle gap proves this is the explicit clear in
  // `startNewSession`, not just `recent()`'s ordinary window pruning.
  it('clears the recent() ring on an idle-gap rotation — no stale cross-session entries', () => {
    const { c, tick } = make({ maxIdleMs: 1_800_000 });
    c.recordPlayerEvent({ t: 1_000_000, type: 'seek', data: { n: 111 } });
    expect(c.recent(10_000_000).some((e: any) => e.data?.n === 111)).toBe(true);

    tick(1_800_001);
    c.recordPlayerEvent({ t: 2_800_001, type: 'play' });

    const recent = c.recent(10_000_000); // window >> the elapsed idle gap
    expect(recent.some((e: any) => e.mem === 111)).toBe(false);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.kind).toBe('player');
  });

  // 6c. Codex round-1 finding S4 — a session that never idles (continuous
  // entries, gap always well under maxIdleMs) must still be force-rotated
  // once it has run past maxSessionMs, bounding duration_ms far below int32
  // ms range (~24.8 days) instead of accumulating forever.
  it('force-rotates a session that never idles once it crosses maxSessionMs', () => {
    const { c, sent, tick } = make({ maxIdleMs: 1_800_000, maxSessionMs: 86_400_000 });
    const firstSessionId = c.sessionId;

    // Steady entries every 10 minutes — well under the 30-min idle
    // threshold — for just over 24h, so only the age cap can explain a
    // rotation.
    let t = 1_000_000;
    c.recordPlayerEvent({ t, type: 'play' });
    const stepMs = 600_000; // 10 min
    const steps = Math.ceil(86_400_001 / stepMs);
    for (let i = 0; i < steps; i++) {
      tick(stepMs);
      t += stepMs;
      c.recordPlayerEvent({ t, type: 'play' });
    }

    expect(c.sessionId).not.toBe(firstSessionId);

    const finalSummaries = sent.filter((s) => s.body.kind === 'summary' && s.body.final === true);
    expect(finalSummaries).toHaveLength(1);
    expect(finalSummaries[0]!.body.sessionId).toBe(firstSessionId);

    // Fresh session announced with seq/summary reset. Counting them would
    // pin the periodic cadence rather than the reset this test is about — the
    // new session keeps living (and summarizing) for the rest of the loop.
    const initialSummaries = sent.filter(
      (s) => s.body.kind === 'summary' && s.body.final === false && s.body.sessionId === c.sessionId
    );
    expect(initialSummaries.length).toBeGreaterThanOrEqual(1);
    expect(initialSummaries[0]!.body.seq).toBe(0);

    // The triggering entry (the one that crossed the age threshold) landed
    // in the NEW session at seq 0, not appended to the old one.
    const chunksNewSession = sent.filter(
      (s) => s.body.kind === 'chunk' && s.body.sessionId === c.sessionId
    );
    expect(chunksNewSession.length).toBeGreaterThan(0);
    expect(chunksNewSession[0]!.body.seq).toBe(0);
  });

  // 6d. Codex round-2 finding R6 — an idle rotation must finalize the OLD
  // session's summary AS OF its own last entry, not as of the (much later)
  // moment the gap-closing entry happened to arrive. A resume-time `now()`
  // would wrongly attribute the whole 3h gap (plus any open span) to the old
  // session's durationMs.
  it('idle rotation finalizes the old session at its last entry, not at resume time', () => {
    const { c, sent, tick } = make({ maxIdleMs: 1_800_000 });
    const firstSessionId = c.sessionId;
    // sessionStartedAt === the collector's construction-time now() === 1_000_000
    // (make()'s initial clock value) — this entry lands at the SAME instant,
    // so the old session's true duration is 0.
    c.recordPlayerEvent({ t: 1_000_000, type: 'play' });

    tick(10_800_000); // 3h gap, well past maxIdleMs
    c.recordPlayerEvent({ t: 1_000_000 + 10_800_000, type: 'play' });

    const finalSummaries = sent.filter(
      (s) => s.body.kind === 'summary' && s.body.final === true && s.body.sessionId === firstSessionId
    );
    expect(finalSummaries).toHaveLength(1);
    // Bug behavior would be 10_800_000 (the gap) or more; fixed behavior is
    // exactly 0 — the old session never lived past its one entry.
    expect(finalSummaries[0]!.body.durationMs).toBe(0);
  });

  // 6e. Codex round-2 finding R6 — a max-age rotation must finalize the OLD
  // session's summary AS OF the age boundary itself (`startedAt +
  // maxSessionMs`), not as of whatever moment the crossing entry happened to
  // arrive (which can overshoot the boundary by up to one entry-interval).
  it('max-age rotation finalizes the old session with durationMs exactly maxSessionMs', () => {
    const maxSessionMs = 86_400_000;
    const { c, sent, tick } = make({ maxIdleMs: 1_800_000, maxSessionMs });
    const firstSessionId = c.sessionId;

    let t = 1_000_000;
    c.recordPlayerEvent({ t, type: 'play' });
    const stepMs = 600_000; // 10 min — well under the idle threshold
    const steps = Math.ceil((maxSessionMs + 1) / stepMs);
    for (let i = 0; i < steps; i++) {
      tick(stepMs);
      t += stepMs;
      c.recordPlayerEvent({ t, type: 'play' });
    }

    const finalSummaries = sent.filter(
      (s) => s.body.kind === 'summary' && s.body.final === true && s.body.sessionId === firstSessionId
    );
    expect(finalSummaries).toHaveLength(1);
    // Bug behavior would overshoot by up to one stepMs (the crossing entry's
    // own arrival time); fixed behavior lands exactly on the boundary.
    expect(finalSummaries[0]!.body.durationMs).toBe(maxSessionMs);
  });

  // 7. stop() sends pending + final summary, clears timer, then no-ops.
  it('stop() flushes pending, sends a final summary, and further calls are no-ops', () => {
    const { c, sent, tick } = make();
    c.recordPlayerEvent({ t: 1_000_000, type: 'play' });
    c.stop();

    const finalSummaries = sent.filter((s) => s.body.kind === 'summary' && s.body.final === true);
    expect(finalSummaries).toHaveLength(1);
    const chunksAtStop = sent.filter((s) => s.body.kind === 'chunk');
    expect(chunksAtStop).toHaveLength(1);
    expect(chunksAtStop[0]!.body.entries).toHaveLength(1);

    const countAfterStop = sent.length;
    c.recordPlayerEvent({ t: 1_000_001, type: 'play' });
    c.flushNow();
    tick(60_000);
    expect(sent).toHaveLength(countAfterStop);
  });

  // 8. flushNow({ beacon: true }) sends pending chunk + summary with beacon passed through.
  it('flushNow({ beacon: true }) sends pending chunk + summary with beacon passed through', () => {
    const { c, sent } = make();
    c.recordPlayerEvent({ t: 1_000_000, type: 'play' });
    c.flushNow({ beacon: true });

    const chunk = sent.find((s) => s.body.kind === 'chunk');
    expect(chunk?.beacon).toBe(true);
    const summaries = sent.filter((s) => s.body.kind === 'summary');
    const lastSummary = summaries[summaries.length - 1];
    expect(lastSummary!.body.final).toBe(false);
    expect(lastSummary!.beacon).toBe(true);
  });

  // 9. Every public method body is wrapped via safeWrap — a throwing send()
  // must not escape recordPlayerEvent/flushNow/stop.
  it('wraps every public method with safeWrap so a throwing send() cannot escape', () => {
    let armed = false;
    const { c } = make({
      send: () => {
        if (armed) throw new Error('boom');
      },
    });
    armed = true; // constructor's own initial summary send already happened
    expect(() => c.recordPlayerEvent({ t: 1_000_000, type: 'play' })).not.toThrow();
    expect(() => c.recordSample({ t: 1_000_000, mem: 1 })).not.toThrow();
    expect(() => c.flushNow()).not.toThrow();
    expect(() => c.recent()).not.toThrow();
    expect(() => c.stop()).not.toThrow();
  });

  // Review finding 1: stop() must end fully stopped (flag set, timer
  // cleared) even when send() throws during finalization — not just avoid
  // throwing itself.
  it('stop() ends fully stopped even when send throws during finalization', () => {
    let armed = false;
    let callCount = 0;
    const { c, tick } = make({
      send: () => {
        callCount++;
        if (armed) throw new Error('boom');
      },
    });
    armed = true; // constructor's own initial summary send already happened
    c.recordPlayerEvent({ t: 1_000_000, type: 'play' }); // buffers only, no send yet

    expect(() => c.stop()).not.toThrow();
    const countAfterStop = callCount;

    // Further record/flush calls, and later timer ticks, must be complete
    // no-ops — proving `stopped` was set and the interval cleared despite
    // the throw inside finalizeSession().
    c.recordPlayerEvent({ t: 1_000_001, type: 'play' });
    c.flushNow();
    tick(60_000);
    expect(callCount).toBe(countAfterStop);
  });

  // Review finding 2: the periodic flush tick must be contained the same
  // way the public methods are — a throwing send() on one tick must not
  // escape, and must not prevent a later tick from flushing successfully.
  it('contains a throwing send() on a periodic tick and still flushes on a later tick', () => {
    let shouldThrow = false;
    const ledger: Array<{ body: any; beacon: boolean }> = [];
    const { c, tick } = make({
      send: (body: any, opts: any) => {
        if (shouldThrow) throw new Error('boom');
        ledger.push({ body, beacon: opts.beacon });
      },
    });
    ledger.length = 0; // drop the constructor's own initial summary

    shouldThrow = true;
    c.recordPlayerEvent({ t: 1_000_000, type: 'play' });
    expect(() => tick(30_000)).not.toThrow();
    expect(ledger.filter((s) => s.body.kind === 'chunk')).toHaveLength(0);

    shouldThrow = false;
    tick(30_000);
    const chunks = ledger.filter((s) => s.body.kind === 'chunk');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.body.entries).toHaveLength(1);
  });

  // Review finding 3: the ring must self-prune to the 60s window as entries
  // are recorded, not just lazily inside recent(). Proven by requesting a
  // window far larger than the self-prune threshold — if pruning only
  // happened lazily at the requested window, the old entry would still be
  // there.
  it('self-prunes the ring to the 60s window at record time, independent of recent() calls', () => {
    const { c, tick } = make();
    c.recordPlayerEvent({ t: 1_000_000, type: 'seek', data: { n: 1 } });
    tick(100_000); // now 100s later — the first entry is > 60s old
    c.recordPlayerEvent({ t: 1_100_000, type: 'seek', data: { n: 2 } });

    const recent = c.recent(500_000); // window far bigger than the 60s self-prune bound
    expect(recent.map((e: any) => e.data.n)).toEqual([2]);
  });

  // Codex round-2 finding R7 — the ring's time-window prune only drops
  // entries older than the window; an event storm packed into a single
  // instant (all `t` values identical, well inside the 60s window) never
  // trips that prune at all, so without a hard cap the ring grows
  // unboundedly for the whole storm. MAX_RING_ENTRIES=800 must still hold,
  // keeping only the NEWEST entries.
  it('caps the ring at 800 entries during an event storm, keeping the newest', () => {
    const { c } = make();
    for (let i = 0; i < 1000; i++) {
      c.recordPlayerEvent({ t: 1_000_000, type: 'seek', data: { n: i } });
    }
    const recent = c.recent(60_000);
    expect(recent.length).toBeLessThanOrEqual(800);
    // The newest entries (highest n, 200..999) must have survived — the
    // oldest (0..199) were the ones dropped.
    const ns = recent.map((e: any) => e.data.n);
    expect(ns[ns.length - 1]).toBe(999);
    expect(Math.min(...ns)).toBeGreaterThanOrEqual(200);
  });

  // Codex round-4 finding 1 — player event `data` is library/integration
  // controlled free-form JSON and was never bounded before reaching the
  // collector (only `custom` entries were, at the SDK-web call site). An
  // oversized player payload — a 6 MB `error.message`, matching the
  // finding's concrete scenario — must be bounded BEFORE it becomes an
  // entry at all, so neither the chunk sent to transport nor the recent
  // ring (which a bug report stamps verbatim) ever sees the raw oversized
  // value.
  //
  // Codex round-5 item 3 — round 4's version of this test pinned the
  // TOO-BLUNT fix: it asserted the whole entry stayed under 3000 bytes,
  // which only held because round 4 collapsed the whole `data` object to an
  // opaque `{ truncated, preview }` shell at the CUSTOM-entry cap
  // (`MAX_CUSTOM_DATA_BYTES` = 2048). That destroyed a legitimate 3 KB
  // structured error (see the test below) along with genuinely oversized
  // ones. Player events now get their own, larger budget
  // (`MAX_PLAYER_EVENT_DATA_BYTES` = 8192 — see that constant's doc-comment
  // in protocol/src/vitals.ts for why) and shrink the payload's STRING
  // fields in place rather than collapsing it, so this test now asserts
  // against that budget instead of the old custom-entry one, and asserts
  // the shape stays a real `error` payload (a shrunk `message` string), not
  // a preview shell.
  it('bounds an oversized player event payload before it reaches transport or the recent ring', () => {
    const { c, sent, tick } = make();
    const huge = 'x'.repeat(6_000_000); // 6 MB — the finding's concrete scenario
    c.recordPlayerEvent({ t: 1_000_000, type: 'error', data: { message: huge, code: 3, fatal: true } });
    tick(30_000);

    const chunk = sent.find((s) => s.body.kind === 'chunk');
    expect(chunk).toBeDefined();
    expect(chunk!.body.entries).toHaveLength(1);
    const sentEntry = chunk!.body.entries[0];
    // Bounded to (well under) the player-event budget — nowhere close to
    // the original 6 MB. A little headroom over the raw data budget for the
    // entry's own kind/t/type/truncated framing.
    expect(JSON.stringify(sentEntry).length).toBeLessThan(MAX_PLAYER_EVENT_DATA_BYTES + 200);
    expect(typeof sentEntry.data?.message).toBe('string');
    expect(sentEntry.data?.message).not.toBe(huge);
    // The scalar fields survive intact — the whole point of item 3: an
    // operator must still see `code`/`fatal` even though `message` was cut.
    expect(sentEntry.data?.code).toBe(3);
    expect(sentEntry.data?.fatal).toBe(true);
    expect(sentEntry.truncated).toBe(true);

    // The ring (report enrichment) must see the SAME bounded entry, not the
    // raw oversized one — this is the exact path the finding says can
    // destroy an unrelated bug/crash report.
    const recent = c.recent(60_000);
    expect(recent).toHaveLength(1);
    expect(JSON.stringify(recent[0]).length).toBeLessThan(MAX_PLAYER_EVENT_DATA_BYTES + 200);
  });

  // Codex round-5 item 3 — the concrete regression: a 3 KB structured error
  // comfortably fits the player-event budget (8192 bytes) and must survive
  // COMPLETELY untouched, unlike round 4's 2048-byte cap which destroyed it.
  it('a 3 KB structured error payload survives completely intact (Codex round-5 item 3)', () => {
    const { c, sent, tick } = make();
    const detail = 'd'.repeat(3_000); // ~3 KB — comfortably under the 8192-byte budget
    c.recordPlayerEvent({
      t: 1_000_000,
      type: 'error',
      data: { message: 'decode error', code: 3, fatal: true, detail },
    });
    tick(30_000);

    const chunk = sent.find((s) => s.body.kind === 'chunk');
    const sentEntry = chunk!.body.entries[0];
    expect(sentEntry.data).toEqual({ message: 'decode error', code: 3, fatal: true, detail });
    expect(sentEntry.truncated).toBeUndefined();
  });

  // Codex round-5 item 3 — the multi-megabyte case: bounded, but `code` and
  // `fatal` must survive even though `message`/`detail` had to be cut.
  it('a multi-megabyte structured error is bounded but keeps code and fatal (Codex round-5 item 3)', () => {
    const { c, sent, tick } = make();
    c.recordPlayerEvent({
      t: 1_000_000,
      type: 'error',
      data: {
        message: 'm'.repeat(2_000_000),
        code: 4,
        fatal: true,
        detail: 'd'.repeat(2_000_000),
      },
    });
    tick(30_000);

    const chunk = sent.find((s) => s.body.kind === 'chunk');
    const sentEntry = chunk!.body.entries[0];
    expect(utf8ByteLength(JSON.stringify(sentEntry.data))).toBeLessThanOrEqual(MAX_PLAYER_EVENT_DATA_BYTES);
    expect(sentEntry.data?.code).toBe(4);
    expect(sentEntry.data?.fatal).toBe(true);
    expect(sentEntry.truncated).toBe(true);
  });

  // Codex round-4 finding 1 — the other half of the fix: whatever the
  // chunk-eviction loop above actually refuses outright (not routine
  // rolling-window eviction of OTHER entries, but an entry that still can't
  // fit a chunk even entirely alone) must not survive anywhere else,
  // including the recent ring. Exercised via `recordCustom` with a tiny
  // `maxBufferBytes`: `recordCustom`'s own contract documents bounding as
  // the CALLER's job (see the `VitalsCollector.recordCustom` doc-comment),
  // so the collector itself must not assume every caller already bounded
  // its payload — this is the safety net for when one hasn't.
  it('never retains in the ring an entry the chunk-eviction loop rejected outright', () => {
    const { c } = make({ maxBufferBytes: 200, maxEntriesPerChunk: 1000 });
    // Far bigger than the 200-byte chunk budget even entirely on its own.
    const data = { message: 'x'.repeat(1000) };
    c.recordCustom({ t: 1_000_000, name: 'big', data });

    const recent = c.recent(60_000);
    expect(recent).toHaveLength(0);
  });

  // Codex round-3 finding F3 — `onRotate` lets sdk-web's player adapter
  // re-seed ongoing playback/buffering state into a freshly-rotated
  // session, which otherwise starts blind to activity that predates it.
  describe('onRotate (Codex round-3 finding F3)', () => {
    it('fires exactly once per idle-gap rotation, after the new session already exists', () => {
      const calls: string[] = [];
      const { c, tick } = make({
        maxIdleMs: 1_800_000,
        onRotate: () => calls.push(c.sessionId),
      });
      const firstSessionId = c.sessionId;
      c.recordPlayerEvent({ t: 1_000_000, type: 'play' });

      expect(calls).toHaveLength(0); // no rotation yet

      tick(1_800_001);
      c.recordPlayerEvent({ t: 2_800_001, type: 'play' }); // triggers the rotation

      expect(calls).toHaveLength(1);
      // Fired AFTER the new session was already live — the sessionId read
      // inside the callback is the NEW one, not the old.
      expect(calls[0]).toBe(c.sessionId);
      expect(calls[0]).not.toBe(firstSessionId);
    });

    it('fires exactly once per max-age rotation', () => {
      const maxSessionMs = 86_400_000;
      let rotateCount = 0;
      const { c, tick } = make({
        maxIdleMs: 1_800_000,
        maxSessionMs,
        onRotate: () => rotateCount++,
      });

      let t = 1_000_000;
      c.recordPlayerEvent({ t, type: 'play' });
      const stepMs = 600_000;
      const steps = Math.ceil((maxSessionMs + 1) / stepMs);
      for (let i = 0; i < steps; i++) {
        tick(stepMs);
        t += stepMs;
        c.recordPlayerEvent({ t, type: 'play' });
      }

      expect(rotateCount).toBe(1);
    });

    it('never fires when no rotation happens', () => {
      let rotateCount = 0;
      const { c, tick } = make({ onRotate: () => rotateCount++ });
      c.recordPlayerEvent({ t: 1_000_000, type: 'play' });
      tick(30_000);
      c.recordPlayerEvent({ t: 1_030_000, type: 'pause' });

      expect(rotateCount).toBe(0);
    });

    it('a throwing onRotate does not break recording of the triggering entry or later entries', () => {
      const { c, sent, tick } = make({
        maxIdleMs: 1_800_000,
        onRotate: () => {
          throw new Error('boom');
        },
      });

      c.recordPlayerEvent({ t: 1_000_000, type: 'play' });
      expect(() => {
        tick(1_800_001);
        c.recordPlayerEvent({ t: 2_800_001, type: 'play' }); // triggers rotation + throwing onRotate
      }).not.toThrow();

      // The triggering entry still landed in the new session.
      const newSessionChunks = sent.filter(
        (s) => s.body.kind === 'chunk' && s.body.sessionId === c.sessionId,
      );
      expect(newSessionChunks).toHaveLength(0); // not flushed yet, but recorded — see recent() below
      expect(c.recent(10_000_000).some((e: any) => e.t === 2_800_001)).toBe(true);

      // Recording keeps working after the throw, on both an ordinary entry...
      expect(() => c.recordPlayerEvent({ t: 2_800_002, type: 'pause' })).not.toThrow();
      // ...and a SECOND rotation later.
      expect(() => {
        tick(1_800_001);
        c.recordPlayerEvent({ t: 4_600_003, type: 'play' });
      }).not.toThrow();
    });
  });
});

describe('phase 4 — recordCustom', () => {
  it('buffers a custom entry and flushes it in the chunk with kind: "custom"', () => {
    const { c, sent } = make();
    c.recordCustom({ t: 1_000_000, name: 'cdn.switch', data: { to: 'edge-b' }, playerId: 'p1' });
    c.flushNow();
    const chunk = sent.map((s) => s.body).find((b) => b.kind === 'chunk');
    expect(chunk.entries).toContainEqual({ kind: 'custom', t: 1_000_000, name: 'cdn.switch', data: { to: 'edge-b' }, playerId: 'p1' });
  });
  it('is a no-op after stop()', () => {
    const { c, sent } = make();
    c.stop();
    const before = sent.length;
    c.recordCustom({ t: 1_000_001, name: 'late' });
    c.flushNow();
    expect(sent.length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// CPU/memory samples feed the summary but are never transported.
//
// Resource consumption is covered by the report resource window
// (packages/protocol/src/resources.ts): a 2-second-resolution ring attached to
// the report or crash that explains it. The vitals sample stream was
// 30-second resolution smeared across a whole session — lower resolution, not
// aligned to any failure, and responsible for essentially all of the volume.
// Measured on the server side: 79% of stored chunks came from sessions where
// no video ever played, and one 10-hour session produced 1,154 objects holding
// nothing but samples.
//
// `recordSample` deliberately still exists and still runs the FULL addEntry
// path — session rotation, `lastEntryAt`, the accumulator — so session
// lifetime semantics are unchanged and `memPeak`/`memAvg` keep landing on the
// summary. Only two things stop: the chunk queue and the recent ring.
// ---------------------------------------------------------------------------
describe('createVitalsCollector — samples are not transported', () => {
  it('never puts a sample into a flushed chunk', () => {
    const { c, sent } = make();
    for (let i = 0; i < 60; i++) c.recordSample({ t: 1_000_000 + i, mem: 1000 + i });
    c.flushNow();
    const chunks = sent.filter((s) => s.body.kind === 'chunk');
    expect(chunks).toHaveLength(0);
  });

  it('sends no chunk at all for a session that only ever samples', () => {
    const { c, sent, tick } = make();
    c.recordSample({ t: 1_000_000, mem: 5000 });
    tick(60_000);
    expect(sent.filter((s) => s.body.kind === 'chunk')).toHaveLength(0);
  });

  it('still reports memPeak and memAvg on the summary', () => {
    const { c, sent } = make();
    c.recordSample({ t: 1_000_000, mem: 1000 });
    c.recordSample({ t: 1_000_001, mem: 3000 });
    c.stop();
    const summary = sent.filter((s) => s.body.kind === 'summary').pop();
    expect(summary!.body.memPeak).toBe(3000);
    expect(summary!.body.memAvg).toBe(2000);
  });

  it('keeps samples out of the recent ring, so they never ride into a report', () => {
    const { c } = make();
    c.recordSample({ t: 1_000_000, mem: 1000 });
    c.recordPlayerEvent({ t: 1_000_001, type: 'play' });
    const recent = c.recent();
    expect(recent.map((e) => e.kind)).toEqual(['player']);
  });

  it('still transports player events alongside dropped samples', () => {
    const { c, sent } = make();
    c.recordSample({ t: 1_000_000, mem: 1000 });
    c.recordPlayerEvent({ t: 1_000_001, type: 'play' });
    c.recordSample({ t: 1_000_002, mem: 2000 });
    c.recordPlayerEvent({ t: 1_000_003, type: 'pause' });
    c.flushNow();
    const chunk = sent.filter((s) => s.body.kind === 'chunk').pop();
    expect(chunk!.body.entries.map((e: { kind: string }) => e.kind)).toEqual(['player', 'player']);
  });

  it('a sample still counts as activity, so it does not let a session rotate out from under itself', () => {
    // DEFAULT_MAX_IDLE_MS is 30 min. Sampling every 10 minutes must keep one
    // session alive — dropping samples from `addEntry` wholesale (rather than
    // only from transport) would silently change session lifetimes.
    const { c } = make();
    const first = c.sessionId;
    c.recordSample({ t: 1_000_000, mem: 1000 });
    for (let i = 1; i <= 5; i++) c.recordSample({ t: 1_000_000 + i * 600_000, mem: 1000 });
    expect(c.sessionId).toBe(first);
  });

  // The periodic non-final summary used to ride on `sendChunk`'s counter, and
  // `sendChunk` returns early when `pending` is empty. Once samples stopped
  // being transported, a session with no playback activity — the common case,
  // and 79% of stored sessions before this change — produced no chunks and so
  // sent NO periodic summaries at all. Two things broke with it: memPeak and
  // memAvg only reached the server if the session ended cleanly (an app killed
  // by the OS lost them entirely), and the server's `lastSeenAt` stopped
  // advancing while the session was still live, which is what drives
  // stale-session detection and retention.
  it('keeps sending periodic summaries for a session with no playback activity', () => {
    const { c, sent, tick } = make();
    c.recordSample({ t: 1_000_000, mem: 1000 });
    c.recordSample({ t: 1_000_001, mem: 3000 });

    // Five flush intervals — the same cadence five chunks used to represent.
    for (let i = 0; i < 5; i++) tick(30_000);

    const summaries = sent.filter((s) => s.body.kind === 'summary');
    expect(summaries.length).toBe(2); // the initial one, plus one periodic
    expect(summaries.at(-1)!.body.final).toBe(false);
    expect(summaries.at(-1)!.body.memPeak).toBe(3000);
    expect(sent.filter((s) => s.body.kind === 'chunk')).toHaveLength(0);
  });

  it('does not send a periodic summary more often than the chunk cadence would have', () => {
    const { c, sent, tick } = make();
    c.recordSample({ t: 1_000_000, mem: 1000 });
    for (let i = 0; i < 4; i++) tick(30_000); // one short of the cadence
    expect(sent.filter((s) => s.body.kind === 'summary')).toHaveLength(1);
  });

  // This file's discipline everywhere else is send-THEN-advance: `seq++`,
  // `summarySeq++` and `pending = []` all run after a successful `send`, so a
  // throwing transport retries the same payload rather than silently losing
  // it. The accumulation gate must follow the same rule — clearing it before
  // the send means a throw discards the fact that there was anything to
  // report, and the next periodic summary never fires.
  it('retries the periodic summary after a throwing send instead of losing it', () => {
    const attempts: Array<{ kind: string }> = [];
    const summaryAttempts = () => attempts.filter((a) => a.kind === 'summary').length;
    const { c, tick } = make({
      send: (body: { kind: string }) => {
        attempts.push(body);
        if (body.kind === 'summary' && summaryAttempts() === 2) throw new Error('transport down');
      },
    });

    c.recordSample({ t: 1_000_000, mem: 1000 });
    for (let i = 0; i < 5; i++) tick(30_000); // the 2nd summary attempt throws
    expect(summaryAttempts()).toBe(2);

    for (let i = 0; i < 5; i++) tick(30_000);
    expect(summaryAttempts()).toBe(3); // tried again rather than giving up
  });
});

// Task 11 (spec 2026-09-10 — playback session identity). The collector is the
// only place that knows when a summary is about to go out, so it is the only
// place that can attach "who was signed in AS OF THIS SUMMARY".
describe('identity on the summary', () => {
  it('stamps the self-declared user block onto every summary', () => {
    const { c, sent } = make({ identity: () => ({ user: { id: 'u-1', email: 'a@b.com' } }) });
    c.stop();
    const summaries = sent.filter((s) => s.body.kind === 'summary');
    expect(summaries.length).toBeGreaterThan(1);
    expect(summaries[0]!.body.user).toEqual({ id: 'u-1', email: 'a@b.com' });
    expect(summaries.at(-1)!.body.user).toEqual({ id: 'u-1', email: 'a@b.com' });
  });

  it('omits `user` entirely when the provider returns null', () => {
    const { sent } = make({ identity: () => null });
    expect(sent[0]!.body.kind).toBe('summary');
    expect('user' in (sent[0]!.body as object)).toBe(false);
  });

  it('omits `user` when no provider is wired at all', () => {
    const { sent } = make();
    expect(sent[0]!.body.kind).toBe('summary');
    expect('user' in (sent[0]!.body as object)).toBe(false);
  });

  it('re-reads the provider per summary, so a later sign-in is picked up', () => {
    let user: { id: string } | undefined;
    const { c, sent } = make({ identity: () => (user ? { user } : null) });
    // The creation summary went out while still anonymous.
    expect('user' in (sent[0]!.body as object)).toBe(false);
    user = { id: 'u-late' };
    c.flushNow();
    expect(sent.filter((s) => s.body.kind === 'summary').at(-1)!.body.user).toEqual({
      id: 'u-late',
    });
  });

  // Never on a chunk: the server resolves identity from summaries only, and a
  // chunk carrying it would be dead weight on a 30-second cadence.
  it('never stamps identity onto a chunk', () => {
    const { c, sent } = make({ identity: () => ({ user: { id: 'u-1' } }) });
    c.recordPlayerEvent({ t: 1_000_000, type: 'play' });
    c.flushNow();
    const chunk = sent.find((s) => s.body.kind === 'chunk');
    expect(chunk).toBeDefined();
    expect('user' in (chunk!.body as object)).toBe(false);
  });

  // A throwing host provider must never break the summary itself — identity is
  // an enrichment, the metrics are the payload.
  it('still sends the summary when the provider throws', () => {
    const { sent } = make({
      identity: () => {
        throw new Error('host provider exploded');
      },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.kind).toBe('summary');
    expect('user' in (sent[0]!.body as object)).toBe(false);
  });

  // `projectUserMetadata` (sdk-core) returns `{}` for an object with no
  // string-valued id/email/displayName, and `setUser({})` is legal. An empty
  // object on the wire is not the same as an absent key.
  it('omits `user` when the provider returns an empty user object', () => {
    const { sent } = make({ identity: () => ({ user: {} }) });
    expect('user' in (sent[0]!.body as object)).toBe(false);
  });

  // Fix round (review, Minor) — an untyped JS host calling
  // `createVitalsCollector`/`setupVitals` directly can hand back non-string
  // field values (the TS type only binds a TS caller). Forwarded unsanitized,
  // a non-string `id` fails the ingest route's zod validation and takes down
  // the WHOLE summary, not just the field — so the collector must strip
  // non-string values rather than merely checking they are defined.
  it('drops non-string user fields instead of forwarding them onto the wire', () => {
    const { sent } = make({
      identity: () => ({ user: { id: 123, email: 'a@b.com', displayName: { nested: true } } }),
    });
    expect(sent[0]!.body.user).toEqual({ email: 'a@b.com' });
  });

  it('omits `user` entirely when every field is non-string', () => {
    const { sent } = make({ identity: () => ({ user: { id: 123 } }) });
    expect('user' in (sent[0]!.body as object)).toBe(false);
  });

  // Adversarial review of PR #218 round 6, finding 1 — the same untyped JS
  // host, one field over: a `token` that is PRESENT but unusable is a
  // credential that was SUPPLIED AND FAILED. Keeping the `user` block beside
  // it turns a failed credential into an ordinary UNVERIFIED person (the
  // transport is told no token was offered at all), which invariant 1 forbids.
  describe('a present-but-unusable token drops the self-declared claim too', () => {
    for (const [label, token] of [
      ['null', null],
      ['a number', 123],
      ['an object', { jwt: 'a.b.c' }],
      ['an array', ['a.b.c']],
    ] as const) {
      it(`sends neither the token nor \`user\` when the token is ${label}`, () => {
        const { c, sent } = make({ identity: () => ({ token, user: { id: 'alice' } }) });
        c.stop();
        const summaries = sent.filter((s) => s.body.kind === 'summary');
        expect(summaries.length).toBeGreaterThan(1);
        for (const s of summaries) {
          expect('user' in (s.body as object)).toBe(false);
          expect(s.token).toBeUndefined();
        }
      });

      // `tokenPending` must not rescue it either: the twin guard withholds the
      // claim while a token is still COMING, which is a different state from
      // one having arrived broken.
      it(`sends neither half when the token is ${label} and tokenPending is true`, () => {
        const { c, sent } = make({
          identity: () => ({ token, tokenPending: true, user: { id: 'alice' } }),
        });
        c.stop();
        for (const s of sent.filter((x) => x.body.kind === 'summary')) {
          expect('user' in (s.body as object)).toBe(false);
          expect(s.token).toBeUndefined();
        }
      });
    }

    // THE NEGATIVE CASE, and the reason the check is on `!== undefined` rather
    // than `'token' in identity`: a genuinely absent credential is the
    // self-declared tier working as designed and keeps its claim. An explicit
    // `token: undefined` counts as absent — it is what ordinary optional-field
    // wiring produces.
    it('keeps `user` when the token is genuinely absent', () => {
      for (const identity of [
        () => ({ user: { id: 'alice' } }),
        () => ({ token: undefined, user: { id: 'alice' } }),
      ]) {
        const { sent } = make({ identity });
        expect(sent[0]!.body.user).toEqual({ id: 'alice' });
        expect(sent[0]!.token).toBeUndefined();
      }
    });
  });

  // Adversarial review of PR #218 round 6, finding 2 — a host callback that
  // throws an error carrying its own credential had the whole thing logged by
  // `safeWrap`, where a console-capture integration exports it. The identity
  // call sites log the error's NAME instead.
  it('never logs a throwing identity callback’s message, and still sends', () => {
    const jwt = 'a.b.c-live-credential';
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { c, sent } = make({
      identity: () => {
        throw new Error(`identity refresh failed for Bearer ${jwt}`);
      },
      warmIdentity: () => {
        throw new Error(`warm failed for Bearer ${jwt}`);
      },
    });
    c.stop();
    const logged = log.mock.calls.map((args) => args.map((v) => String(v)).join(' ')).join('\n');
    expect(logged).not.toContain(jwt);
    expect(logged).not.toContain('Bearer');
    // Still diagnosable, and the metrics still went out.
    expect(logged).toContain('VitalsCollector.identity threw');
    expect(logged).toContain('Error');
    expect(sent.filter((s) => s.body.kind === 'summary').length).toBeGreaterThan(1);
    log.mockRestore();
  });

  // Fix round (7th codex round, PR #218, HEAD 40ef7ef5c) — the name-only
  // projection above reads `err.name` unguarded. `name` is a getter, and the
  // host controls the `Error` it throws, so it can make the getter itself
  // throw. Unguarded, that blew up the projection: during `stop()` the
  // exception aborted the FINAL summary outright (teardown means no second
  // attempt — the summary is lost, which is the session row's only source of
  // dims and metrics), and `safeWrap` then logged the GETTER's own error
  // UNREDACTED — reopening the exact credential-disclosure hole the
  // projection exists to close, if that error's message carries one.
  it('still delivers the final summary from stop(), and never logs the name getter’s own message, when the thrown error’s `name` getter itself throws', () => {
    const getterLeak = 'name-getter-leaked-a-Bearer-live-credential';
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    const { c, sent } = make({
      identity: () => {
        calls++;
        // First read (the initial summary at construction) succeeds
        // normally so the adversarial throw is isolated to the stop() /
        // final-summary path the reviewer flagged.
        if (calls === 1) return { user: { id: 'alice' } };
        const poisoned = new Error('identity refresh failed');
        Object.defineProperty(poisoned, 'name', {
          get() {
            throw new Error(getterLeak);
          },
        });
        throw poisoned;
      },
    });
    expect(sent.filter((s) => s.body.kind === 'summary')).toHaveLength(1);

    expect(() => c.stop()).not.toThrow();

    const finalSummaries = sent.filter((s) => s.body.kind === 'summary' && s.body.final === true);
    expect(finalSummaries).toHaveLength(1);

    const logged = log.mock.calls.map((args) => args.map((v) => String(v)).join(' ')).join('\n');
    expect(logged).not.toContain(getterLeak);
    expect(logged).not.toContain('Bearer');
    log.mockRestore();
  });

  // Adversarial review of PR #218 round 1, finding 6 — measured: an unbounded
  // `displayName` produced a 70,553-byte beacon body and a 70,421-byte
  // keepalive fetch fallback, BOTH past sendBeacon's 64 KiB ceiling, so the
  // summary could not be delivered at all. Optional identity data must never
  // cost the metrics their delivery.
  //
  // Round 2, finding 4 — but round 1 TRUNCATED, and that was worse than the
  // bug it fixed: `user.id` is the identity KEY, so shortening it merges
  // distinct people. Over-long values are DROPPED now, exactly as the server's
  // own `readString` drops them.
  describe('over-long user attributes are dropped, never allowed to cost the summary', () => {
    it('drops every over-long attribute, keeping the summary deliverable', () => {
      const { sent } = make({
        identity: () => ({
          user: {
            id: 'a'.repeat(70_000),
            email: 'b'.repeat(70_000),
            displayName: 'c'.repeat(70_000),
          },
        }),
      });
      // Nothing keyable survived, so the block is omitted entirely — the same
      // outcome the server reaches for the same input, minus the bytes.
      expect('user' in (sent[0]!.body as object)).toBe(false);
      // The whole body stays far below sendBeacon's 64 KiB limit, which is
      // the property that actually matters here.
      expect(utf8ByteLength(JSON.stringify(sent[0]!.body))).toBeLessThan(64 * 1024);
    });

    // THE REGRESSION. Two ids differing only past the 255-char cap truncated
    // to the same string, so two people collapsed into one (reproduced against
    // the database: two sessions with distinct input ids referencing one
    // person). An identifier is never edited — either it is the one the host
    // gave us, or we do not have it.
    it('never merges two distinct over-long ids into one person', () => {
      const a = make({ identity: () => ({ user: { id: 'x'.repeat(255) + 'a' } }) });
      const b = make({ identity: () => ({ user: { id: 'x'.repeat(255) + 'b' } }) });
      const userA = (a.sent[0]!.body as { user?: { id?: string } }).user;
      const userB = (b.sent[0]!.body as { user?: { id?: string } }).user;
      // Neither id is sent at all — and above all, they are not sent as the
      // SAME id.
      expect(userA?.id).toBeUndefined();
      expect(userB?.id).toBeUndefined();
      expect(userA?.id ?? '<absent-a>').not.toBe(userB?.id ?? '<absent-b>');
    });

    // Dropping the key does not drop the block: the email can still key the
    // person, exactly as the server's `normalizeSelfDeclaredUser` would have
    // decided for the same input.
    it('drops only the offending attribute, leaving the rest of the block deliverable', () => {
      const { sent } = make({
        identity: () => ({
          user: { id: 'x'.repeat(70_000), email: 'a@b.com', displayName: 'Ada' },
        }),
      });
      expect(sent[0]!.body.user).toEqual({ email: 'a@b.com', displayName: 'Ada' });
      expect(utf8ByteLength(JSON.stringify(sent[0]!.body))).toBeLessThan(64 * 1024);
    });

    it('an over-long attribute still yields a deliverable summary with its metrics', () => {
      const { sent } = make({
        identity: () => ({ user: { id: 'alice', displayName: 'x'.repeat(70_000) } }),
      });
      const body = sent[0]!.body as { user?: { id?: string; displayName?: string }; kind: string };
      expect(body.kind).toBe('summary');
      expect(body.user).toEqual({ id: 'alice' });
      expect(utf8ByteLength(JSON.stringify(body))).toBeLessThan(64 * 1024);
    });

    it('leaves values already inside the caps untouched', () => {
      const { sent } = make({
        identity: () => ({ user: { id: 'alice', email: 'a@b.com', displayName: 'Ada' } }),
      });
      expect(sent[0]!.body.user).toEqual({ id: 'alice', email: 'a@b.com', displayName: 'Ada' });
    });
  });
});

// Adversarial review of PR #218, finding 1 — the verified tier never
// activated on a fresh install because the cache `identity()` reads is filled
// ONLY by the async `IdentityTokenHolder.get()`, which nothing on a
// watch-only session ever called. The collector owns the cadence, so it owns
// the warm.
describe('warmIdentity', () => {
  it('warms once at construction, before the initial summary can need it', () => {
    const warmIdentity = vi.fn();
    const { sent } = make({ warmIdentity });
    expect(warmIdentity).toHaveBeenCalledTimes(1);
    expect(sent[0]!.body.kind).toBe('summary');
  });

  it('warms again on every flush tick, whether or not there is anything to send', () => {
    const warmIdentity = vi.fn();
    const { c, tick } = make({ warmIdentity });
    expect(warmIdentity).toHaveBeenCalledTimes(1);
    tick(30_000); // idle tick — nothing buffered
    expect(warmIdentity).toHaveBeenCalledTimes(2);
    c.recordPlayerEvent({ t: 1_030_000, type: 'play' });
    tick(30_000); // tick with a chunk to send — returns early, must still warm
    expect(warmIdentity).toHaveBeenCalledTimes(3);
  });

  // The unload path must stay synchronous and must not kick off work the page
  // is about to discard.
  it('never warms from the unload path (flushNow/stop)', () => {
    const warmIdentity = vi.fn();
    const { c } = make({ warmIdentity });
    warmIdentity.mockClear();
    c.flushNow({ beacon: true });
    c.stop();
    expect(warmIdentity).not.toHaveBeenCalled();
  });

  it('a throwing warm never breaks the collector', () => {
    const { sent } = make({
      warmIdentity: () => {
        throw new Error('reader exploded');
      },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.kind).toBe('summary');
  });

  // The point of the warm: a token that is not cached when the collector
  // starts IS cached by the time a periodic summary is built, with no report
  // ever filed.
  it('makes a later summary carry a token the first one could not', () => {
    let cached: string | null = null;
    const warmIdentity = vi.fn(() => {
      cached = 'tok-warm'; // stands in for `get()` resolving and filling the cache
    });
    const { sent, tick } = make({
      warmIdentity,
      identity: () => (cached !== null ? { token: cached } : null),
    });
    // The construction summary went out before the warm could land.
    expect(sent).toHaveLength(1);
    tick(30_000);
    tick(30_000);
    tick(30_000);
    tick(30_000);
    tick(30_000);
    expect(cached).toBe('tok-warm');
  });
});

// Adversarial review of PR #218 round 2, finding 3 — the COLD-START TWIN,
// reproduced with a correctly signed token and no report filed: two identity
// rows for one fresh session. `identity()` is cache-only and synchronous, so
// the construction summary cannot carry a token; with `setUser` also set it
// carried the self-declared block instead and the server minted an UNVERIFIED
// person, then minted the VERIFIED one from the next summary's token.
describe('the cold-start twin guard (tokenPending)', () => {
  /** An async token provider plus setUser — the exact reproduction. */
  /** What `identity()` reported at each send — the transport's half. */
  let tokenAtSend: Array<string | undefined>;
  const asyncProviderPlusSetUser = () => {
    let token: string | null = null;
    let settled = false;
    tokenAtSend = [];
    return make({
      warmIdentity: () => {
        // Stands in for `IdentityTokenHolder.get()` resolving one turn later.
        queueMicrotask(() => {
          token = 'tok-verified';
          settled = true;
        });
      },
      identity: () => {
        tokenAtSend.push(token ?? undefined);
        return {
          ...(token !== null ? { token } : {}),
          ...(settled ? {} : { tokenPending: true }),
          user: { id: 'viewer' },
        };
      },
    });
  };

  it('withholds the self-declared block while a token is still coming', () => {
    const { sent } = asyncProviderPlusSetUser();
    // The construction summary: no token (the warm has not resolved) and,
    // crucially, NO user block either. Anonymous for one interval.
    expect(sent).toHaveLength(1);
    expect('user' in sent[0]!.body).toBe(false);
  });

  it('ONE identity, not two: the next summary carries the token instead', async () => {
    const { c, sent, tick } = asyncProviderPlusSetUser();
    await Promise.resolve(); // let the warm settle
    // Drive a real periodic summary (an idle collector stays silent).
    for (let i = 0; i < 250; i++) c.recordPlayerEvent({ t: 1_000_000 + i, type: 'play' });
    tick(30_000);
    const summaries = sent.filter((x) => x.body.kind === 'summary');
    expect(summaries.length).toBeGreaterThanOrEqual(2);
    // The later summary DOES carry the block — and a verified token with it,
    // which the ingest route prefers, so it resolves to the verified person
    // and never to a self-declared twin.
    expect(summaries[1]!.body.user).toEqual({ id: 'viewer' });

    // THE PROPERTY THAT PRODUCED THE TWIN: a summary carrying a self-declared
    // `user` block and NO token is the only thing that mints an unverified
    // person. Across this whole session there is not one.
    // `identity()` is consulted exactly once per summary, so `tokenAtSend[k]`
    // is what the k-th summary could have presented.
    expect(tokenAtSend).toHaveLength(summaries.length);
    const unverifiableClaims = summaries.filter(
      (x, k) => 'user' in x.body && tokenAtSend[k] === undefined,
    );
    expect(unverifiableClaims).toHaveLength(0);
  });

  it('sends the self-declared block immediately when NO token source is configured', () => {
    // The whole self-declared-only population: nothing pending, nothing
    // withheld, unchanged behaviour.
    const { sent } = make({ identity: () => ({ user: { id: 'viewer' } }) });
    expect(sent[0]!.body.user).toEqual({ id: 'viewer' });
  });

  it('sends the self-declared block once a configured source has resolved to nothing', () => {
    // A provider that answers null — an anonymous viewer. That is the one
    // answer the holder treats as "nobody is coming" (round-3 finding 2: a
    // throw or a timeout is a FAILURE, not an answer, and keeps the block
    // withheld), and the self-declared claim is then the only identity this
    // session will ever have. Withholding it forever would be a worse bug
    // than the twin.
    const { sent } = make({
      identity: () => ({ tokenPending: false, user: { id: 'viewer' } }),
    });
    expect(sent[0]!.body.user).toEqual({ id: 'viewer' });
  });

  it('still sends the block when a token IS readable alongside it', () => {
    // A summary that HAS a token has nothing to wait for: the server prefers
    // the verified credential, so the block beside it cannot mint a twin.
    const { sent } = make({
      identity: () => ({ token: 'tok', tokenPending: true, user: { id: 'viewer' } }),
    });
    expect(sent[0]!.body.user).toEqual({ id: 'viewer' });
  });

  // ROUND 3, finding 2 — the same twin, from an EXPIRING cache rather than a
  // cold one, and with a provider that never fails. Collection starts while
  // the cached token sits inside `IDENTITY_REFRESH_MARGIN_MS`: `peek()` is
  // null, so the first summary carries no token, and round 2's latched
  // "already settled" answer let the self-declared block out beside it. The
  // refresh then landed and the next summary presented the token — two
  // identities for one session. Driven through the REAL holder, since the bug
  // lived in exactly the interaction between `peek()` and the pending flag.
  it('ROUND 3: an expiring cache at collection start still yields ONE identity', async () => {
    const start = 1_700_000_000_000;
    let clock = start;
    const holder = new IdentityTokenHolder();
    holder.set(() => jwtExpiringAt(clock / 1000 + 300));
    await holder.get(clock); // a live page, already warmed
    clock += 280_000; // …and now inside the refresh margin
    expect(holder.peek(clock)).toBeNull();

    const tokenAtSend: Array<string | undefined> = [];
    const { c, sent, tick } = make({
      now: () => clock,
      identity: () => {
        const token = holder.peek(clock) ?? undefined;
        tokenAtSend.push(token);
        return {
          ...(token !== undefined ? { token } : {}),
          ...(holder.hasUnresolvedSource(clock) ? { tokenPending: true } : {}),
          user: { id: 'viewer' },
        };
      },
      warmIdentity: () => {
        void holder.get(clock);
      },
    });

    // The construction summary: no token, and — the fix — no user block.
    expect('user' in sent[0]!.body).toBe(false);

    for (let i = 0; i < 8; i++) await Promise.resolve(); // the refresh lands
    for (let i = 0; i < 250; i++) c.recordPlayerEvent({ t: clock + i, type: 'play' });
    clock += 30_000;
    tick(30_000);

    const summaries = sent.filter((x) => x.body.kind === 'summary');
    expect(summaries.length).toBeGreaterThanOrEqual(2);
    expect(summaries[1]!.body.user).toEqual({ id: 'viewer' });
    // THE PROPERTY: not one summary in this session claims a person it cannot
    // also prove — which is the only shape that mints an unverified row.
    expect(tokenAtSend).toHaveLength(summaries.length);
    expect(
      summaries.filter((x, k) => 'user' in x.body && tokenAtSend[k] === undefined),
    ).toHaveLength(0);
  });

  // ROUND 5 — THE KNOWN COST OF THE STATELESS RULE, pinned end-to-end. A host
  // that leaves an identity token source wired for a SIGNED-OUT viewer gets
  // anonymous summaries, not unverified ones: the holder has no usable token,
  // so the collector withholds the self-declared block on every summary.
  //
  // Rounds 2-4 instead tried to detect "this provider has answered nobody" and
  // release the block after it. Four waves, four regressions, every one of
  // them releasing the block while a real token existed or was about to. The
  // trade is now taken deliberately: invariant 1 prefers anonymity to a
  // persistent unverified twin, and the host opts out explicitly (below).
  it('ROUND 5: a wired-but-signed-out provider keeps every summary anonymous', async () => {
    const NOW = 1_700_000_000_000;
    const holder = new IdentityTokenHolder();
    holder.set(() => null); // signed out, but the source stays configured

    const { c, sent, tick } = make({
      warmIdentity: () => {
        void holder.get(NOW).catch(() => undefined);
      },
      identity: () => ({
        ...(holder.hasUnresolvedSource(NOW) ? { tokenPending: true } : {}),
        user: { id: 'viewer' },
      }),
    });

    expect('user' in sent[0]!.body).toBe(false);
    await vi.advanceTimersByTimeAsync(0); // the provider answers "nobody"

    // SAMPLES, not player events: a sample accumulates without being
    // transported, so the periodic summary is assembled by the flush tick
    // itself — in the SAME synchronous turn as that tick's `warmIdentity()`.
    // This is the shape that made every earlier flag flap.
    for (let round = 0; round < 3; round++) {
      c.recordSample({ t: NOW + round, mem: 1_000 });
      for (let i = 0; i < 5; i++) tick(30_000); // summaryEveryChunks
      await vi.advanceTimersByTimeAsync(0);
    }

    const summaries = sent.filter((x) => x.body.kind === 'summary');
    expect(summaries.length).toBeGreaterThan(1);
    // Anonymous throughout, and — the part that actually matters — not one
    // summary claims a person it cannot also prove.
    expect(summaries.every((x) => !('user' in x.body))).toBe(true);
  });

  // …and the opt-out, which is the API a host already has: tell the SDK there
  // is nobody signed in instead of leaving a provider wired that says so. The
  // verified tier is then not in play at all and the self-declared population
  // — the whole point of the unverified tier — is unaffected.
  it('ROUND 5: setIdentityToken(null) frees the self-declared block again', async () => {
    const NOW = 1_700_000_000_000;
    const holder = new IdentityTokenHolder();
    holder.set(null); // the host says: nobody is signed in

    const { c, sent, tick } = make({
      warmIdentity: () => {
        void holder.get(NOW).catch(() => undefined);
      },
      identity: () => ({
        ...(holder.hasUnresolvedSource(NOW) ? { tokenPending: true } : {}),
        user: { id: 'viewer' },
      }),
    });

    expect(sent[0]!.body.user).toEqual({ id: 'viewer' });
    await vi.advanceTimersByTimeAsync(0);

    for (let round = 0; round < 3; round++) {
      c.recordSample({ t: NOW + round, mem: 1_000 });
      for (let i = 0; i < 5; i++) tick(30_000);
      await vi.advanceTimersByTimeAsync(0);
    }

    const summaries = sent.filter((x) => x.body.kind === 'summary');
    expect(summaries.length).toBeGreaterThan(1);
    expect(summaries.every((x) => x.body.user?.id === 'viewer')).toBe(true);
  });

  // ROUND 4, finding 5 — the two-read disagreement, at the seam that now owns
  // the read. The collector used to stamp `user` from its own read and the
  // transport pulled the token from a second one; with the cached token
  // 30,001 ms from the margin, one millisecond between those reads produced a
  // body claiming Alice with NO credential beside it — an unverified person
  // where a verified one was intended. One read per summary is the fix, so the
  // assertion is exactly that: called once, and both halves travel together.
  it('ROUND 4: reads identity ONCE per summary — the token travels with the body that claims it', async () => {
    const start = 1_700_000_000_000;
    const holder = new IdentityTokenHolder();
    const jwt = jwtExpiringAt(start / 1000 + 300);
    holder.set(jwt);
    await holder.get(start);

    // The instant the reviewer used: `exp - at` is 30,001 ms on the first
    // read and 30,000 on the very next one, so a SECOND read would see the
    // cache inside `IDENTITY_REFRESH_MARGIN_MS` and hand back nothing.
    let at = start + 300_000 - 30_001;
    let reads = 0;
    const { sent } = make({
      now: () => at,
      identity: () => {
        reads++;
        const token = holder.peek(at) ?? undefined;
        at += 1; // any second read of this snapshot would already disagree
        return { ...(token !== undefined ? { token } : {}), user: { id: 'alice' } };
      },
    });

    expect(reads).toBe(1);
    expect(sent[0]!.body.user).toEqual({ id: 'alice' });
    expect(sent[0]!.token).toBe(jwt);
  });
});
