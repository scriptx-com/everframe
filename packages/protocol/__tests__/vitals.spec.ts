// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import { describe, expect, it } from 'vitest';
import {
  VitalsChunk, SessionSummary, VitalsIngestRequest,
  VitalsEntry, VitalsCustomEntry, MAX_CUSTOM_DATA_BYTES, utf8ByteLength,
} from '../src/index.js';

const SID = '3b2e2f9a-1111-4222-8333-944444444444';

describe('vitals wire shapes', () => {
  it('round-trips a chunk with both entry kinds', () => {
    const chunk = {
      kind: 'chunk', sessionId: SID, seq: 0,
      entries: [
        { kind: 'sample', t: 1756700000000, mem: 52428800, extras: { longTaskMs: 12, loopLagMs: 3 } },
        { kind: 'player', t: 1756700000500, type: 'buffer_start' },
        { kind: 'player', t: 1756700002500, type: 'buffer_end', data: { durationMs: 2000 } },
      ],
    };
    expect(VitalsChunk.parse(chunk)).toEqual(chunk);
  });

  it('rejects an unknown player event type', () => {
    expect(() => VitalsChunk.parse({
      kind: 'chunk', sessionId: SID, seq: 1,
      entries: [{ kind: 'player', t: 1, type: 'explode' }],
    })).toThrow();
  });

  // Codex round-2 finding R4 — `seq` is capped at 1,000,000 (24h at the
  // SDK's ~30s flush cadence is ~2,880 chunks; this is generous headroom
  // while keeping `seq + 1` — the chunk-count high-water mark written to an
  // int4 DB column — far inside int32 range). A malformed/hostile seq near
  // Number.MAX_SAFE_INTEGER must 400 at the schema boundary, never reach the
  // blob store.
  it('rejects a seq above the 1,000,000 cap', () => {
    expect(() => VitalsChunk.parse({
      kind: 'chunk', sessionId: SID, seq: 1_000_001,
      entries: [{ kind: 'sample', t: 1, mem: 0 }],
    })).toThrow();
    expect(VitalsChunk.parse({
      kind: 'chunk', sessionId: SID, seq: 1_000_000,
      entries: [{ kind: 'sample', t: 1, mem: 0 }],
    }).seq).toBe(1_000_000);
  });

  it('round-trips a summary and enforces dims', () => {
    const summary = {
      kind: 'summary', sessionId: SID, final: true, startedAt: 1756700000000,
      durationMs: 60000, playtimeMs: 48000, startupTimeMs: 850,
      rebufferCount: 2, rebufferDurationMs: 3200, bitrateMean: 4800000,
      errorCount: 0, memPeak: 94371840, memAvg: 61000000,
      dims: { platform: 'web', appVersion: '2.4.0', sdkVersion: '0.6.6' },
    };
    expect(SessionSummary.parse(summary)).toEqual(summary);
    expect(() => SessionSummary.parse({ ...summary, dims: undefined })).toThrow();
  });

  // Codex round-2 finding R4 — durationMs/playtimeMs/startupTimeMs/
  // rebufferCount/rebufferDurationMs/errorCount are `integer` (int4, max
  // 2,147,483,647) columns in vitals_sessions; memPeak/memAvg/bitrateMean
  // must stay within Number.MAX_SAFE_INTEGER once round-tripped through the
  // DB driver. A summary exceeding any of these bounds must 400, never
  // silently overflow the write.
  it('rejects a summary field above its DB-backed bound', () => {
    const base = {
      kind: 'summary' as const, sessionId: SID, final: true, startedAt: 1,
      durationMs: 0, playtimeMs: 0, startupTimeMs: null,
      rebufferCount: 0, rebufferDurationMs: 0, bitrateMean: null,
      errorCount: 0, memPeak: 0, memAvg: 0,
      dims: { platform: 'web' as const, appVersion: '1', sdkVersion: '1' },
    };
    const OVER_INT32 = 2_147_483_648;
    for (const field of [
      'durationMs', 'playtimeMs', 'startupTimeMs', 'rebufferCount',
      'rebufferDurationMs', 'errorCount',
    ] as const) {
      expect(() => SessionSummary.parse({ ...base, [field]: OVER_INT32 })).toThrow();
    }
    const OVER_SAFE = Number.MAX_SAFE_INTEGER + 2;
    for (const field of ['memPeak', 'memAvg', 'bitrateMean'] as const) {
      expect(() => SessionSummary.parse({ ...base, [field]: OVER_SAFE })).toThrow();
    }
  });

  // Codex round-2 finding R4 — the four fields that gained `.int()`
  // (durationMs/playtimeMs/startupTimeMs/rebufferDurationMs — accumulated
  // from clock arithmetic, unlike rebufferCount/errorCount which were
  // already integer counts) must reject a fractional value: the SDK's
  // summary accumulator now rounds before returning (see
  // sdk-core/src/vitals/summary.ts), so a fractional value reaching this
  // schema indicates something upstream did NOT round.
  it('rejects a fractional value on the newly-.int() fields', () => {
    const base = {
      kind: 'summary' as const, sessionId: SID, final: true, startedAt: 1,
      durationMs: 0, playtimeMs: 0, startupTimeMs: null,
      rebufferCount: 0, rebufferDurationMs: 0, bitrateMean: null,
      errorCount: 0, memPeak: 0, memAvg: 0,
      dims: { platform: 'web' as const, appVersion: '1', sdkVersion: '1' },
    };
    for (const field of ['durationMs', 'playtimeMs', 'rebufferDurationMs'] as const) {
      expect(() => SessionSummary.parse({ ...base, [field]: 1.5 })).toThrow();
    }
    expect(() => SessionSummary.parse({ ...base, startupTimeMs: 1.5 })).toThrow();
  });

  it('discriminates the ingest request wrapper on payload.kind', () => {
    const req = { apiKey: 'txx_live_x', payload: { kind: 'summary', sessionId: SID, final: false, startedAt: 1, durationMs: 0, playtimeMs: 0, startupTimeMs: null, rebufferCount: 0, rebufferDurationMs: 0, bitrateMean: null, errorCount: 0, memPeak: 0, memAvg: 0, dims: { platform: 'web', appVersion: '1', sdkVersion: '1' } } };
    expect(VitalsIngestRequest.parse(req).payload.kind).toBe('summary');
  });
});

