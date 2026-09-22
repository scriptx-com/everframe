// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// Session Vitals wiring (web) — setupVitals()'s config gate, start/stop
// lifecycle, the __getActiveVitals() box draft-to-envelope reads, and
// adapter.ts's applyLiveConfig writing the vitals server-config box. The
// resource sampler, player adapter, and transport are Tasks 5/6/7's own
// factories, each already unit-tested in their own spec file — this suite
// mocks them so it isolates the ORCHESTRATION setupVitals owns: the
// once-per-session sampling draw, start/stop sequencing, the pagehide flush,
// and destroy() idempotency (a box-flip stop followed by init teardown must
// not double-send the final summary).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, IdentityTokenHolder, IDENTITY_TOKEN_MAX_CHARS } from '@traceitx/sdk-core';
import { MAX_ENVELOPE_VITALS_ENTRIES, MAX_CUSTOM_NAME_LENGTH } from '@traceitx/protocol';
import type { ReportDraft } from '@traceitx/sdk-core';
import { createWebPlatformAdapter, type WebPlatformAdapter } from '../../src/adapter.js';
import {
  __getVitalsServerConfig,
  __setVitalsServerConfig,
} from '../../src/vitals/server-config.js';
import type { WebTraceItXConfig } from '../../src/internal/types.js';

interface SampleDeps {
  onSample(s: { t: number; mem: number; extras: Record<string, number> }): void;
}
interface PlayerDeps {
  onEvent(e: { t: number; type: string; data?: Record<string, unknown> }): void;
}

const {
  sendSpy,
  samplerStopSpy,
  playerStopSpy,
  sampleQualitySpy,
  reseedSpy,
  trackPlayerSpy,
  untrackPlayerSpy,
  startResourceSamplerMock,
  attachPlayerVitalsMock,
  createVitalsTransportMock,
} = vi.hoisted(() => ({
  sendSpy: vi.fn(),
  samplerStopSpy: vi.fn(),
  playerStopSpy: vi.fn(),
  sampleQualitySpy: vi.fn(),
  reseedSpy: vi.fn(),
  trackPlayerSpy: vi.fn(),
  untrackPlayerSpy: vi.fn(),
  startResourceSamplerMock: vi.fn(),
  attachPlayerVitalsMock: vi.fn(),
  createVitalsTransportMock: vi.fn(),
}));

vi.mock('../../src/vitals/resource-sampler.js', () => ({
  startResourceSampler: startResourceSamplerMock,
}));
vi.mock('../../src/vitals/player-adapter.js', () => ({
  attachPlayerVitals: attachPlayerVitalsMock,
}));
vi.mock('../../src/vitals/transport.js', () => ({
  createVitalsTransport: createVitalsTransportMock,
}));

// Imported AFTER the mocks above so setupVitals resolves the mocked modules.
import {
  setupVitals,
  __getActiveVitals,
  trackPlayer,
  trackVitals,
  __resetVitalsForTests,
} from '../../src/vitals/index.js';
import { draftToEnvelope, type CaptureBundle } from '../../src/transport/draft-to-envelope.js';

let onSample: SampleDeps['onSample'] | undefined;
let onEvent: PlayerDeps['onEvent'] | undefined;
let adapterDeps:
  | (PlayerDeps & {
      playerIdFor?: (el: HTMLMediaElement) => string;
      registered?: Iterable<unknown>;
      keepSourceQuery?: boolean;
      userDetached?: WeakSet<HTMLMediaElement>;
    })
  | undefined;

function baseConfig(overrides?: Partial<WebTraceItXConfig>): WebTraceItXConfig {
  return { apiKey: 'k', appVersion: '1.2.3', ...overrides };
}

function baseDeps(overrides?: Partial<WebTraceItXConfig>) {
  return {
    config: baseConfig(overrides),
    apiKey: 'test-key',
    apiUrl: 'https://ingest.test',
    isKilled: () => false,
    sdkVersion: '9.9.9',
  };
}

function isFinalSummary(call: unknown[]): boolean {
  const body = call[0] as { kind?: string; final?: boolean } | undefined;
  return body?.kind === 'summary' && body?.final === true;
}

beforeEach(() => {
  onSample = undefined;
  onEvent = undefined;
  adapterDeps = undefined;
  __setVitalsServerConfig(undefined);
  __resetVitalsForTests();

  sendSpy.mockReset();
  samplerStopSpy.mockReset();
  playerStopSpy.mockReset();
  sampleQualitySpy.mockReset();
  reseedSpy.mockReset();
  trackPlayerSpy.mockReset();
  untrackPlayerSpy.mockReset();

  startResourceSamplerMock.mockReset().mockImplementation((deps: SampleDeps) => {
    onSample = deps.onSample;
    return samplerStopSpy;
  });
  attachPlayerVitalsMock.mockReset().mockImplementation((deps: PlayerDeps) => {
    onEvent = deps.onEvent;
    adapterDeps = deps as typeof adapterDeps;
    return {
      trackPlayer: trackPlayerSpy.mockReturnValue('p1'),
      // Task 4 added `untrackPlayer` to the real adapter's interface; task 7
      // (the player registry) is what actually exercises it.
      untrackPlayer: untrackPlayerSpy,
      sampleQuality: sampleQualitySpy,
      // Codex round-3 finding F3 — the real reseed() re-emits a synthetic
      // `play`/`buffer_start` per ongoing element; this mock stands in for
      // "at least one element was playing" so tests can assert setupVitals
      // actually wires `onRotate` through to it.
      reseed: reseedSpy.mockImplementation(() => {
        onEvent?.({ t: Date.now(), type: 'play' });
      }),
      stop: playerStopSpy,
    };
  });
  createVitalsTransportMock.mockReset().mockReturnValue(sendSpy);
});

afterEach(() => {
  __setVitalsServerConfig(undefined);
  __resetVitalsForTests();
  vi.restoreAllMocks();
});

describe('setupVitals — config gate', () => {
  it('does not start until the server config box says vitalsEnabled: true', () => {
    const handle = setupVitals(baseDeps());
    expect(__getActiveVitals()).toBeUndefined();
    expect(createVitalsTransportMock).not.toHaveBeenCalled();
    handle.destroy();
  });

  it('starts once the box flips to vitalsEnabled: true and the sampling draw passes', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const handle = setupVitals(baseDeps());
    expect(__getActiveVitals()).toBeUndefined();

    __setVitalsServerConfig({ vitalsEnabled: true, vitalsSampleRate: 1 });

    expect(__getActiveVitals()).toBeDefined();
    expect(createVitalsTransportMock).toHaveBeenCalledTimes(1);
    handle.destroy();
  });

  it('local config.vitals.enabled === false wins over server true — never starts', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const handle = setupVitals(baseDeps({ vitals: { enabled: false } }));

    __setVitalsServerConfig({ vitalsEnabled: true, vitalsSampleRate: 1 });

    expect(__getActiveVitals()).toBeUndefined();
    expect(createVitalsTransportMock).not.toHaveBeenCalled();
    handle.destroy();
  });
});

