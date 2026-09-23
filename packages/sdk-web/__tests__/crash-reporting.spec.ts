// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBreadcrumbBuffer } from '@everframe/sdk-core';
import { MAX_ENVELOPE_VITALS_ENTRIES } from '@everframe/protocol';
import { createWebPlatformAdapter } from '../src/adapter.js';

// Session Vitals mocks (Codex round-1 finding S2's covering test, below) —
// same isolation doctrine as __tests__/vitals/wiring.spec.ts: mock the
// resource sampler / player adapter / transport factories so setupVitals can
// be driven end to end (real sampling-draw + collector) without a real timer
// loop or a real network send racing this file's crash-envelope fetchMock.
const {
  vitalsSendSpy,
  vitalsSamplerStopSpy,
  vitalsPlayerStopSpy,
  startResourceSamplerMock,
  attachPlayerVitalsMock,
  createVitalsTransportMock,
} = vi.hoisted(() => ({
  vitalsSendSpy: vi.fn(),
  vitalsSamplerStopSpy: vi.fn(),
  vitalsPlayerStopSpy: vi.fn(),
  startResourceSamplerMock: vi.fn(),
  attachPlayerVitalsMock: vi.fn(),
  createVitalsTransportMock: vi.fn(),
}));

vi.mock('../src/vitals/resource-sampler.js', () => ({
  startResourceSampler: startResourceSamplerMock,
}));
vi.mock('../src/vitals/player-adapter.js', () => ({
  attachPlayerVitals: attachPlayerVitalsMock,
}));
vi.mock('../src/vitals/transport.js', () => ({
  createVitalsTransport: createVitalsTransportMock,
}));

import { setupVitals, __getActiveVitals } from '../src/vitals/index.js';
import { __setVitalsServerConfig } from '../src/vitals/server-config.js';
import { stampActiveVitals } from '../src/vitals/stamp-active-vitals.js';

let vitalsOnPlayerEvent: ((e: { t: number; type: string }) => void) | undefined;

// Sibling adapter specs (capture/breadcrumbs-adapter.spec.ts,
// capture/network-body-adapter.spec.ts) register every adapter created in a
// test and tear it down in afterEach via __testCleanup — installConsolePatcher
// is install-once via a global Symbol marker, so without this an adapter from
// an earlier test keeps owning window.onerror/onunhandledrejection and a
// later test's fresh adapter never actually gets its patchers installed.
const adapters: Array<{ __testCleanup: () => void }> = [];