describe('phase 4 — player identity, new event types, custom entries', () => {
  it('accepts playerId and the five new player event types', () => {
    const chunk = {
      kind: 'chunk', sessionId: SID, seq: 2,
      entries: [
        { kind: 'player', t: 1, type: 'player_attach', playerId: 'p1', data: { tag: 'video', library: 'hls.js', libraryVersion: '1.5.0', name: 'main' } },
        { kind: 'player', t: 2, type: 'drm', playerId: 'p1', data: { keySystem: 'com.widevine.alpha', licenseMs: 120 } },
        { kind: 'player', t: 3, type: 'quality_change', playerId: 'p1', data: { width: 1280, height: 720 } },
        { kind: 'player', t: 4, type: 'stats', playerId: 'p1', data: { bufferAheadMs: 12000, droppedFrames: 0, bitrate: 3_000_000 } },
        { kind: 'player', t: 5, type: 'player_detach', playerId: 'p1' },
      ],
    };
    expect(VitalsChunk.parse(chunk)).toEqual(chunk);
  });

  it('rejects a playerId over 32 chars or empty', () => {
    expect(() => VitalsEntry.parse({ kind: 'player', t: 1, type: 'play', playerId: 'x'.repeat(33) })).toThrow();
    expect(() => VitalsEntry.parse({ kind: 'player', t: 1, type: 'play', playerId: '' })).toThrow();
  });

  it('accepts a custom entry with data under the cap, with and without playerId', () => {
    const a = { kind: 'custom', t: 10, name: 'cdn.switch', data: { from: 'edge-a', to: 'edge-b' }, playerId: 'p2' };
    const b = { kind: 'custom', t: 11, name: 'login' };
    expect(VitalsEntry.parse(a)).toEqual(a);
    expect(VitalsEntry.parse(b)).toEqual(b);
  });

  it('rejects custom data whose serialised size is over MAX_CUSTOM_DATA_BYTES, measured in UTF-8 bytes', () => {
    const ok = { kind: 'custom', t: 1, name: 'n', data: 'x'.repeat(MAX_CUSTOM_DATA_BYTES - 2) }; // 2 quote bytes
    const over = { kind: 'custom', t: 1, name: 'n', data: 'x'.repeat(MAX_CUSTOM_DATA_BYTES - 1) };
    const multibyte = { kind: 'custom', t: 1, name: 'n', data: 'é'.repeat(MAX_CUSTOM_DATA_BYTES / 2) }; // 2 bytes each + quotes → over
    expect(VitalsCustomEntry.parse(ok)).toEqual(ok);
    expect(() => VitalsCustomEntry.parse(over)).toThrow();
    expect(() => VitalsCustomEntry.parse(multibyte)).toThrow();
  });

  it('rejects an empty or over-long custom name', () => {
    expect(() => VitalsCustomEntry.parse({ kind: 'custom', t: 1, name: '' })).toThrow();
    expect(() => VitalsCustomEntry.parse({ kind: 'custom', t: 1, name: 'n'.repeat(65) })).toThrow();
  });

  it('still parses a phase-3 chunk: no playerId, no custom entries, and a summary without playerCount', () => {
    const chunk = {
      kind: 'chunk', sessionId: SID, seq: 0,
      entries: [
        { kind: 'sample', t: 1, mem: 1 },
        { kind: 'player', t: 2, type: 'source_change' },
        { kind: 'player', t: 3, type: 'dropped_frames', data: { count: 3 } },
      ],
    };
    expect(VitalsChunk.parse(chunk)).toEqual(chunk);
    const summary = {
      kind: 'summary', sessionId: SID, final: false, startedAt: 1, durationMs: 1, playtimeMs: 0,
      startupTimeMs: null, rebufferCount: 0, rebufferDurationMs: 0, bitrateMean: null, errorCount: 0,
      memPeak: 0, memAvg: 0, dims: { platform: 'web', appVersion: '1', sdkVersion: '1' },
    };
    expect(SessionSummary.parse(summary)).toEqual(summary);
    expect(SessionSummary.parse({ ...summary, playerCount: 2 }).playerCount).toBe(2);
    expect(() => SessionSummary.parse({ ...summary, playerCount: -1 })).toThrow();
    // Codex round-6 item 3 — `seq` is optional on the wire (a phase-3 SDK
    // predates it entirely, same as `playerCount` above) and capped the same
    // as `VitalsChunk.seq` above.
    expect(SessionSummary.parse(summary).seq).toBeUndefined();
    expect(SessionSummary.parse({ ...summary, seq: 5 }).seq).toBe(5);
    expect(() => SessionSummary.parse({ ...summary, seq: -1 })).toThrow();
    expect(() => SessionSummary.parse({ ...summary, seq: 1_000_001 })).toThrow();
    expect(SessionSummary.parse({ ...summary, seq: 1_000_000 }).seq).toBe(1_000_000);
  });
});