describe('setupVitals — sampling draw', () => {
  it('draws once against min(localRate, serverRate); a losing draw stays lost even after a later refresh raises the rate', () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const handle = setupVitals(baseDeps({ vitals: { sampleRate: 0.5 } }));

    // effective rate = min(0.5, 0.2) = 0.2; 0.9 is NOT < 0.2 -> lost.
    __setVitalsServerConfig({ vitalsEnabled: true, vitalsSampleRate: 0.2 });
    expect(__getActiveVitals()).toBeUndefined();
    expect(randomSpy).toHaveBeenCalledTimes(1);

    // Refresh raises the server rate so a fresh draw WOULD pass (0.9 < 1) —
    // but the draw must not re-roll, so it stays not-started.
    __setVitalsServerConfig({ vitalsEnabled: true, vitalsSampleRate: 1 });
    expect(__getActiveVitals()).toBeUndefined();
    expect(randomSpy).toHaveBeenCalledTimes(1);

    handle.destroy();
  });

  it('a winning draw is not re-rolled either — subsequent refreshes are no-ops', () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.05);
    const handle = setupVitals(baseDeps());

    __setVitalsServerConfig({ vitalsEnabled: true, vitalsSampleRate: 0.1 });
    expect(__getActiveVitals()).toBeDefined();
    expect(randomSpy).toHaveBeenCalledTimes(1);

    __setVitalsServerConfig({ vitalsEnabled: true, vitalsSampleRate: 0.5 });
    expect(randomSpy).toHaveBeenCalledTimes(1); // still just the one draw

    handle.destroy();
  });
});

describe('setupVitals — start wiring', () => {
  it('wires transport -> collector -> resource sampler -> player adapter; pagehide flushes with beacon:true', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const handle = setupVitals(baseDeps());

    __setVitalsServerConfig({ vitalsEnabled: true, vitalsSampleRate: 1 });

    expect(createVitalsTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'https://ingest.test/api/ingest/vitals',
        apiKey: 'test-key',
      }),
    );

    // Collector creation sends an initial non-final summary synchronously —
    // assert the dims it was built with.
    expect(sendSpy).toHaveBeenCalled();
    const firstBody = sendSpy.mock.calls[0]![0] as {
      kind: string;
      dims: { platform: string; appVersion: string; sdkVersion: string };
    };
    expect(firstBody.kind).toBe('summary');
    expect(firstBody.dims).toEqual({ platform: 'web', appVersion: '1.2.3', sdkVersion: '9.9.9' });

    // Resource sampler wiring: onSample -> recordSample; same tick -> sampleQuality.
    expect(onSample).toBeDefined();
    onSample!({ t: Date.now(), mem: 2048, extras: { longTaskMs: 0, loopLagMs: 0 } });
    expect(sampleQualitySpy).toHaveBeenCalledTimes(1);

    // Player adapter wiring: onEvent -> recordPlayerEvent (no assertion needed
    // beyond "does not throw" — recorded state is asserted via recent() below).
    // Real (not synthetic) timestamps: recent()'s ring prunes against a
    // Date.now()-relative cutoff, so a hardcoded small `t` would be pruned
    // immediately.
    expect(onEvent).toBeDefined();
    onEvent!({ t: Date.now(), type: 'play' });
    const active = __getActiveVitals();
    expect(active?.recent().some((e) => e.kind === 'player' && e.type === 'play')).toBe(true);

    // pagehide -> flushNow({ beacon: true }).
    sendSpy.mockClear();
    window.dispatchEvent(new Event('pagehide'));
    expect(sendSpy.mock.calls.some((c) => (c[1] as { beacon?: boolean })?.beacon === true)).toBe(
      true,
    );

    handle.destroy();
  });
});

