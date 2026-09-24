// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// PR review Finding 2 (P1, 2026-08-06 identity spec), second half: the
// mount-time "best-effort drain" (provider.tsx) fired `drainOutbox(...)`
// synchronously, before the `/api/config` fetch (which resolves
// `identity.enabled`) had settled. Until that fetch resolves,
// `identityTokenReader` (adapter.ts) reads the fail-closed OFF default, so
// any queued entry whose enqueue-time subject WOULD match the now-signed-in
// host instead drains anonymously — and since that submit still succeeds,
// nothing ever retries it. The concrete trigger: this Provider remounts
// (route change, or React StrictMode's dev double-invoke) while the
// in-memory `enqueuedSubjects` map (submit.ts — module-scoped, so it
// survives a Provider remount) still holds a real subject recorded under
// the PREVIOUS mount's config, but the NEW adapter's config provider hasn't
// resolved yet.
//
// The fix: when an identity source is ALREADY set at the moment a drain
// fires, wait (bounded by `IDENTITY_PROVIDER_TIMEOUT_MS`, the SAME timeout
// the identity provider itself is bounded by — no second knob invented) for
// config to resolve before draining, then proceed regardless — identity
// must never delay a report indefinitely.
//
// These specs render the real Provider with a DEFERRED `/api/config`
// response (resolved manually mid-test) so the mount-time drain's timing
// can be observed directly against a stubbed `/api/ingest`. A host's own
// identity-wiring component is rendered AS A CHILD of the Provider — its
// mount effect (which calls `setIdentityToken`) commits before the parent
// Provider's own effects in the same React commit, matching how a real host
// integration is typically structured (auth wiring nested inside the
// Provider tree).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useContext, useEffect } from 'react';
import { EverframeProvider, EverframeContext } from '../src/provider.js';
import { createLocalStorageOutbox } from '@everframe/web';
import { IDENTITY_PROVIDER_TIMEOUT_MS } from '@everframe/sdk-core';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const APP_KEY = 'txx_live_identity_gate_test';
const config = { apiKey: APP_KEY };

/** A minimal well-formed (unsigned) JWT — content doesn't matter for these
 *  specs, which only observe DRAIN TIMING, not header attribution. */
function mkJwt(): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ sub: 'alice-sub', exp: Math.floor(Date.now() / 1000) + 300 })}.sig`;
}

/** Calls `client.setIdentityToken` from ITS OWN mount effect. Rendered as a
 *  CHILD of EverframeProvider so its effect commits before the Provider's own
 *  (React runs child effects before parent effects in the same commit) —
 *  the ordering a real host's auth-wiring component would also produce. */
function IdentitySetter({ token }: { token: string }) {
  const ctx = useContext(EverframeContext);
  useEffect(() => {
    ctx?.client.setIdentityToken(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
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

/** Flush pending microtasks + real macrotasks so in-flight async work settles. */
async function flush(ms = 20): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** Stubs fetch with a DEFERRED `/api/config` response (resolved via the
 *  returned `resolveConfig`), a normal `/api/ingest` (observed via
 *  `ingestCalls`), and an empty `/api/reporter/threads`. */
function stubDeferredConfigFetch(): { ingestCalls: number[]; resolveConfig: () => void } {
  const ingestCalls: number[] = [];
  let resolveConfig!: () => void;
  const configGate = new Promise<void>((resolve) => { resolveConfig = resolve; });
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = urlOf(input);
    if (url.includes('/api/ingest')) {
      ingestCalls.push(Date.now());
      return new Response(
        JSON.stringify({ status: 'received', eventId: 'e1', deliveryCount: 0, idempotent: false }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/api/config')) {
      await configGate; // stays pending until the test resolves it
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
  });
  vi.stubGlobal('fetch', impl);
  return { ingestCalls, resolveConfig };
}

describe('PR review Finding 2 (second half) — mount drain waits for config when an identity source is set', () => {
  it('does not drain a tagged entry before /api/config resolves, then drains once it does', async () => {
    await seedOutboxItem('r1', APP_KEY);
    const { ingestCalls, resolveConfig } = stubDeferredConfigFetch();

    render(
      <EverframeProvider config={config}>
        <IdentitySetter token={mkJwt()} />
      </EverframeProvider>,
    );

    // Shortly after mount, config is still pending — the drain must not have
    // fired yet.
    await flush(20);
    expect(ingestCalls.length).toBe(0);

    // Config resolves — the drain proceeds.
    resolveConfig();
    await flush(30);
    expect(ingestCalls.length).toBe(1);
  });

  it('proceeds anyway once IDENTITY_PROVIDER_TIMEOUT_MS elapses, even if /api/config never resolves', async () => {
    await seedOutboxItem('r1', APP_KEY);
    const { ingestCalls } = stubDeferredConfigFetch(); // resolveConfig deliberately never called

    render(
      <EverframeProvider config={config}>
        <IdentitySetter token={mkJwt()} />
      </EverframeProvider>,
    );

    await flush(20);
    expect(ingestCalls.length).toBe(0); // still waiting, config hung

    // Real-time wait past the bound — identity must never delay a report
    // indefinitely, so the drain proceeds regardless of the hung config.
    await flush(IDENTITY_PROVIDER_TIMEOUT_MS + 200);
    expect(ingestCalls.length).toBe(1);
  }, 10_000);

  // Non-discriminating regression guard (does NOT fail against the unfixed
  // provider.tsx — pre-fix, EVERY mount drain fired immediately regardless
  // of source, so this passes trivially both before and after the fix). Kept
  // to lock in that the wait is conditional on a source being set, not
  // unconditional, so a future change can't silently make ALL reports wait
  // on config.
  it('does not delay the mount drain at all when no identity source is set', async () => {
    await seedOutboxItem('r1', APP_KEY);
    const { ingestCalls } = stubDeferredConfigFetch(); // never resolved, and never should matter here

    render(<EverframeProvider config={config}>{null}</EverframeProvider>);

    await flush(20);
    expect(ingestCalls.length).toBe(1); // drained immediately, no source to protect
  });
});