describe('utf8ByteLength — agrees with TextEncoder', () => {
  // Fix round (Codex review of task 1) — the surrogate branch used to count
  // 4 bytes and skip ahead for ANY high surrogate, including an unpaired
  // one, silently swallowing the next code unit without ever counting its
  // bytes. Comparing against `TextEncoder` directly (rather than hard-coding
  // expected byte counts) states the actual contract this helper must meet,
  // not a restatement of its own implementation — so a future edit that
  // reintroduces the bug fails here even if nobody updates a hand-picked
  // number.
  const encoder = new TextEncoder();
  const cases: Array<[string, string]> = [
    ['empty string', ''],
    ['plain ASCII', 'hello world'],
    ['2-byte character', 'é'],
    ['3-byte CJK character', '中'],
    ['4-byte astral character (emoji)', '😀'],
    ['lone high surrogate', '\ud800'],
    ['lone low surrogate', '\udc00'],
    // The exact case the finding flagged: a bare high surrogate immediately
    // followed by another character used to consume that character's code
    // unit via the surrogate branch's `i++` and never count its bytes.
    ['lone high surrogate followed by a 2-byte character', '\ud800é'],
    ['well-formed surrogate pair', '😀'],
  ];

  for (const [label, s] of cases) {
    it(`matches TextEncoder for: ${label}`, () => {
      expect(utf8ByteLength(s)).toBe(encoder.encode(s).length);
    });
  }
});