// Fix round (review, Important) — `packages/sdk-core/src/vitals/collector.ts`
// and `packages/sdk-web/src/vitals/transport.ts` are thoroughly covered in
// their own spec files, but NOTHING previously pinned the `identity:`
// pass-through this file (`vitals/index.ts`'s `maybeStart()`) performs into
// the collector. Deleting the `identity: deps.identity` line left the whole
// suite green while every deployed session would silently revert to anonymous
// — exactly the regression Task 11 exists to prevent.
//
// Round-4 finding 5 moved WHERE that is observable, and these assertions moved
// with it. There is no longer an `identityToken` dep on the transport to
// inspect: the collector reads identity ONCE per summary and hands both halves
// down together, so the token now rides in the send's `opts.identityToken`
// beside the very body whose `user` block came out of the same read. Asserting
// on the send is therefore the stronger test — it pins the pair, which is the
// property that was broken.
describe('setupVitals — identity wiring (Fix round, Important)', () => {
  /**
   * A decodable-looking compact JWS. Shape matters here as of round-3 finding
   * 3: `gateIdentity` refuses anything that is not three base64url segments,
   * because that alphabet is exactly what an HTTP header value may carry — a
   * bare `'tok-abc'` is now (correctly) withheld, which is not what these
   * pass-through assertions are about.
   */
  const jws = (payload: string): string => `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
  const TOK_ABC = jws('tok-abc');

  it('threads deps.identity into the collector — the token rides with the summary it belongs to', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const identity = vi.fn(() => ({ token: TOK_ABC, user: { id: 'u-1', email: 'a@b.com' } }));
    const handle = setupVitals({ ...baseDeps(), identity });

    __setVitalsServerConfig({ vitalsEnabled: true, vitalsSampleRate: 1 });

    // ONE read produced both halves (round-4 finding 5): the transport is
    // handed the token for this exact payload rather than asking the provider
    // a second time, so body and credential can no longer describe two
    // different moments.
    expect(identity).toHaveBeenCalledTimes(1);
    const [body, opts] = sendSpy.mock.calls[0]! as [
      { kind: string; user?: unknown },
      { beacon: boolean; identityToken?: string },
    ];
    expect(body.kind).toBe('summary');
    expect(body.user).toEqual({ id: 'u-1', email: 'a@b.com' });
    expect(opts.identityToken).toBe(TOK_ABC);

    handle.destroy();
  });

  // Round-4 finding 2, at the seam that produced it. A provider handing back a
  // padded-but-perfectly-usable credential (`' ' + jwt + ' '` — a template
  // literal, or a header echoed back with its whitespace) used to be cached by
  // the holder and then refused by the gate, which withheld the `user` block
  // with it: an anonymous session for a token that authenticates fine (native
  // `Request` normalizes surrounding spaces). The gate now TRIMS, and what it
  // hands on is the trimmed value — both halves survive.
  it('accepts a padded token, presents it trimmed, and keeps the user block', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const handle = setupVitals({
      ...baseDeps(),
      identity: () => ({ token: `  ${TOK_ABC}\n`, user: { id: 'u-1' } }),
    });

    __setVitalsServerConfig({ vitalsEnabled: true, vitalsSampleRate: 1 });

    const [body, opts] = sendSpy.mock.calls[0]! as [
      { kind: string; user?: unknown },
      { beacon: boolean; identityToken?: string },
    ];
    expect(opts.identityToken).toBe(TOK_ABC);
    expect(body.user).toEqual({ id: 'u-1' });

    handle.destroy();
  });

  it('threads deps.identity into the collector as identity — visible as `user` on the summary it sends', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const identity = vi.fn(() => ({ token: TOK_ABC, user: { id: 'u-1', email: 'a@b.com' } }));
    const handle = setupVitals({ ...baseDeps(), identity });

    __setVitalsServerConfig({ vitalsEnabled: true, vitalsSampleRate: 1 });

    // The collector is real (only transport/sampler/player-adapter are
    // mocked in this file), so its creation-time summary — sent through the
    // mocked transport's `sendSpy` — is the observable proof the collector
    // actually received and read `deps.identity`.
    expect(sendSpy).toHaveBeenCalled();
    const firstBody = sendSpy.mock.calls[0]![0] as { kind: string; user?: unknown };
    expect(firstBody.kind).toBe('summary');
    expect(firstBody.user).toEqual({ id: 'u-1', email: 'a@b.com' });

    handle.destroy();
  });

  // ROUND-3 FINDINGS 1 AND 3 — THE GATE, pinned at the seam that owns it.
  // Round 2 dropped an unusable token inside the transport, AFTER the summary
  // body had been built, so `summary.user` went out beside no credential and
  // the server minted an UNVERIFIED person: a presented-but-failed identity
  // silently downgraded to the self-declared tier, which invariant 1 forbids.
  // Gating where the provider is READ withholds both halves at once.
  //
  // Both shapes the gate refuses are covered: too long (finding 1) and
  // header-unsafe (finding 3, an embedded newline — `fetch` refuses such a
  // header before sending anything, so it used to cost the whole summary).
  it.each([
    ['an over-long token', `eyJ.${'a'.repeat(IDENTITY_TOKEN_MAX_CHARS)}.sig`],
    ['a header-unsafe token', 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.si\ng'],
  ])('withholds BOTH the token and the user block for %s', (_label, token) => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const handle = setupVitals({
      ...baseDeps(),
      identity: () => ({ token, user: { id: 'u-1', email: 'a@b.com' } }),
    });
    __setVitalsServerConfig({ vitalsEnabled: true, vitalsSampleRate: 1 });

    // The transport never sees the token…
    const opts = sendSpy.mock.calls[0]![1] as { beacon: boolean; identityToken?: string };
    expect(opts.identityToken).toBeUndefined();

    // …and the summary it is asked to send carries no claim either — the
    // session resolves ANONYMOUS, which is the whole point, while the dims and
    // metrics beside it are delivered untouched.
    const firstBody = sendSpy.mock.calls[0]![0] as { kind: string; user?: unknown };
    expect(firstBody.kind).toBe('summary');
    expect('user' in firstBody).toBe(false);

    handle.destroy();
  });

  // Adversarial review of PR #218, finding 1 — THE ACCEPTANCE TEST. The two
  // assertions above pin that `identity()` is wired; neither proves the value
  // it returns is ever non-null in a real install, and it was not: the web
  // wiring reads `IdentityTokenHolder.peek()`, a cache that only the ASYNC
  // `get()` ever fills, and `setIdentityToken()` DROPS that cache. On a fresh
  // browser where the host sets a valid token and the viewer only WATCHES —
  // never filing a report, the whole point of this feature — nothing called
  // `get()` and every summary stayed anonymous.
  //
  // A REAL holder is used here, wired exactly as `init.ts`/`provider.tsx`
  // wire it (a synchronous cache-only read plus a fire-and-forget warm), so
  // deleting `warmIdentity` from either call site fails this test.
  it('a periodic summary carries a configured token even though no report was ever filed', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.useFakeTimers();
    try {
      // A valid, decodable HS256-shaped token expiring well past the holder's
      // 30s refresh margin. The payload is unsigned: the holder only decodes
      // `exp`; verification happens server-side.
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const b64 = (o: unknown): string =>
        btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'ada', exp })}.sig`;

      const holder = new IdentityTokenHolder();
      // The host's own `setIdentityToken(async () => …)` — a provider
      // function, the shape that can only ever be resolved by `get()`.
      holder.set(async () => jwt);

      // Cold, and without a warm it stays cold forever: this is the bug,
      // stated as an assertion.
      expect(holder.peek(Date.now())).toBeNull();

      const handle = setupVitals({
        ...baseDeps(),
        identity: () => {
          const token = holder.peek(Date.now());
          return { ...(token !== null ? { token } : {}) };
        },
        warmIdentity: () => {
          void holder.get(Date.now()).catch(() => undefined);
        },
      });
      __setVitalsServerConfig({ vitalsEnabled: true, vitalsSampleRate: 1 });

      // The construction summary went out before the provider could resolve —
      // accepted and expected (identity adoption is gradual).
      const first = sendSpy.mock.calls[0]![1] as { identityToken?: string };
      expect(first.identityToken).toBeUndefined();

      // The startup warm resolves…
      await vi.advanceTimersByTimeAsync(0);

      // …and from here every summary the collector sends presents the token,
      // with no report ever having been filed. Deleting `warmIdentity` from
      // `init.ts`/`provider.tsx` (or from the collector) fails here.
      sendSpy.mockClear();
      window.dispatchEvent(new Event('pagehide')); // flushNow -> one more summary
      const later = sendSpy.mock.calls.find(
        (c) => (c[0] as { kind?: string }).kind === 'summary',
      )!;
      expect((later[1] as { identityToken?: string }).identityToken).toBe(jwt);
      expect(holder.peek(Date.now())).toBe(jwt);

      handle.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

// Fix I3 (final review): a bare `crypto.randomUUID()` throws in an INSECURE
// context (plain-http TV/LAN rigs), and a throw anywhere in the start
// sequence used to wedge `started` permanently true with no way to retry.
describe('setupVitals — guarded UUID + contained start failure (Fix I3)', () => {
  it('starts and produces a UUID-shaped sessionId even when crypto.randomUUID throws', () => {
    const realCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', {
      subtle: realCrypto.subtle,
      getRandomValues: (arr: Uint8Array) => realCrypto.getRandomValues(arr),
      randomUUID: () => {
        throw new Error('randomUUID is not available in insecure contexts');
      },
    });
    try {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const handle = setupVitals(baseDeps());
      __setVitalsServerConfig({ vitalsEnabled: true, vitalsSampleRate: 1 });

      const active = __getActiveVitals();
      expect(active).toBeDefined();
      expect(active!.sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );

      handle.destroy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a throwing start factory rolls `started` back — no exception escapes, and a later config flip retries successfully', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    // Simulate a broken/hostile injected factory throwing partway through
    // the start sequence — attachPlayerVitals is called AFTER the collector
    // already exists, so this also exercises the collector-teardown half of
    // the rollback.
    attachPlayerVitalsMock.mockImplementationOnce(() => {
      throw new Error('boom');
    });

    const handle = setupVitals(baseDeps());
    expect(() =>
      __setVitalsServerConfig({ vitalsEnabled: true, vitalsSampleRate: 1 }),
    ).not.toThrow();
    // Rolled back — the box must not be left half-populated.
    expect(__getActiveVitals()).toBeUndefined();

    // Retry via a later config flip. The one-time sampling draw already
    // resolved (passed=true), so this does NOT re-roll it — it goes
    // straight back to a start attempt, which this time succeeds
    // (attachPlayerVitalsMock's default beforeEach implementation, since
    // the throwing one was `Once`).
    __setVitalsServerConfig({ vitalsEnabled: false, vitalsSampleRate: 1 });
    __setVitalsServerConfig({ vitalsEnabled: true, vitalsSampleRate: 1 });

    expect(__getActiveVitals()).toBeDefined();
    handle.destroy();
  });
});

describe('setupVitals — stop / destroy', () => {
  it('server config flip to disabled stops the session (final summary sent) and clears the box', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const handle = setupVitals(baseDeps());
    __setVitalsServerConfig({ vitalsEnabled: true, vitalsSampleRate: 1 });
    expect(__getActiveVitals()).toBeDefined();

    __setVitalsServerConfig({ vitalsEnabled: false, vitalsSampleRate: 1 });

    expect(__getActiveVitals()).toBeUndefined();
    expect(samplerStopSpy).toHaveBeenCalledTimes(1);
    expect(playerStopSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls.some(isFinalSummary)).toBe(true);

    // destroy() after an already-stopped session must not double-send.
    sendSpy.mockClear();
    handle.destroy();
    expect(sendSpy.mock.calls.some(isFinalSummary)).toBe(false);
  });

  it('destroy() is idempotent: removes the pagehide listener, unsubscribes, and never double-sends the final summary', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const handle = setupVitals(baseDeps());
    __setVitalsServerConfig({ vitalsEnabled: true, vitalsSampleRate: 1 });

    sendSpy.mockClear();
    handle.destroy();
    expect(sendSpy.mock.calls.filter(isFinalSummary)).toHaveLength(1);
    expect(__getActiveVitals()).toBeUndefined();

    sendSpy.mockClear();
    handle.destroy(); // second destroy — no-op
    expect(sendSpy).not.toHaveBeenCalled();

    // pagehide listener was removed by the first destroy() — dispatching now
    // must not reach the (already torn-down) collector.
    window.dispatchEvent(new Event('pagehide'));
    expect(sendSpy).not.toHaveBeenCalled();

    // A config box change after destroy() must not resurrect anything either.
    __setVitalsServerConfig({ vitalsEnabled: true, vitalsSampleRate: 1 });
    expect(__getActiveVitals()).toBeUndefined();
  });
});

