// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// The mount-time outbox drain `init()` performs, and the two ways it could
// ship something it should not (Codex round-1 findings 3 and 8).
//
// FINDING 8 — the identity gate. A drain that fires before `/api/config`
// resolves reads `identity.enabled` at its fail-closed OFF default, so a
// queued entry whose enqueue-time subject WOULD match the signed-in host
// drains ANONYMOUSLY — and since that submit succeeds, nothing ever retries
// it. `init.ts` guards this with a bounded wait, but only when an identity
// source is already set at the instant the drain is decided. Called
// synchronously from inside `init()` that is NEVER true (the client is two
// lines old and the host cannot have called `setIdentityToken` yet, because
// `init()` has not returned the handle), so the guard was unreachable on the
// one call that needs it. `init.ts` now defers the first drain by a microtask,
// which is the vanilla equivalent of the child-effects-before-parent-effects
// ordering `provider.tsx` relies on for the same guard.
//
// FINDING 3 — teardown. The drain continuation checked neither `disposed` nor
// the client's killed state, so `init()` + a queued entry + an immediate
// `destroy()` (or `kill()`) still POSTed after teardown.
//
// These specs use a DEFERRED `/api/config` response resolved by hand, so drain
// TIMING is directly observable against the stubbed ingest endpoint. This is
// the vanilla port of `sdk-react`'s provider-outbox-drain-identity-gate.spec.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { IDENTITY_PROVIDER_TIMEOUT_MS } from '@everframe/sdk-core';
import { init, type Everframe } from '../src/init.js';
import { createLocalStorageOutbox } from '../src/outbox/localStorage.js';

const APP_KEY = 'txx_live_web_drain_test';
const config = { apiKey: APP_KEY };

let handles: Everframe[] = [];
function mount(): Everframe {
  const h = init(config);
  handles.push(h);
  return h;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  handles.forEach((h) => h.destroy());
  handles = [];
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** A minimal well-formed (unsigned) JWT. Content is irrelevant here — these
 *  specs observe DRAIN TIMING, not header attribution. */
function mkJwt(): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ sub: 'alice-sub', exp: Math.floor(Date.now() / 1000) + 300 })}.sig`;
}

async function seedOutboxItem(reportId: string, sdkKey: string): Promise<void> {
  const ob = createLocalStorageOutbox()!;
  await ob.enqueue({
    reportId,
    enqueuedAt: 1,
    attempts: 0,
    payload: new TextEncoder().encode(JSON.stringify({ reportId, protocolVersion: '1.0' })),
    metadata: { sdkKey },
  });
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : (input as Request).url;
}

/** Deferred `/api/config` (resolved via `resolveConfig`), observed `/api/ingest`. */
function stubDeferredConfigFetch(): { ingest: string[]; resolveConfig: () => void } {
  const ingest: string[] = [];
  let resolveConfig!: () => void;
  const gate = new Promise<void>((resolve) => {
    resolveConfig = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.includes('/api/ingest')) {
        ingest.push(url);
        return new Response(
          JSON.stringify({
            status: 'received',
            eventId: 'e1',
            deliveryCount: 0,
            idempotent: false,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/config')) {
        await gate; // pending until the test says otherwise
        return new Response(
          JSON.stringify({ replayEnabled: false, replayDurationSec: 30, samplingRate: 1 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/api/reporter/threads')) {
        return new Response(JSON.stringify({ threads: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200 });
    }),
  );
  return { ingest, resolveConfig };
}

/** Let microtasks and real macrotasks settle. */
const flush = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('finding 8 — the mount drain waits for config when the host sets a token right after init()', () => {
  it('holds a queued report until /api/config resolves, then drains it', async () => {
    await seedOutboxItem('r1', APP_KEY);
    const { ingest, resolveConfig } = stubDeferredConfigFetch();

    // The canonical vanilla integration, and the one the finding is about:
    // both statements run in the SAME synchronous block, so the token is set
    // before any microtask can run — but strictly after `init()` returned.
    const tx = mount();
    tx.setIdentityToken(mkJwt());

    await flush(20);
    // Pre-fix this read 1: the drain was decided (and dispatched) inside
    // `init()`, when `hasSource()` could not yet be true.
    expect(ingest.length).toBe(0);

    resolveConfig();
    await flush(30);
    expect(ingest.length).toBe(1);
  });

  it('proceeds anyway once IDENTITY_PROVIDER_TIMEOUT_MS elapses, even if config never resolves', async () => {
    await seedOutboxItem('r1', APP_KEY);
    const { ingest } = stubDeferredConfigFetch(); // resolveConfig deliberately never called

    const tx = mount();
    tx.setIdentityToken(mkJwt());

    await flush(20);
    expect(ingest.length).toBe(0); // still waiting, config hung

    // Identity must never delay a report indefinitely.
    await flush(IDENTITY_PROVIDER_TIMEOUT_MS + 300);
    expect(ingest.length).toBe(1);
  }, 10_000);

  // NON-DISCRIMINATING by construction, and kept anyway: pre-fix EVERY mount
  // drain fired immediately regardless of source, so this passed then too. It
  // locks the wait as CONDITIONAL — a future change that made all reports wait
  // on config (delaying delivery for hosts that never recognise anyone) fails
  // here.
  it('does not delay the drain at all when the host sets no identity token', async () => {
    await seedOutboxItem('r1', APP_KEY);
    const { ingest } = stubDeferredConfigFetch(); // never resolved, and never should matter

    mount();

    await flush(20);
    expect(ingest.length).toBe(1);
  });
});

describe('finding 3 — a scheduled drain must not outlive the instance', () => {
  it('LIVE control: a queued report from a previous session drains on init()', async () => {
    await seedOutboxItem('r1', APP_KEY);
    const { ingest } = stubDeferredConfigFetch();

    mount();

    await flush(30);
    expect(ingest.length).toBe(1);
  });

  it('destroy() immediately after init() cancels the drain', async () => {
    await seedOutboxItem('r1', APP_KEY);
    const { ingest } = stubDeferredConfigFetch();

    mount().destroy();

    await flush(50);
    expect(ingest.length).toBe(0);
  });

  it('kill() immediately after init() cancels the drain', async () => {
    await seedOutboxItem('r1', APP_KEY);
    const { ingest } = stubDeferredConfigFetch();

    mount().kill();

    await flush(50);
    expect(ingest.length).toBe(0);
  });

  // The two above are settled before the drain's `await`; these two land
  // DURING it, which is the only thing the post-await re-check can catch —
  // deleting just that re-check leaves the pair above green and these red.
  it('destroy() while the drain is parked on the config wait cancels it', async () => {
    await seedOutboxItem('r1', APP_KEY);
    const { ingest, resolveConfig } = stubDeferredConfigFetch();

    const tx = mount();
    tx.setIdentityToken(mkJwt()); // arms the bounded wait
    await flush(20);
    expect(ingest.length).toBe(0); // parked on config, as finding 8's spec proves

    tx.destroy();
    resolveConfig();
    await flush(50);
    expect(ingest.length).toBe(0);
  });

  it('kill() while the drain is parked on the config wait cancels it', async () => {
    await seedOutboxItem('r1', APP_KEY);
    const { ingest, resolveConfig } = stubDeferredConfigFetch();

    const tx = mount();
    tx.setIdentityToken(mkJwt());
    await flush(20);
    expect(ingest.length).toBe(0);

    tx.kill();
    resolveConfig();
    await flush(50);
    expect(ingest.length).toBe(0);
  });
});
