// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// PR review Finding 2 (P1, 2026-08-06 identity spec) — "never misattribute;
// lose attribution instead." An outbox entry must present the identity
// header ONLY when the subject active at DRAIN time matches the subject
// active at ENQUEUE time; on any mismatch (including "no current identity",
// or "no recorded subject at all" — an entry queued in a previous page-load
// session) the entry is sent anonymously instead. See
// packages/sdk-react/src/transport/submit.ts's module doc for the full
// design and the privacy reasoning for keeping the enqueue-time subject
// in-memory only (never persisted to the outbox's own durable storage).
//
// Test discipline note (per the PR review that opened this finding): assert
// on what the mock OBSERVED, captured into a variable, and check it in the
// test body AFTER the outcome — never assert from inside the fetch mock
// itself, since production catches and retries a rejected fetch and would
// silently swallow a failing in-mock assertion.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { submitReportFromDraft, drainOutbox } from '../../src/transport/submit.js';
import { createInMemoryOutbox } from '@everframe/sdk-core';
import type { OutboxAdapter, ReportDraft, IdentityTokenReader } from '@everframe/sdk-core';
import type { CaptureBundle } from '../../src/transport/draft-to-envelope.js';
import type { WebEverframeConfig } from '../../src/internal/types.js';

const config: WebEverframeConfig = {
  apiKey: 'txx_live_test',
  appName: 'test-app',
  appVersion: '1.0.0',
};
const INGEST_URL = 'http://localhost:8787';