describe('__getActiveVitals()', () => {
  it('returns { sessionId, recent() } only while a session is running', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const handle = setupVitals(baseDeps());
    expect(__getActiveVitals()).toBeUndefined();

    __setVitalsServerConfig({ vitalsEnabled: true, vitalsSampleRate: 1 });
    const active = __getActiveVitals();
    expect(active).toBeDefined();
    expect(typeof active!.sessionId).toBe('string');
    expect(Array.isArray(active!.recent())).toBe(true);

    handle.destroy();
    expect(__getActiveVitals()).toBeUndefined();
  });

  // Fix I2 (final review): the box's `sessionId` snapshotted `c.sessionId`
  // ONCE at start, so a later idle-gap rotation inside the collector
  // (collector.ts's `startNewSession`, driven by its `now` dep) left the box
  // reporting the OLD sessionId forever — every report built after rotation
  // would carry a stale sessionId. Driven here via real fake-timer elapsed
  // time (the collector's own `now: () => Date.now()` dep), not a mocked
  // collector, so this exercises the REAL rotation path end to end.
  it('is a LIVE getter — reflects the collector\'s own idle-gap rotation, not a value captured once at start', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.useFakeTimers();
    try {
      const handle = setupVitals(baseDeps());
      __setVitalsServerConfig({ vitalsEnabled: true, vitalsSampleRate: 1 });

      const active = __getActiveVitals()!;
      expect(onEvent).toBeDefined();
      onEvent!({ t: Date.now(), type: 'play' }); // establishes lastEntryAt
      const firstSessionId = active.sessionId;
      expect(firstSessionId).toMatch(/^[0-9a-f-]{36}$/i);

      // Idle gap over the collector's default 30-minute threshold — its OWN
      // `startNewSession` rotates sessionId internally, entirely inside
      // sdk-core, with no call back into setupVitals.
      vi.advanceTimersByTime(1_800_001);
      onEvent!({ t: Date.now(), type: 'play' });

      // Same `active` object reference throughout this test — proves
      // `sessionId` is a getter delegating to the collector, not a string
      // snapshotted when the session started.
      expect(active.sessionId).not.toBe(firstSessionId);
      expect(active.sessionId).toMatch(/^[0-9a-f-]{36}$/i);

      handle.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex round-3 finding F3 — setupVitals wires `onRotate: () =>
  // player.reseed()` into the collector; a rotation must call THROUGH to
  // the player adapter's reseed(), and the entries it re-emits must land
  // under the NEW session (not get dropped/misattributed to the old one).
  it('onRotate calls player.reseed(), and the reseeded play lands in the new session (Codex round-3 finding F3)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.useFakeTimers();
    try {
      const handle = setupVitals(baseDeps());
      __setVitalsServerConfig({ vitalsEnabled: true, vitalsSampleRate: 1 });

      const active = __getActiveVitals()!;
      expect(onEvent).toBeDefined();
      onEvent!({ t: Date.now(), type: 'play' }); // establishes lastEntryAt
      const firstSessionId = active.sessionId;

      expect(reseedSpy).not.toHaveBeenCalled();

      // Idle gap over the collector's default 30-minute threshold triggers
      // an internal rotation entirely inside sdk-core.
      vi.advanceTimersByTime(1_800_001);
      onEvent!({ t: Date.now(), type: 'pause' }); // the triggering entry

      expect(active.sessionId).not.toBe(firstSessionId);
      expect(reseedSpy).toHaveBeenCalledTimes(1);

      // The mock reseed's synthetic `play` (emitted via onEvent, exactly
      // like the real adapter would) landed under the NEW sessionId's
      // recent() — not lost, and not left attributed to the old session.
      const recent = active.recent();
      expect(
        recent.some((e) => e.kind === 'player' && e.type === 'play'),
      ).toBe(true);

      handle.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('draftToEnvelope — vitals report enrichment', () => {
  const baseDraft: ReportDraft = {
    title: 'X',
    description: 'Y',
    excludedArtifacts: [],
    annotations: [],
    redactions: [],
  };

  function baseBundle(): CaptureBundle {
    return {
      screenshotBlob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      screenshotSha256: 'a'.repeat(64),
      screenshotWidth: 100,
      screenshotHeight: 100,
      focused: null,
      logs: [],
      network: [],
      metadata: {
        os: 'macOS',
        osVersion: '14.0',
        screenSize: { width: 1, height: 1 },
        pixelRatio: 1,
        locale: 'en',
        timezone: 'UTC',
      },
    };
  }

  it('stamps envelope.sessionId + payload.vitals when a vitals session is active', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const handle = setupVitals(baseDeps());
    __setVitalsServerConfig({ vitalsEnabled: true, vitalsSampleRate: 1 });
    onEvent!({ t: Date.now(), type: 'play' });

    const active = __getActiveVitals()!;
    const { envelope } = draftToEnvelope(baseDraft, baseBundle(), baseConfig(), '0.1.0');

    expect(envelope.sessionId).toBe(active.sessionId);
    expect(envelope.payload.vitals).toEqual(active.recent());
    expect(envelope.payload.vitals?.length).toBeGreaterThan(0);

    handle.destroy();
  });

  it('omits sessionId + payload.vitals when no vitals session is active', () => {
    const { envelope } = draftToEnvelope(baseDraft, baseBundle(), baseConfig(), '0.1.0');
    expect(envelope.sessionId).toBeUndefined();
    expect(envelope.payload.vitals).toBeUndefined();
  });

  // Fix I1 (final review): `recent()` is a 60s ring with NO entry-count
  // ceiling of its own — a busy player can pack more than
  // MAX_ENVELOPE_VITALS_ENTRIES (400) entries into that window. The protocol
  // schema caps `payload.vitals` at that same limit and REJECTS THE WHOLE
  // REPORT (400, non-retryable) when exceeded, so draftToEnvelope must clamp
  // at the stamp site rather than relying on the server.
  it('caps payload.vitals at MAX_ENVELOPE_VITALS_ENTRIES even when the ring holds more', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const handle = setupVitals(baseDeps());
    __setVitalsServerConfig({ vitalsEnabled: true, vitalsSampleRate: 1 });

    const entryCount = MAX_ENVELOPE_VITALS_ENTRIES + 50;
    for (let i = 0; i < entryCount; i++) {
      onEvent!({ t: Date.now(), type: 'play' });
    }

    const active = __getActiveVitals()!;
    const allRecent = active.recent();
    // Sanity: the ring really does hold more than the cap before draftToEnvelope
    // touches it — otherwise this test would pass for the wrong reason.
    expect(allRecent.length).toBe(entryCount);

    const { envelope } = draftToEnvelope(baseDraft, baseBundle(), baseConfig(), '0.1.0');

    expect(envelope.payload.vitals).toHaveLength(MAX_ENVELOPE_VITALS_ENTRIES);
    // Newest entries kept — the tail of the ring, not the head.
    expect(envelope.payload.vitals).toEqual(allRecent.slice(-MAX_ENVELOPE_VITALS_ENTRIES));

    handle.destroy();
  });
});

describe('adapter.ts — applyLiveConfig writes the vitals server-config box', () => {
  const adapters: WebPlatformAdapter[] = [];

  afterEach(() => {
    while (adapters.length) adapters.pop()!.__testCleanup();
    vi.unstubAllGlobals();
  });

  function urlOf(input: RequestInfo | URL): string {
    return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  }

  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('per-field lenient: defaults to disabled/rate=1 when the server omits both fields (old server)', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (urlOf(input).includes('/api/config')) {
        return jsonResponse({ replayEnabled: false, replayDurationSec: 30, samplingRate: 1 });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createWebPlatformAdapter({ apiKey: 'k' });
    adapters.push(adapter);
    const client = createClient(adapter);
    client.init({ apiKey: 'k' });
    await adapter.__initReplay();
    adapter.__applyBreadcrumbsConfig();

    expect(__getVitalsServerConfig()).toEqual({ vitalsEnabled: false, vitalsSampleRate: 1 });
  });

  it('echoes explicit server values', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (urlOf(input).includes('/api/config')) {
        return jsonResponse({
          replayEnabled: false,
          replayDurationSec: 30,
          samplingRate: 1,
          vitalsEnabled: true,
          vitalsSampleRate: 0.3,
        });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createWebPlatformAdapter({ apiKey: 'k' });
    adapters.push(adapter);
    const client = createClient(adapter);
    client.init({ apiKey: 'k' });
    await adapter.__initReplay();
    adapter.__applyBreadcrumbsConfig();

    expect(__getVitalsServerConfig()).toEqual({ vitalsEnabled: true, vitalsSampleRate: 0.3 });
  });

  it('onKill() clears the box so a dead adapter never outlives it', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (urlOf(input).includes('/api/config')) {
        return jsonResponse({
          replayEnabled: false,
          replayDurationSec: 30,
          samplingRate: 1,
          vitalsEnabled: true,
          vitalsSampleRate: 1,
        });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createWebPlatformAdapter({ apiKey: 'k' });
    const client = createClient(adapter);
    client.init({ apiKey: 'k' });
    await adapter.__initReplay();
    adapter.__applyBreadcrumbsConfig();
    expect(__getVitalsServerConfig()).toBeDefined();

    client.kill();
    expect(__getVitalsServerConfig()).toBeUndefined();
  });
});

describe('setupVitals — phase 4 public API', () => {
  function startEnabled(overrides?: Partial<WebTraceItXConfig>) {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    __setVitalsServerConfig({ vitalsEnabled: true, vitalsSampleRate: 1 });
    return setupVitals(baseDeps(overrides));
  }

  it('binds players registered BEFORE the collector starts, with their name + integration, and passes the registry as id authority', () => {
    const el = document.createElement('video');
    const integ = { library: 'fake', attach() {}, detach() {} };
    const h = trackPlayer({ element: el, name: 'main', integration: integ });
    expect(h.id).toBe('p1');
    const handle = startEnabled();
    expect(Array.from(adapterDeps!.registered!)).toEqual([{ element: el, name: 'main', integration: integ }]);
    expect(adapterDeps!.playerIdFor!(el)).toBe('p1');
    handle.destroy();
  });

  // Codex round-2 item 11 — a player `name` is neither coerced nor capped
  // at the documented 64-char limit (spec 2026-09-02 §2: "name?: string; //
  // customer label, ≤ 64 chars"). A large CMS-derived title would otherwise
  // inflate `player_attach` and, via the recent ring, every enriched bug
  // report until it expires.
  it('coerces and caps a player name at the documented 64-char limit', () => {
    const el = document.createElement('video');
    const longName = 'x'.repeat(200);
    trackPlayer({ element: el, name: longName });
    const handle = startEnabled();
    const registered = Array.from(adapterDeps!.registered!) as Array<{ name?: string }>;
    expect(registered[0]!.name).toBe('x'.repeat(MAX_CUSTOM_NAME_LENGTH));
    expect(registered[0]!.name!.length).toBe(MAX_CUSTOM_NAME_LENGTH);
    handle.destroy();
  });

  it('forwards trackPlayer to the live adapter (upgrade path) and resolves hls/shaka sugar into integrations', () => {
    const handle = startEnabled();
    const el = document.createElement('video');
    const hls = { on() {}, off() {} };
    trackPlayer({ element: el, hls });
    expect(trackPlayerSpy).toHaveBeenCalledWith(el, expect.objectContaining({ integration: expect.objectContaining({ library: 'hls.js' }) }));
    trackPlayer({ element: el, shaka: { addEventListener() {}, removeEventListener() {} } });
    expect(trackPlayerSpy).toHaveBeenLastCalledWith(el, expect.objectContaining({ integration: expect.objectContaining({ library: 'shaka' }) }));
    handle.destroy();
  });

  it('handle.detach() unregisters and untracks; a later start no longer binds it', () => {
    const el = document.createElement('video');
    const h = trackPlayer({ element: el });
    const a = startEnabled();
    h.detach();
    expect(untrackPlayerSpy).toHaveBeenCalledWith(el);
    a.destroy();
    __setVitalsServerConfig(undefined);
    const b = startEnabled();
    expect(Array.from(adapterDeps!.registered!)).toEqual([]);
    b.destroy();
  });

  it('trackVitals records a bounded custom entry with playerId, and drops it when no collector is running', () => {
    trackVitals('before.start', { x: 1 }); // dropped, must not throw
    const handle = startEnabled();
    const el = document.createElement('video');
    const h = trackPlayer({ element: el });
    trackVitals('cdn.switch', { to: 'b' }, { player: h });
    h.track('big', { blob: 'y'.repeat(5000) });
    trackVitals('', undefined);
    const recent = __getActiveVitals()!.recent();
    expect(recent).toContainEqual(expect.objectContaining({ kind: 'custom', name: 'cdn.switch', data: { to: 'b' }, playerId: 'p1' }));
    expect(recent).toContainEqual(expect.objectContaining({ kind: 'custom', name: 'big', truncated: true, playerId: 'p1' }));
    expect(recent).toContainEqual(expect.objectContaining({ kind: 'custom', name: 'custom' }));
    expect(recent.some((e) => e.kind === 'custom' && e.name === 'before.start')).toBe(false);
    handle.destroy();
  });

  it('passes vitals.captureSourceQuery through as keepSourceQuery', () => {
    const handle = startEnabled({ vitals: { captureSourceQuery: true } });
    expect(adapterDeps!.keepSourceQuery).toBe(true);
    handle.destroy();
  });

  it('destroy() clears the registry', () => {
    trackPlayer({ element: document.createElement('video') });
    const handle = startEnabled();
    handle.destroy();
    __setVitalsServerConfig(undefined);
    const again = startEnabled();
    expect(Array.from(adapterDeps!.registered!)).toEqual([]);
    again.destroy();
  });

  // Concern 2 (review round) — a throwing adapter must not leave an orphaned
  // registration behind: the caller gets an inert handle it can never detach,
  // so if the registration survived, the NEXT collector start would silently
  // bind a player the customer believes it failed to register. Restarts via
  // a SERVER CONFIG FLIP on the same `setupVitals` handle, not `destroy()` —
  // `destroy()` clears the whole registry itself (a separate, already-tested
  // behaviour) which would mask whether THIS failure path leaves state
  // behind on its own.
  it('trackPlayer unregisters on a throwing adapter — the returned handle is inert, and a later start does not bind the element', () => {
    const handle = startEnabled();
    trackPlayerSpy.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const el = document.createElement('video');
    const h = trackPlayer({ element: el });
    expect(h.id).toBe('');
    expect(() => h.detach()).not.toThrow();
    expect(() => h.track('x')).not.toThrow();

    __setVitalsServerConfig({ vitalsEnabled: false, vitalsSampleRate: 1 });
    __setVitalsServerConfig({ vitalsEnabled: true, vitalsSampleRate: 1 });
    expect(Array.from(adapterDeps!.registered!)).toEqual([]);

    handle.destroy();
  });

  // Review round finding — `trackPlayer()`/`trackPlayer(undefined)` from an
  // untyped JS host (this barrel ships to plain <script> consumers with no
  // compiler to stop them) used to throw INSIDE the catch block that exists
  // specifically to prevent trackPlayer from ever throwing: `opts` itself is
  // nullish, `resolveIntegration(opts)` throws reading `opts.integration`,
  // and the old unconditional `registry.unregister(opts.element)` in the
  // catch dereferenced the same nullish `opts` again. The safety net was the
  // crash site.
  it('trackPlayer never throws, even called with no arguments at all', () => {
    expect(() => (trackPlayer as unknown as () => unknown)()).not.toThrow();
    const h = (trackPlayer as unknown as () => unknown)() as ReturnType<typeof trackPlayer>;
    expect(h.id).toBe('');
    expect(() => h.detach()).not.toThrow();
  });

  // Second review round — the item-1 fix's `if (opts?.element)` guard closed
  // the crash but reopened a quieter hole: `trackPlayer({})` and
  // `trackPlayer({ element: null })` are both real `opts` objects with a
  // falsy `element`, reachable from the same untyped host. Before the A/B
  // fixes, `registry.register` wrote the phantom entry into `explicit`
  // BEFORE `idFor`'s `WeakMap.set` threw on the bad key, and the catch's
  // `opts?.element` check was false — so the entry leaked permanently into
  // `registry.registered()`, which feeds every subsequent `maybeStart()`.
  // The assertion that matters is the SECOND one in each test: that nothing
  // ends up registered, not merely that nothing throws (which already
  // passed before this round).
  it('trackPlayer({}) never throws and leaves no registry entry behind', () => {
    expect(() => (trackPlayer as unknown as (o: object) => unknown)({})).not.toThrow();
    const handle = startEnabled();
    expect(Array.from(adapterDeps!.registered!)).toEqual([]);
    handle.destroy();
  });

  it('trackPlayer({ element: null }) never throws and leaves no registry entry behind', () => {
    expect(() =>
      trackPlayer({ element: null as unknown as HTMLMediaElement }),
    ).not.toThrow();
    const handle = startEnabled();
    expect(Array.from(adapterDeps!.registered!)).toEqual([]);
    handle.destroy();
  });

  // Codex round-5 item 2 (honest-contract half) — `{}` is a real, non-null
  // OBJECT, which is all a bare `WeakMap` key check requires: unlike
  // `null`/`undefined` above (which throw inside `idFor`'s `WeakMap.set`
  // and are caught), a plain object used to sail straight through
  // `registry.register` and mint a real id — reproducing exactly codex's
  // report: `trackPlayer({ element: {} })` returned a live-looking handle
  // (id `p1`), and the registration only failed LATER, at collector start,
  // when the real adapter's `bind()` reached `el.addEventListener` on the
  // fake element — aborting the ENTIRE collector (see player-adapter.spec.ts
  // for the safety-net half of this same item, which covers what happens if
  // a bad entry reaches the adapter's `registered` list anyway). Rejecting
  // up front here means the id promise itself matters: `h.id` must be `''`
  // (INERT_PLAYER), not a fabricated `p1` that would later disagree with
  // "nothing got registered".
  it('trackPlayer({ element: {} }) returns the inert handle (not a fabricated id) and leaves no registry entry behind', () => {
    let h: ReturnType<typeof trackPlayer> | undefined;
    expect(() => {
      h = trackPlayer({ element: {} as unknown as HTMLMediaElement });
    }).not.toThrow();
    expect(h!.id).toBe('');
    expect(() => h!.detach()).not.toThrow();
    const handle = startEnabled();
    expect(Array.from(adapterDeps!.registered!)).toEqual([]);
    expect(__getActiveVitals()).toBeDefined();
    handle.destroy();
  });

  // Codex round-6 item 4 — round 5's `instanceof HTMLMediaElement` checks
  // REALM identity, not shape. A same-origin iframe's `<video>` is a
  // genuinely valid, fully functional media element, but its prototype
  // chain carries the IFRAME's own `HTMLMediaElement`, not this window's, so
  // it failed `instanceof` and silently downgraded to the inert handle —
  // real telemetry lost with no error anywhere, and the automatic scanner
  // can't compensate since it never looks inside iframe documents.
  // Structural validation (checking the properties/methods the adapter
  // actually uses) must accept it regardless of which document created it.
  it('accepts a same-origin iframe media element that instanceof-based validation would have rejected (Codex round-6 item 4)', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const iframeDoc = iframe.contentDocument!;
    const iframeVideo = iframeDoc.createElement('video');
    iframeDoc.body.appendChild(iframeVideo);

    // Sanity check that this test actually exercises the cross-realm gap:
    // the iframe's own `HTMLMediaElement` is a DIFFERENT constructor from
    // this window's, so round 5's `instanceof HTMLMediaElement` check would
    // have rejected `iframeVideo` outright.
    const iframeHTMLMediaElement = (iframe.contentWindow as unknown as { HTMLMediaElement: typeof HTMLMediaElement })
      .HTMLMediaElement;
    expect(iframeHTMLMediaElement).not.toBe(HTMLMediaElement);
    expect(iframeVideo instanceof iframeHTMLMediaElement).toBe(true);
    expect(iframeVideo instanceof HTMLMediaElement).toBe(false);

    const h = trackPlayer({ element: iframeVideo as unknown as HTMLMediaElement });
    expect(h.id).toBe('p1');
    const handle = startEnabled();
    const registered = Array.from(adapterDeps!.registered!) as Array<{ element: unknown }>;
    expect(registered).toHaveLength(1);
    expect(registered[0]!.element).toBe(iframeVideo);
    handle.destroy();
    document.body.removeChild(iframe);
  });

  // Codex round-7 item 4 — round 6's structural check required `tagName` to
  // be A STRING, not an actual media tag: a plain `<div>` already has
  // `addEventListener`/`removeEventListener`/`querySelectorAll`/`tagName`
  // ('DIV', still a string) for free, so duck-typing on `paused`/
  // `currentTime`/`readyState` alone (properties a media-like custom
  // element, or an erroneous ref, can trivially add) was enough to pass —
  // `player-adapter.ts`'s `emitAttach` then reads `tagName` right back off
  // the same element and labels every non-`VIDEO` value `'audio'`,
  // corrupting the player count and timeline. The tightened check must
  // reject this while the cross-realm video above still passes.
  it('rejects a structurally-similar DIV that duck-types every other media property (Codex round-7 item 4)', () => {
    const div = document.createElement('div') as unknown as HTMLMediaElement;
    (div as unknown as { paused: boolean }).paused = true;
    (div as unknown as { currentTime: number }).currentTime = 0;
    (div as unknown as { readyState: number }).readyState = 0;
    expect(div.tagName).toBe('DIV');

    let h: ReturnType<typeof trackPlayer> | undefined;
    expect(() => {
      h = trackPlayer({ element: div });
    }).not.toThrow();
    expect(h!.id).toBe('');
    expect(() => h!.detach()).not.toThrow();
    const handle = startEnabled();
    expect(Array.from(adapterDeps!.registered!)).toEqual([]);
    handle.destroy();
  });

  // Verification-pass finding — round 7's `isMediaElement` compared the
  // literal string `e.tagName === 'VIDEO'`, which UNDER-rejects: a plain
  // object carrying every listed method plus a hand-set `tagName: 'VIDEO'`
  // string passed every check and received a live handle, corrupting the
  // player count and timeline exactly like the round-7 duck-typed DIV did —
  // an exact string match on a property value was never a check that the
  // object is an actual DOM node. Fixed by additionally requiring
  // `nodeType === 1` (`Node.ELEMENT_NODE`), which a plain object doesn't
  // carry unless it goes out of its way to impersonate one — at which point
  // its telemetry is its own problem.
  it('rejects a plain object impersonating a video element via a hand-set tagName (under-rejection fix)', () => {
    const fake = {
      tagName: 'VIDEO',
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelectorAll: () => [],
      paused: false,
      currentTime: 0,
      readyState: 0,
      // Deliberately no `nodeType` — this is what makes it "just an object
      // with the right property values" rather than an actual DOM node.
    };

    let h: ReturnType<typeof trackPlayer> | undefined;
    expect(() => {
      h = trackPlayer({ element: fake as unknown as HTMLMediaElement });
    }).not.toThrow();
    expect(h!.id).toBe('');
    expect(() => h!.detach()).not.toThrow();
    const handle = startEnabled();
    expect(Array.from(adapterDeps!.registered!)).toEqual([]);
    handle.destroy();
  });

  // Verification-pass finding — round 7's exact `tagName === 'VIDEO'` match
  // also OVER-rejects: a genuine `HTMLVideoElement` parsed from an XHTML
  // document has a lowercase `tagName` of `'video'` (XHTML is XML, so
  // `Element.tagName` follows the document's source case rather than being
  // upper-cased the way an HTML-namespace element always is), so the exact
  // match silently refused it and dropped that player's telemetry with no
  // error anywhere. The case-insensitive tag check must accept it while the
  // plain-object impersonator above and the DIV above both still get
  // rejected.
  it('accepts a genuine XHTML video element with a lowercase tagName (over-rejection fix)', () => {
    const xhtml =
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><video></video></body></html>';
    const xhtmlDoc = new DOMParser().parseFromString(xhtml, 'application/xhtml+xml');
    const xhtmlVideo = xhtmlDoc.querySelector('video')!;
    // Sanity check this test actually exercises the lowercase-tagName gap.
    expect(xhtmlVideo.tagName).toBe('video');
    expect(xhtmlVideo.nodeType).toBe(1);

    const h = trackPlayer({ element: xhtmlVideo as unknown as HTMLMediaElement });
    expect(h.id).toBe('p1');
    const handle = startEnabled();
    const registered = Array.from(adapterDeps!.registered!) as Array<{ element: unknown }>;
    expect(registered).toHaveLength(1);
    expect(registered[0]!.element).toBe(xhtmlVideo);
    handle.destroy();
  });

  // Review round finding — a customer holding a FAILED handle must not be
  // able to corrupt the session timeline by naming a player that was never
  // bound: the admin groups entries by playerId, so a fabricated one would
  // show up as a phantom player.
  it('trackVitals does not stamp a playerId for the inert handle', () => {
    const handle = startEnabled();
    trackPlayerSpy.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const h = trackPlayer({ element: document.createElement('video') });
    expect(h.id).toBe('');
    trackVitals('inert.call', { x: 1 }, { player: h });
    const recent = __getActiveVitals()!.recent();
    const entry = recent.find((e) => e.kind === 'custom' && e.name === 'inert.call');
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty('playerId');
    handle.destroy();
  });

  // Review round finding — `detach()`'s no-throw property must be its OWN
  // guarantee, not inherited from `untrackPlayer` -> `unbind` (which isn't
  // itself wrapped in safeWrap).
  it('handle.detach() never throws, even when the live adapter\'s untrackPlayer throws', () => {
    const handle = startEnabled();
    const el = document.createElement('video');
    const h = trackPlayer({ element: el });
    untrackPlayerSpy.mockImplementationOnce(() => {
      throw new Error('adapter boom');
    });
    expect(() => h.detach()).not.toThrow();
    handle.destroy();
  });

  // Review round finding — a spec that fails an assertion before its own
  // destroy() must not leave a stale __getActiveVitals() box for the NEXT
  // spec to observe.
  it('__resetVitalsForTests clears a still-active box, simulating a spec that failed before its own destroy()', () => {
    const handle = startEnabled();
    expect(__getActiveVitals()).toBeDefined();
    __resetVitalsForTests();
    expect(__getActiveVitals()).toBeUndefined();
    handle.destroy(); // still safe post-reset — uses its own closured collector, not the module box
  });

  // Codex round-2 item 2 — the cleanup in trackPlayer's catch block used to
  // re-read `opts.element` a SECOND time. A throwing accessor/Proxy element
  // throws on the first read (entering the catch), then throws AGAIN on
  // that re-read — escaping the catch and into the host page, exactly what
  // this whole try/catch exists to prevent. `element` is now read exactly
  // once; the catch reuses that captured (here: never-successfully-read)
  // local instead.
  it('trackPlayer never throws when opts.element is a throwing accessor, and the returned handle detaches safely', () => {
    let reads = 0;
    const opts = {
      get element(): HTMLMediaElement {
        reads++;
        throw new Error('proxy boom');
      },
    } as unknown as { element: HTMLMediaElement };
    let h: ReturnType<typeof trackPlayer> | undefined;
    expect(() => {
      h = trackPlayer(opts);
    }).not.toThrow();
    expect(h!.id).toBe('');
    expect(() => h!.detach()).not.toThrow();
    // Exactly one read — proof the cleanup path never re-reads `opts.element`.
    expect(reads).toBe(1);
  });

  // Codex round-2 item 4 (identity half) — a stale handle from a
  // SUPERSEDED registration must act on NOTHING: `p.detach(); q =
  // trackPlayer({element}); p.detach()` used to tear down q's live
  // registration instead of p's (already-gone) one, since detach() acted
  // on whatever registration the element CURRENTLY has rather than the one
  // this specific handle created.
  it('a stale handle from a superseded registration cannot detach the newer one', () => {
    const handle = startEnabled();
    const el = document.createElement('video');
    const p = trackPlayer({ element: el });
    p.detach();
    expect(untrackPlayerSpy).toHaveBeenCalledTimes(1);
    const q = trackPlayer({ element: el, name: 'main' });
    p.detach(); // stale — must be a no-op, not tear down q's registration
    expect(q.id).not.toBe('');
    expect(untrackPlayerSpy).toHaveBeenCalledTimes(1); // still just p's own detach, above

    // Restart the SAME setupVitals instance via a config flip, not
    // destroy() — destroy() clears the whole registry itself (already
    // covered elsewhere) and would mask whether q's registration
    // specifically survived the stale detach.
    __setVitalsServerConfig({ vitalsEnabled: false, vitalsSampleRate: 1 });
    __setVitalsServerConfig({ vitalsEnabled: true, vitalsSampleRate: 1 });
    expect(Array.from(adapterDeps!.registered!)).toEqual([{ element: el, name: 'main' }]);

    handle.destroy();
  });

  // Codex round-2 item 4 (durability half) — detaching BEFORE the collector
  // ever started removes the registry's explicit registration (so a later
  // start's `registered` seed list is already correct — covered by the
  // pre-existing "a later start no longer binds it" test above), but that
  // alone cannot reach the adapter's OWN `userDetached` set, since no
  // adapter exists yet. Without more, the adapter's independent initial DOM
  // scan would silently rebind the still-in-the-DOM element the moment a
  // collector eventually starts. `vitals/index.ts` hands the adapter a
  // SHARED `userDetached` set (by reference) precisely so a pre-start
  // detach is already reflected in it before the very first scan runs.
  // Codex round-3 item 9 — the catch used to unregister `element`
  // UNCONDITIONALLY, even when THIS call's failure happened before
  // `registry.register()` ever ran (a throwing `opts` getter). That silently
  // deleted an EARLIER, still-valid registration for the same element: the
  // customer gets back the correctly-inert handle for the failing call, but
  // a later collector restart brings the PREVIOUSLY-registered player back
  // anonymous, even though nothing was wrong with its own registration.
  it('a repeat trackPlayer() that fails before registry.register() runs does not delete the earlier valid registration', () => {
    const handle = startEnabled();
    const el = document.createElement('video');
    const first = trackPlayer({ element: el, name: 'main' });
    expect(first.id).not.toBe('');

    // A later call for the SAME element whose options object has a
    // throwing `name` getter — this fails while still computing `cleanName`,
    // strictly BEFORE `registry.register()` is reached.
    const throwing = {
      element: el,
      get name(): string {
        throw new Error('boom');
      },
    };
    const second = trackPlayer(throwing as unknown as Parameters<typeof trackPlayer>[0]);
    expect(second.id).toBe('');

    // Restart via a config flip, not destroy() (which clears the whole
    // registry on its own and would mask whether the FIRST registration
    // specifically survived the second call's failure).
    __setVitalsServerConfig({ vitalsEnabled: false, vitalsSampleRate: 1 });
    __setVitalsServerConfig({ vitalsEnabled: true, vitalsSampleRate: 1 });
    expect(Array.from(adapterDeps!.registered!)).toEqual([{ element: el, name: 'main' }]);

    handle.destroy();
  });

  it('detaching before the collector starts is durable — the later adapter start is seeded so it will not rebind the element', () => {
    const el = document.createElement('video');
    const h = trackPlayer({ element: el }); // no adapter exists yet
    h.detach();
    const handle = startEnabled();
    expect(Array.from(adapterDeps!.registered!)).toEqual([]);
    expect(adapterDeps!.userDetached).toBeInstanceOf(WeakSet);
    expect(adapterDeps!.userDetached!.has(el)).toBe(true);
    handle.destroy();
  });
});