describe('SessionSummary.user (self-declared identity)', () => {
  // Deviation from the brief's literal fixture: the brief's `base` omitted
  // playtimeMs/startupTimeMs/rebufferCount/rebufferDurationMs/bitrateMean/
  // errorCount/memPeak/memAvg, which are NOT optional on SessionSummary (see
  // the codex round-2 finding R4 comment above the schema) — so it failed to
  // parse regardless of the `user` block, for reasons unrelated to identity.
  // Filled in with the same zero/null values the existing phase-3 fixture
  // above uses, so these cases actually isolate the `user` attribute.
  const base = {
    kind: 'summary' as const,
    sessionId: '00000000-0000-4000-8000-000000000001',
    final: false,
    startedAt: 1_700_000_000_000,
    durationMs: 1000,
    playtimeMs: 0,
    startupTimeMs: null,
    rebufferCount: 0,
    rebufferDurationMs: 0,
    bitrateMean: null,
    errorCount: 0,
    memPeak: 0,
    memAvg: 0,
    dims: { platform: 'web' as const, appVersion: '1', sdkVersion: '1' },
  };

  it('accepts a summary with no user block at all', () => {
    expect(SessionSummary.safeParse(base).success).toBe(true);
  });

  it('accepts id, email and displayName', () => {
    const r = SessionSummary.safeParse({
      ...base,
      user: { id: 'u-1', email: 'a@b.com', displayName: 'Ada' },
    });
    expect(r.success).toBe(true);
  });

  it('accepts a partial user block', () => {
    expect(SessionSummary.safeParse({ ...base, user: { email: 'a@b.com' } }).success).toBe(true);
  });

  // Adversarial review of PR #218, finding 4 — REVERSED from "rejects": a
  // malformed identity block must cost the ATTRIBUTION, never the summary.
  // `user: 'ada'` (and `user: null`, below) now parses to an ABSENT block, so
  // the dims and metrics beside it still reach the session row; ingest's
  // `normalizeSelfDeclaredUser` resolves it anonymous. Invariant 2 of the
  // design spec (the public behavior contract).
  it('degrades a non-object user to an absent block instead of rejecting the summary', () => {
    const r = SessionSummary.safeParse({ ...base, user: 'ada' });
    expect(r.success).toBe(true);
    expect(r.data!.user).toBeUndefined();
    expect(r.data!.durationMs).toBe(1000);
  });

  it('degrades user: null the same way — the shape a host gets from `user ?? null`', () => {
    const r = SessionSummary.safeParse({ ...base, user: null });
    expect(r.success).toBe(true);
    expect(r.data!.user).toBeUndefined();
    expect(r.data!.durationMs).toBe(1000);
  });

  // Per-ATTRIBUTE tolerance, not just per-block: an untyped JS host passing a
  // numeric id keeps whatever else it declared, and the summary is untouched.
  it('drops a non-string attribute and keeps the rest of the block', () => {
    const r = SessionSummary.safeParse({
      ...base,
      user: { id: 123, email: 'a@b.com', displayName: null },
    });
    expect(r.success).toBe(true);
    expect(r.data!.user).toEqual({ email: 'a@b.com' });
    expect(r.data!.memPeak).toBe(0);
  });

  it('keeps a summary whose only identity attribute is malformed', () => {
    const r = SessionSummary.safeParse({ ...base, user: { id: 123 } });
    expect(r.success).toBe(true);
    expect(r.data!.user).toEqual({});
    expect(r.data!.durationMs).toBe(1000);
  });

  // Ruling R2 overrides the brief here: SessionSummaryUser is deliberately
  // UNBOUNDED, mirroring envelope.ts's `reporter.user`. Rejecting the whole
  // summary over one long identity attribute would cost ingest the row's
  // dims and metrics too, not just the identity claim — the normalizer at
  // the server self-declared identity contract drops an over-long value
  // at storage time instead.
  it('accepts an over-long attribute rather than rejecting the summary', () => {
    const r = SessionSummary.safeParse({ ...base, user: { id: 'x'.repeat(4096) } });
    expect(r.success).toBe(true);
  });
});