describe('web crash reporting (spec 2026-07-18)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'received' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    vitalsOnPlayerEvent = undefined;
    __setVitalsServerConfig(undefined);
    vitalsSendSpy.mockReset();
    vitalsSamplerStopSpy.mockReset();
    vitalsPlayerStopSpy.mockReset();
    startResourceSamplerMock.mockReset().mockReturnValue(vitalsSamplerStopSpy);
    attachPlayerVitalsMock.mockReset().mockImplementation(
      (deps: { onEvent: (e: { t: number; type: string }) => void }) => {
        vitalsOnPlayerEvent = deps.onEvent;
        return { trackPlayer: vi.fn(), sampleQuality: vi.fn(), stop: vitalsPlayerStopSpy };
      },
    );
    createVitalsTransportMock.mockReset().mockReturnValue(vitalsSendSpy);
  });
  afterEach(() => {
    while (adapters.length) adapters.pop()!.__testCleanup();
    vi.unstubAllGlobals();
    __setVitalsServerConfig(undefined);
  });

  const mk = (config: Parameters<typeof createWebPlatformAdapter>[0]) => {
    const adapter = createWebPlatformAdapter(config);
    adapters.push(adapter);
    return adapter;
  };

  it('uncaught error → error crumb preserved + envelope enqueued + immediate drain', async () => {
    const adapter = mk({ apiKey: 'pk_test', appName: 'demo', appVersion: '1.0.0', appBuild: 'web-abc123' });
    const buf = createBreadcrumbBuffer();
    adapter.__setBreadcrumbBuffer(() => buf);

    const inner = new RangeError('root failure');
    Object.defineProperty(inner, 'stack', {
      configurable: true,
      value: 'RangeError: root failure\n    at root (root.ts:9:4)',
    });
    const err = new TypeError('boom', { cause: inner });
    err.stack = 'TypeError: boom\n    at f (a.ts:1:1)';
    window.onerror?.('boom', 'a.ts', 1, 1, err);

    // Existing behavior preserved: the error breadcrumb landed.
    expect(adapter.__getBreadcrumbBuffer()?.snapshot().some((b) => b.kind === 'error')).toBe(true);

    // Envelope reached the outbox and the immediate drain POSTed it.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    const envelopeJson = JSON.parse(await (body.get('envelope') as Blob).text());
    expect(envelopeJson.source).toBe('error');
    expect(envelopeJson.payload.crash.exceptionType).toBe('TypeError');
    expect(envelopeJson.payload.crash).toMatchObject({
      handled: false,
      fatal: false,
      details: { severity: 'error' },
      causeChain: {
        causes: [{
          exceptionType: 'RangeError',
          message: 'root failure',
          frames: [{ raw: 'at root (root.ts:9:4)' }],
          framesTruncated: false,
        }],
        truncated: false,
      },
    });
    expect(envelopeJson.context.app.build).toBe('web-abc123');
    expect(envelopeJson.reporter.title).toBe('TypeError: boom');
  });

  it('same error twice → one report (fingerprint throttle), crumbs still land both times', async () => {
    const adapter = mk({ apiKey: 'pk_test' });
    const buf = createBreadcrumbBuffer();
    adapter.__setBreadcrumbBuffer(() => buf);

    const err = new Error('dup');
    err.stack = 'Error: dup\n    at g (b.ts:2:2)';
    window.onerror?.('dup', 'b.ts', 2, 2, err);
    window.onerror?.('dup', 'b.ts', 2, 2, err);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(adapter.__getBreadcrumbBuffer()?.snapshot().filter((b) => b.kind === 'error').length).toBe(2);
  });

  it('crashReporting.disabled vetoes reports but not crumbs', async () => {
    const adapter = mk({ apiKey: 'pk_test', crashReporting: { disabled: true } });
    const buf = createBreadcrumbBuffer();
    adapter.__setBreadcrumbBuffer(() => buf);

    window.onerror?.('x', 'c.ts', 1, 1, new Error('x'));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(adapter.__getBreadcrumbBuffer()?.snapshot().some((b) => b.kind === 'error')).toBe(true);
  });

  it('unhandledrejection → error crumb preserved + envelope enqueued + immediate drain', async () => {
    const adapter = mk({ apiKey: 'pk_test' });
    const buf = createBreadcrumbBuffer();
    adapter.__setBreadcrumbBuffer(() => buf);

    // jsdom has no real PromiseRejectionEvent constructor — same polyfill
    // idiom as __tests__/capture/logs.spec.ts's unhandledrejection test.
    const inner = new TypeError('async root');
    const err = new Error('rejected', { cause: inner });
    err.stack = 'Error: rejected\n    at h (c.ts:3:3)';
    const ev = new Event('unhandledrejection') as PromiseRejectionEvent;
    Object.defineProperty(ev, 'reason', { value: err });
    window.dispatchEvent(ev);

    expect(adapter.__getBreadcrumbBuffer()?.snapshot().some((b) => b.kind === 'error')).toBe(true);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    const envelopeJson = JSON.parse(await (body.get('envelope') as Blob).text());
    expect(envelopeJson.source).toBe('error');
    expect(envelopeJson.payload.crash.exceptionType).toBe('Error');
    expect(envelopeJson.payload.crash.mechanism).toBe('unhandledrejection');
    expect(envelopeJson.payload.crash).toMatchObject({ handled: false, fatal: false });
    expect(envelopeJson.payload.crash.causeChain?.causes[0]).toMatchObject({
      exceptionType: 'TypeError',
      message: 'async root',
    });
    expect(envelopeJson.context.app.build).toBeUndefined();
  });

  it('remount with crashReporting.disabled silences a previously-bound active sink', async () => {
    // installConsolePatcher is install-once (global Symbol marker): adapter A
    // owns the patcher; creating adapter B WITHOUT tearing A down (StrictMode
    // remount / Fast Refresh) must re-point the forwarding crash slot at B —
    // here bound to null (veto) — so A's stale sink (A's outbox/throttle/
    // config) must NOT keep turning crashes into reports.
    const a = createWebPlatformAdapter({ apiKey: 'pk_test' });
    adapters.push(a);
    const bufA = createBreadcrumbBuffer();
    a.__setBreadcrumbBuffer(() => bufA);

    // Remount without __testCleanup — patcher stays owned by `a`.
    const b = createWebPlatformAdapter({ apiKey: 'pk_test', crashReporting: { disabled: true } });
    adapters.push(b);
    const bufB = createBreadcrumbBuffer();
    b.__setBreadcrumbBuffer(() => bufB);

    const err = new Error('post-remount');
    err.stack = 'Error: post-remount\n    at r (d.ts:4:4)';
    window.onerror?.('post-remount', 'd.ts', 4, 4, err);

    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    // Crumb capture is unaffected by the crash veto (routes via the crumb slot,
    // which the remount also re-pointed at the live adapter B).
    expect(bufB.snapshot().some((c) => c.kind === 'error')).toBe(true);
  });

  it('remount with crash reporting enabled takes over from a vetoed first mount', async () => {
    const a = createWebPlatformAdapter({ apiKey: 'pk_test', crashReporting: { disabled: true } });
    adapters.push(a);

    // Remount without teardown — the already-installed patcher must now route
    // crashes to B's live sink (B's own outbox + throttle).
    const b = createWebPlatformAdapter({ apiKey: 'pk_test' });
    adapters.push(b);
    const bufB = createBreadcrumbBuffer();
    b.__setBreadcrumbBuffer(() => bufB);

    const err = new Error('takeover');
    err.stack = 'Error: takeover\n    at t (e.ts:5:5)';
    window.onerror?.('takeover', 'e.ts', 5, 5, err);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    const envelopeJson = JSON.parse(await (body.get('envelope') as Blob).text());
    expect(envelopeJson.payload.crash.exceptionType).toBe('Error');
    expect(envelopeJson.payload.crash.message).toBe('takeover');
  });

  it('redacts a JWT embedded in the crash message before it reaches the envelope', async () => {
    // Correction to the brief's literal fixture: the client redaction engine has
    // NO generic-secret/Bearer rule — only JWT / Luhn-CC / SSN / auth-headers.
    // Plant a 3-segment JWT-shaped string and assert on [REDACTED:JWT].
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const adapter = mk({ apiKey: 'pk_test' });
    const buf = createBreadcrumbBuffer();
    adapter.__setBreadcrumbBuffer(() => buf);

    const err = new Error(`token=${jwt}`);
    err.stack = `Error: token=${jwt}\n    at f (a.ts:1:1)`;
    window.onerror?.(`token=${jwt}`, 'a.ts', 1, 1, err);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    const envelopeJson = JSON.parse(await (body.get('envelope') as Blob).text());
    expect(envelopeJson.payload.crash.message).toContain('[REDACTED:JWT]');
    expect(envelopeJson.payload.crash.message).not.toContain(jwt);
  });

  // Round-6 PR review, gap flagged on re-review (same class as Finding 2):
  // the crash sink enqueues the crash report then immediately drains the
  // outbox, discarding the drain's result. A crash report that provisions a
  // reply thread never woke an idled poller — the FAB/inbox stayed silent
  // until an unrelated visibility transition. Mirrors the fix already
  // applied to the mount/online drain trigger and the post-submit drain in
  // provider.tsx.
  it('a crash-sink drain that provisions a thread wakes the poller', async () => {
    const adapter = mk({ apiKey: 'pk_test' });
    const buf = createBreadcrumbBuffer();
    adapter.__setBreadcrumbBuffer(() => buf);
    const threads = adapter.threads;
    expect(threads).toBeDefined();
    const wake = vi.spyOn(threads!, 'wake');

    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ status: 'received', thread: { id: 't-crash' } }),
        { status: 200 },
      ),
    );

    const err = new Error('wake-me');
    err.stack = 'Error: wake-me\n    at f (a.ts:1:1)';
    window.onerror?.('wake-me', 'a.ts', 1, 1, err);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await vi.waitFor(() => expect(wake).toHaveBeenCalled());
  });

  it('a crash-sink drain that provisions no thread does not wake the poller', async () => {
    const adapter = mk({ apiKey: 'pk_test' });
    const buf = createBreadcrumbBuffer();
    adapter.__setBreadcrumbBuffer(() => buf);
    const threads = adapter.threads;
    expect(threads).toBeDefined();
    const wake = vi.spyOn(threads!, 'wake');

    const err = new Error('no-wake');
    err.stack = 'Error: no-wake\n    at f (a.ts:1:1)';
    window.onerror?.('no-wake', 'a.ts', 1, 1, err);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // Give the drain's promise chain a tick to (not) settle.
    await new Promise((r) => setTimeout(r, 20));
    expect(wake).not.toHaveBeenCalled();
  });

  // Final whole-branch review, finding 2 (spec 2026-08-12). `sdk-core`'s
  // `buildCrashEnvelope` has accepted a `user` since the branch landed and is
  // unit-tested there, but NO production web caller passed it: this adapter is
  // the only web call site, and it omitted the field. A web crash from a
  // signed-in user therefore shipped anonymous while iOS
  // (`CrashReporter.swift`) and Android (`CrashReporter.kt`) both attributed
  // theirs. The web report and companion paths were wired; only the crash sink
  // was not — which is exactly the gap a per-path test could not see.
  describe('setUser on the crash path', () => {
    /** Extract the enqueued crash envelope from the immediate drain's POST. */
    const drainedEnvelope = async (): Promise<{ reporter: { user?: unknown } }> => {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
      return JSON.parse(await (body.get('envelope') as Blob).text());
    };

    const throwAt = (adapter: ReturnType<typeof createWebPlatformAdapter>, msg: string): void => {
      const err = new Error(msg);
      err.stack = `Error: ${msg}\n    at f (a.ts:1:1)`;
      window.onerror?.(msg, 'a.ts', 1, 1, err);
    };

    it('attributes the crash to the host-declared user', async () => {
      const adapter = mk({ apiKey: 'pk_test' });
      adapter.__setBreadcrumbBuffer(() => createBreadcrumbBuffer());
      adapter.__setUserGetter(() => ({ id: 'u_1', email: 'a@b.com', displayName: 'A' }));

      throwAt(adapter, 'attributed');
      expect((await drainedEnvelope()).reporter.user).toEqual({
        id: 'u_1',
        email: 'a@b.com',
        displayName: 'A',
      });
    });

    it('ships anonymous when no user getter is bound', async () => {
      const adapter = mk({ apiKey: 'pk_test' });
      adapter.__setBreadcrumbBuffer(() => createBreadcrumbBuffer());

      throwAt(adapter, 'unbound');
      expect((await drainedEnvelope()).reporter.user).toBeUndefined();
    });

    it('ships anonymous when the user is null (signed out)', async () => {
      const adapter = mk({ apiKey: 'pk_test' });
      adapter.__setBreadcrumbBuffer(() => createBreadcrumbBuffer());
      adapter.__setUserGetter(() => null);

      throwAt(adapter, 'signed-out');
      expect((await drainedEnvelope()).reporter.user).toBeUndefined();
    });

    // THE reason this is a getter and not a snapshot — the same reason the
    // companion seam's `getUser` is one. A value captured when the Provider
    // mounted would pin whoever was signed in then onto every later crash.
    it('reads the user AT CRASH TIME, not at bind time', async () => {
      const adapter = mk({ apiKey: 'pk_test' });
      adapter.__setBreadcrumbBuffer(() => createBreadcrumbBuffer());
      let current: { id: string } | null = { id: 'alice' };
      adapter.__setUserGetter(() => current);

      // Account switch AFTER the seam was bound.
      current = { id: 'bob' };
      throwAt(adapter, 'switched');
      expect((await drainedEnvelope()).reporter.user).toEqual({ id: 'bob' });
    });

    // External review, finding 1 (Serious) — the crash path's half. The web
    // crash sink writes its envelope straight into a DURABLE outbox, so an
    // unprojected host object here is persisted to disk before anything else
    // gets a say. `tx.setUser(currentUser)` (the app's own user object) is the
    // natural call, and `{ ...live }` preserved every property on it.
    it('ships only id/email/displayName when the host user carries extra properties', async () => {
      const adapter = mk({ apiKey: 'pk_test' });
      adapter.__setBreadcrumbBuffer(() => createBreadcrumbBuffer());
      adapter.__setUserGetter(
        () =>
          ({
            id: 'u_1',
            email: 'a@b.com',
            displayName: 'A',
            accessToken: 'secret-token',
            profile: { address: '1 Main St', dob: '1990-01-01' },
            loginCount: 7,
          }) as unknown as { id: string },
      );

      throwAt(adapter, 'fat-user');
      expect((await drainedEnvelope()).reporter.user).toEqual({
        id: 'u_1',
        email: 'a@b.com',
        displayName: 'A',
      });
    });

    it('drops known keys whose value is not a string', async () => {
      const adapter = mk({ apiKey: 'pk_test' });
      adapter.__setBreadcrumbBuffer(() => createBreadcrumbBuffer());
      adapter.__setUserGetter(
        () => ({ id: 42, email: null, displayName: 'A' }) as unknown as { id: string },
      );

      throwAt(adapter, 'non-string-user');
      expect((await drainedEnvelope()).reporter.user).toEqual({ displayName: 'A' });
    });

    // A crash sink must never block or throw — a host getter that blows up
    // costs the crash its attribution, never the crash report itself.
    it('still reports the crash when the user getter throws', async () => {
      const adapter = mk({ apiKey: 'pk_test' });
      adapter.__setBreadcrumbBuffer(() => createBreadcrumbBuffer());
      adapter.__setUserGetter(() => {
        throw new Error('host getter exploded');
      });

      throwAt(adapter, 'throwing-getter');
      const env = (await drainedEnvelope()) as { reporter: { user?: unknown } } & {
        payload: { crash: { message: string } };
      };
      expect(env.payload.crash.message).toBe('throwing-getter');
      expect(env.reporter.user).toBeUndefined();
    });
  });

  // Codex round-1 finding S2 — the crash sink built its envelope via
  // buildCrashEnvelope() and enqueued it straight into the outbox with NO
  // vitals stamp at all, while the report path (draft-to-envelope.ts) has
  // stamped `sessionId` + a capped `payload.vitals` since Task 8. A crash
  // occurring mid-vitals-session shipped correlated to neither. Fixed via a
  // shared `stampActiveVitals()` helper (vitals/stamp-active-vitals.ts) both
  // call sites now use.
  describe('Session Vitals enrichment on the crash path (Codex round-1 finding S2)', () => {
    it('stamps sessionId + recent vitals onto the crash envelope when a session is active', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const vitals = setupVitals({
        config: { apiKey: 'pk_test' },
        apiKey: 'pk_test',
        apiUrl: 'https://ingest.test',
        isKilled: () => false,
        sdkVersion: '1.0.0',
      });
      __setVitalsServerConfig({ vitalsEnabled: true, vitalsSampleRate: 1 });
      expect(vitalsOnPlayerEvent).toBeDefined();
      vitalsOnPlayerEvent!({ t: Date.now(), type: 'play' });
      const active = __getActiveVitals();
      expect(active).toBeDefined();

      const adapter = mk({ apiKey: 'pk_test' });
      adapter.__setBreadcrumbBuffer(() => createBreadcrumbBuffer());

      const err = new Error('vitals-crash');
      err.stack = 'Error: vitals-crash\n    at f (a.ts:1:1)';
      window.onerror?.('vitals-crash', 'a.ts', 1, 1, err);

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
      const envelopeJson = JSON.parse(await (body.get('envelope') as Blob).text());

      expect(envelopeJson.sessionId).toBe(active!.sessionId);
      expect(envelopeJson.payload.vitals).toEqual(active!.recent());
      expect(envelopeJson.payload.vitals.length).toBeGreaterThan(0);

      vitals.destroy();
    });

    it('omits sessionId + payload.vitals when no vitals session is active', async () => {
      const adapter = mk({ apiKey: 'pk_test' });
      adapter.__setBreadcrumbBuffer(() => createBreadcrumbBuffer());

      const err = new Error('no-vitals-crash');
      err.stack = 'Error: no-vitals-crash\n    at f (a.ts:1:1)';
      window.onerror?.('no-vitals-crash', 'a.ts', 1, 1, err);

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
      const envelopeJson = JSON.parse(await (body.get('envelope') as Blob).text());

      expect(envelopeJson.sessionId).toBeUndefined();
      expect(envelopeJson.payload.vitals).toBeUndefined();
    });

    // A crash-envelope-sized ring past MAX_ENVELOPE_VITALS_ENTRIES (400)
    // serializes to tens of KB — enough to cross this SDK's own >8KB gzip
    // threshold (sdk-core's transport/multipart.ts) on the way out. jsdom's
    // `Blob` has no `.stream()`, so `CompressionStream` throws there — a
    // jsdom-only gap unrelated to this fix. Exercising the cap through the
    // full window.onerror -> outbox -> multipart/gzip -> fetch pipeline
    // would therefore fail in THIS test environment for a reason that has
    // nothing to do with the cap logic; drive `stampActiveVitals` (the
    // shared helper both this crash path and draft-to-envelope.ts's report
    // path call) directly instead — exactly what wiring.spec.ts's
    // equivalent draftToEnvelope cap test already does for the report side.
    it('caps payload.vitals at MAX_ENVELOPE_VITALS_ENTRIES even when the ring holds more', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const vitals = setupVitals({
        config: { apiKey: 'pk_test' },
        apiKey: 'pk_test',
        apiUrl: 'https://ingest.test',
        isKilled: () => false,
        sdkVersion: '1.0.0',
      });
      __setVitalsServerConfig({ vitalsEnabled: true, vitalsSampleRate: 1 });
      expect(vitalsOnPlayerEvent).toBeDefined();
      const entryCount = MAX_ENVELOPE_VITALS_ENTRIES + 50;
      for (let i = 0; i < entryCount; i++) {
        vitalsOnPlayerEvent!({ t: Date.now(), type: 'play' });
      }
      const active = __getActiveVitals()!;
      const allRecent = active.recent();
      expect(allRecent.length).toBe(entryCount);

      const envelope = {
        payload: {},
      } as unknown as Parameters<typeof stampActiveVitals>[0];
      stampActiveVitals(envelope);

      expect(envelope.sessionId).toBe(active.sessionId);
      expect(envelope.payload.vitals).toHaveLength(MAX_ENVELOPE_VITALS_ENTRIES);
      expect(envelope.payload.vitals).toEqual(allRecent.slice(-MAX_ENVELOPE_VITALS_ENTRIES));

      vitals.destroy();
    });
  });
});