const bundle: CaptureBundle = {
  screenshotBlob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
  screenshotSha256: 'a'.repeat(64),
  screenshotWidth: 1,
  screenshotHeight: 1,
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

const draft: ReportDraft = {
  title: 'X',
  description: '',
  excludedArtifacts: [],
  annotations: [],
  redactions: [],
};

/** A minimal well-formed (unsigned) JWT carrying only `sub` and a far-future `exp`. */
function mkJwt(sub: string): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ sub, exp: Math.floor(Date.now() / 1000) + 300 })}.sig`;
}

/** An IdentityTokenReader whose resolved token can be swapped between calls — simulates
 *  the identity active "right now" changing between enqueue time and drain time. */
function makeMutableIdentityReader(initial: string | null): {
  reader: IdentityTokenReader;
  setToken: (t: string | null) => void;
} {
  let current = initial;
  return {
    reader: { async get(): Promise<string | null> { return current; } },
    setToken: (t: string | null) => { current = t; },
  };
}

function makeFetch(status: number): typeof globalThis.fetch {
  return vi.fn(async () => new Response('{}', {
    status,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof globalThis.fetch;
}

describe('PR review Finding 2 — outbox drain never misattributes across an identity switch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends anonymously (no identity header) when the drain-time identity differs from the enqueue-time identity', async () => {
    const outbox: OutboxAdapter = createInMemoryOutbox();
    const alice = mkJwt('alice-sub');
    const bob = mkJwt('bob-sub');
    const { reader, setToken } = makeMutableIdentityReader(alice);

    // Alice is signed in when the report is filed; the submit fails (offline) and queues.
    const enqueueFetch = makeFetch(503);
    const enqueued = await submitReportFromDraft({
      config,
      sdkVersion: '0.1.0',
      draft,
      bundle,
      outbox,
      fetch: enqueueFetch,
      retryScheduleMs: [],
      identityToken: reader,
    });
    expect(enqueued.retryable).toBe(true);
    expect((await outbox.list()).length).toBe(1);

    // Alice signs out, Bob signs in — THEN the drain fires.
    setToken(bob);
    let observedHeader: string | undefined;
    const drainFetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      observedHeader = headers['X-Everframe-Identity-Token'];
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;

    const result = await drainOutbox({
      outbox,
      config,
      sdkVersion: '0.1.0',
      fetch: drainFetch,
      retryScheduleMs: [],
      identityToken: reader,
    });

    expect(result.submitted).toBe(1);
    // The load-bearing assertion, checked AFTER the drain resolved — never
    // inside the mock (see the module-level test-discipline note above).
    expect(observedHeader).toBeUndefined();
  });

  it('still attaches the identity header when the SAME identity is active at both enqueue and drain time', async () => {
    const outbox: OutboxAdapter = createInMemoryOutbox();
    const alice = mkJwt('alice-sub');
    const { reader } = makeMutableIdentityReader(alice);

    const enqueueFetch = makeFetch(503);
    await submitReportFromDraft({
      config,
      sdkVersion: '0.1.0',
      draft,
      bundle,
      outbox,
      fetch: enqueueFetch,
      retryScheduleMs: [],
      identityToken: reader,
    });
    expect((await outbox.list()).length).toBe(1);

    let observedHeader: string | undefined;
    const drainFetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      observedHeader = headers['X-Everframe-Identity-Token'];
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;

    const result = await drainOutbox({
      outbox,
      config,
      sdkVersion: '0.1.0',
      fetch: drainFetch,
      retryScheduleMs: [],
      identityToken: reader,
    });

    expect(result.submitted).toBe(1);
    expect(observedHeader).toBe(alice);
  });

  it('sends anonymously when the entry has no recorded subject at all (queued in a previous page-load session)', async () => {
    // Seeded directly into the outbox — bypasses submitReportFromDraft's
    // enqueue-time recording entirely, exactly like an entry that survived a
    // reload (the in-memory subject map does not).
    const outbox: OutboxAdapter = createInMemoryOutbox();
    const sentinel = JSON.stringify({ reportId: 'r-prev-session', protocolVersion: '1.0' });
    await outbox.enqueue({
      reportId: 'r-prev-session',
      enqueuedAt: 1,
      attempts: 0,
      payload: new TextEncoder().encode(sentinel),
      metadata: { url: `${INGEST_URL}/api/ingest`, sdkKey: config.apiKey },
    });

    const alice = mkJwt('alice-sub');
    const { reader } = makeMutableIdentityReader(alice); // Alice IS currently signed in

    let observedHeader: string | undefined;
    const drainFetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      observedHeader = headers['X-Everframe-Identity-Token'];
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;

    const result = await drainOutbox({
      outbox,
      config,
      sdkVersion: '0.1.0',
      fetch: drainFetch,
      retryScheduleMs: [],
      identityToken: reader,
    });

    expect(result.submitted).toBe(1);
    expect(observedHeader).toBeUndefined();
  });

  // PR review, round 2 (Minor) — `subjectGatedReader` compared
  // `decodeSub(token) === expectedSub`, so an entry recorded with
  // `expectedSub === null` (no identity active at enqueue time — anonymous
  // by construction) could still get a live token attached if the
  // drain-time token happened to decode to no `sub` at all (`null ===
  // null`). The server would reject that (`bad_subject`), so nothing was
  // ever actually misattributed, but a live credential should never go out
  // on a report the user filed anonymously as a matter of principle, not
  // server-side luck. Distinct from the "no recorded subject at all" test
  // above: this entry DOES have a record — the record is explicitly `null`
  // (recorded no-identity), not `undefined` (never recorded). The drain-time
  // token below is deliberately well-formed but WITHOUT a `sub` claim — a
  // real, live, malformed-for-this-purpose credential — which is exactly
  // the case that made `null === null` pass pre-fix; a token with a real
  // `sub` (e.g. Alice's) would already mismatch under the old comparison
  // too and wouldn't distinguish the two code paths.
  // ---- Final review, finding 2 (Important): the ENQUEUE-side window --------
  //
  // The drain-side gate above closed PR finding P1-3, but `submitReport`
  // resolves the identity once and then burns the whole retry schedule (~31s
  // by default) before returning `transient-exhausted`. Recording the subject
  // AFTER that call read whoever was active ~31s after the report was created.
  // Alice hits Submit with the network down; during the retry burst she signs
  // out and Bob signs in (or the host's provider simply starts returning Bob's
  // token); the recorded subject became BOB, so at drain the gate compared Bob
  // to Bob, MATCHED, and attached Bob's token — Alice's report permanently
  // attributed to Bob and readable from Bob's other devices. Same class as the
  // P1 that was just fixed, one step upstream.
  //
  // The swap is driven from inside the fetch mock (a side effect, not an
  // assertion — the load-bearing checks are all in the test body, per the
  // module note above) because that is literally the retry window: the network
  // call that is failing IS the ~31s the account switch happens during.
  it('records the subject from BEFORE the retry burst, so an account switch mid-retry cannot claim the report', async () => {
    const outbox: OutboxAdapter = createInMemoryOutbox();
    const alice = mkJwt('alice-sub');
    const bob = mkJwt('bob-sub');
    const { reader, setToken } = makeMutableIdentityReader(alice);

    // Alice files the report. The submit fails, and DURING that attempt the
    // signed-in user changes to Bob.
    let swapped = false;
    const enqueueFetch = vi.fn(async () => {
      setToken(bob);
      swapped = true;
      return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;

    const enqueued = await submitReportFromDraft({
      config,
      sdkVersion: '0.1.0',
      draft,
      bundle,
      outbox,
      fetch: enqueueFetch,
      retryScheduleMs: [],
      identityToken: reader,
    });
    expect(enqueued.retryable).toBe(true);
    // The window really did open — otherwise this test proves nothing.
    expect(swapped).toBe(true);
    expect((await outbox.list()).length).toBe(1);

    // Bob is still the one signed in when the drain fires.
    let observedHeader: string | undefined;
    const drainFetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      observedHeader = headers['X-Everframe-Identity-Token'];
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;

    const result = await drainOutbox({
      outbox,
      config,
      sdkVersion: '0.1.0',
      fetch: drainFetch,
      retryScheduleMs: [],
      identityToken: reader,
    });

    expect(result.submitted).toBe(1);
    // Pre-fix this was Bob's token: the recorded subject was read after the
    // swap, so Bob matched Bob and Alice's report went out under his name.
    expect(observedHeader).not.toBe(bob);
    expect(observedHeader).toBeUndefined();
  });

  it('the enqueue-time subject still matches when the SAME person is signed in throughout a retry burst', async () => {
    // The other half of the property: the fix must not simply throw
    // attribution away. Alice files, the attempt fails, Alice is still Alice —
    // the queued report is still hers at drain time.
    const outbox: OutboxAdapter = createInMemoryOutbox();
    const alice = mkJwt('alice-sub');
    const { reader } = makeMutableIdentityReader(alice);

    await submitReportFromDraft({
      config,
      sdkVersion: '0.1.0',
      draft,
      bundle,
      outbox,
      fetch: makeFetch(503),
      retryScheduleMs: [],
      identityToken: reader,
    });

    let observedHeader: string | undefined;
    const drainFetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      observedHeader = headers['X-Everframe-Identity-Token'];
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;

    const result = await drainOutbox({
      outbox,
      config,
      sdkVersion: '0.1.0',
      fetch: drainFetch,
      retryScheduleMs: [],
      identityToken: reader,
    });

    expect(result.submitted).toBe(1);
    expect(observedHeader).toBe(alice);
  });

  it('an entry queued anonymously stays anonymous even when a VALID (but subject-less) identity token is active at drain time', async () => {
    const outbox: OutboxAdapter = createInMemoryOutbox();
    const noOneSignedIn: IdentityTokenReader = { async get(): Promise<string | null> { return null; } };

    const enqueueFetch = makeFetch(503);
    await submitReportFromDraft({
      config,
      sdkVersion: '0.1.0',
      draft,
      bundle,
      outbox,
      fetch: enqueueFetch,
      retryScheduleMs: [],
      identityToken: noOneSignedIn, // recorded subject is explicitly null, not "unrecorded"
    });
    expect((await outbox.list()).length).toBe(1);

    // A live, well-formed token becomes available before the drain fires —
    // but it carries no `sub` claim (decodeSub resolves null for it too).
    const b64 = (o: unknown) =>
      btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const subjectLessToken = `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 300 })}.sig`;
    const { reader } = makeMutableIdentityReader(subjectLessToken);

    let observedHeader: string | undefined;
    const drainFetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      observedHeader = headers['X-Everframe-Identity-Token'];
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;

    const result = await drainOutbox({
      outbox,
      config,
      sdkVersion: '0.1.0',
      fetch: drainFetch,
      retryScheduleMs: [],
      identityToken: reader,
    });

    expect(result.submitted).toBe(1);
    // The load-bearing assertion: pre-fix, this would be the subject-less
    // token itself (a live credential attached to an anonymously-filed
    // report), not undefined.
    expect(observedHeader).toBeUndefined();
  });

  // ---- PR review, round 3 (Serious): the LIVE-submit half -----------------
  //
  // The enqueue-side fix above (recording the subject BEFORE the retry burst)
  // only protects a report that actually QUEUES. `submitReportFromDraft` was
  // still handing `submitReport` the raw `opts.identityToken` reader for the
  // live request, which resolves it a SECOND, INDEPENDENT time inside
  // http.ts. If the provider flips between the enqueue-time resolution (used
  // to compute `enqueueTimeSubject`, never actually checked against anything
  // since a SUCCESSFUL live attempt never queues) and http.ts's own
  // resolution, the live request goes out under the NEW identity — Alice's
  // report ships attributed to Bob, permanently, with no outbox entry for
  // any gate to ever catch. Same class of bug as the enqueue-side one, one
  // step further downstream, on the path where the report never queues at
  // all.
  it('pins the live request to ONE resolved token, even if the provider would answer differently on a second call', async () => {
    const alice = mkJwt('alice-sub');
    const bob = mkJwt('bob-sub');
    let calls = 0;
    // Simulates the account-switch race directly: first call (submit.ts's
    // own resolution) answers Alice, any subsequent call (what http.ts used
    // to trigger) answers Bob.
    const flippingReader: IdentityTokenReader = {
      async get(): Promise<string | null> {
        calls += 1;
        return calls === 1 ? alice : bob;
      },
    };

    let observedHeader: string | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      observedHeader = headers['X-Everframe-Identity-Token'];
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;

    const outbox: OutboxAdapter = createInMemoryOutbox();
    const result = await submitReportFromDraft({
      config,
      sdkVersion: '0.1.0',
      draft,
      bundle,
      outbox,
      fetch: fetchImpl,
      retryScheduleMs: [],
      identityToken: flippingReader,
    });

    expect(result.ok).toBe(true);
    // The load-bearing assertion, checked AFTER the submit resolved: pre-fix,
    // this was Bob's token (http.ts's own, second, independent resolution).
    expect(observedHeader).toBe(alice);
    expect(observedHeader).not.toBe(bob);
    // Also closes the parked latency issue from the same review round: two
    // independent resolutions meant up to two IDENTITY_PROVIDER_TIMEOUT_MS
    // round-trips (~4s worst case) for one submit. Pinning collapses this to
    // exactly one call to the real reader.
    expect(calls).toBe(1);
  });
});