describe('VitalsIngestRequest.identityToken', () => {
  it('parses and is not stripped', () => {
    const summary = {
      kind: 'summary' as const,
      sessionId: '00000000-0000-4000-8000-000000000001',
      final: false,
      startedAt: 1_700_000_000_000,
      durationMs: 1000,
      playtimeMs: 0,
      startupTimeMs: null,
      rebufferCount: 0,
      rebufferDurationMs: 0,
      bitrateMean: null,
      errorCount: 0,
      memPeak: 0,
      memAvg: 0,
      dims: { platform: 'web' as const, appVersion: '1', sdkVersion: '1' },
    };
    const r = VitalsIngestRequest.safeParse({
      payload: summary,
      identityToken: 'tok-123',
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.identityToken).toBe('tok-123');
  });

  const summaryFixture = {
    kind: 'summary' as const,
    sessionId: '00000000-0000-4000-8000-000000000001',
    final: false,
    startedAt: 1_700_000_000_000,
    durationMs: 1000,
    playtimeMs: 0,
    startupTimeMs: null,
    rebufferCount: 0,
    rebufferDurationMs: 0,
    bitrateMean: null,
    errorCount: 0,
    memPeak: 0,
    memAvg: 0,
    dims: { platform: 'web' as const, appVersion: '1', sdkVersion: '1' },
  };

  // Adversarial review of PR #218, finding 4 — `identityToken: null` (what a
  // host's `token ?? null` produces) used to 400 the whole envelope, losing
  // the summary's dims and metrics over an identity field. The payload now
  // survives every wrong type.
  //
  // Round-2 finding 2 — and it degrades to `''`, NOT to `undefined`. The two
  // are not interchangeable downstream: `undefined` means "no token was
  // presented", which is the ONE condition under which ingest consults the
  // unverified self-declared `user` block. Catching a malformed token to
  // `undefined` therefore turned `identityToken: ['invalid.token.value']`
  // alongside a `user` block into a minted unverified person — the fallback
  // the design spec's invariant 1 forbids. `''` says "something was presented"
  // and resolves anonymous with no fallback, while the payload still lands.
  it.each([
    ['null', null],
    ['an array', ['invalid.token.value']],
    ['an object', { token: 'x' }],
    ['a number', 42],
    ['a boolean', true],
  ])('degrades %s identityToken to a PRESENTED-but-empty token, keeping the payload', (_label, value) => {
    const r = VitalsIngestRequest.safeParse({ payload: summaryFixture, identityToken: value });
    expect(r.success).toBe(true);
    expect(r.success && r.data.identityToken).toBe('');
    expect(r.success && r.data.payload.kind).toBe('summary');
    // And the metrics are intact — invariant 2.
    expect(r.success && r.data.payload.kind === 'summary' && r.data.payload.durationMs).toBe(1000);
  });

  // The other half of the same distinction: an ABSENT field must still parse
  // as `undefined` (the self-declared block stays reachable for the hosts that
  // never set a token at all). `.optional()` runs before the catch, so the
  // catch is never reached here.
  it('leaves a genuinely absent identityToken undefined, never catching it to a presentation', () => {
    const r = VitalsIngestRequest.safeParse({ payload: summaryFixture });
    expect(r.success).toBe(true);
    expect(r.success && r.data.identityToken).toBeUndefined();

    const explicit = VitalsIngestRequest.safeParse({
      payload: summaryFixture,
      identityToken: undefined,
    });
    expect(explicit.success).toBe(true);
    expect(explicit.success && explicit.data.identityToken).toBeUndefined();
  });
});
