// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { submitReportFromDraft, drainOutbox } from '../../src/transport/submit.js';
import { createInMemoryOutbox } from '@traceitx/sdk-core';
import type { OutboxAdapter, ReportDraft, ReporterCredentialStore } from '@traceitx/sdk-core';
import type { CaptureBundle } from '../../src/transport/draft-to-envelope.js';
import type { WebTraceItXConfig } from '../../src/internal/types.js';

const config: WebTraceItXConfig = {
  apiKey: 'txx_live_test',
  appName: 'test-app',
  appVersion: '1.0.0',
};

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

const baseDeps = {
  config,
  sdkVersion: '0.1.0',
  draft,
  bundle,
  outbox: undefined,
  retryScheduleMs: [],
};

function makeResponseFetch(bodyObj: Record<string, unknown>): ReturnType<typeof vi.fn> {
  return vi.fn(async () => new Response(JSON.stringify({
    status: 'received',
    eventId: 'e1',
    deliveryCount: 0,
    idempotent: false,
    ...bodyObj,
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
}

describe('submitReportFromDraft — device token', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('presents an existing token, saves a server-minted one, and reports threadId', async () => {
    const saved: string[] = [];
    const store: ReporterCredentialStore = {
      randomBytes: (n: number) => new Uint8Array(n).fill(7),
      load: async () => null, // no token yet -> SDK mints
      save: async (t: string) => { saved.push(t); },
      clear: async () => {},
    };
    const fetchImpl = makeResponseFetch({ thread: { id: 't9' } });
    const result = await submitReportFromDraft({
      ...baseDeps,
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      credentials: store,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    const headers = call[1].headers;
    expect(headers['X-TX-Device-Token']).toMatch(/^txr_[A-Za-z0-9_-]{43}$/); // minted via ensureDeviceToken
    expect(saved).toHaveLength(1); // ensureDeviceToken persisted the mint
    expect(result.threadId).toBe('t9');
  });

  it('reports threadId null when the server omits the block', async () => {
    const store: ReporterCredentialStore = {
      randomBytes: (n: number) => new Uint8Array(n).fill(7),
      load: async () => 'txr_' + 'b'.repeat(43),
      save: async () => {},
      clear: async () => {},
    };
    const fetchImpl = makeResponseFetch({});
    const result = await submitReportFromDraft({
      ...baseDeps,
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      credentials: store,
    });
    expect(result.threadId).toBeNull();
  });

  it('never fails a submit when ensureDeviceToken throws', async () => {
    const store: ReporterCredentialStore = {
      randomBytes: () => { throw new Error('no CSPRNG'); },
      load: async () => { throw new Error('denied'); },
      save: async () => {},
      clear: async () => {},
    };
    const fetchImpl = makeResponseFetch({});
    const result = await submitReportFromDraft({
      ...baseDeps,
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      credentials: store,
    });
    expect(result.ok).toBe(true);
    const call = fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(call[1].headers['X-TX-Device-Token']).toBeUndefined();
  });

  it('does not set a device token header when credentials is omitted', async () => {
    const fetchImpl = makeResponseFetch({});
    await submitReportFromDraft({
      ...baseDeps,
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(call[1].headers['X-TX-Device-Token']).toBeUndefined();
  });

  // Finding 1-CLIENT — the local veto (`replies: { disabled: true }`) nulls
  // `deps.credentials`, so no device token is presented on submit. But the
  // server's no-token fallback still provisions a thread and echoes
  // `{ thread, device }` back regardless — it has no way to know the client
  // is locally vetoed. Pre-fix, `threadId: result.thread?.id ?? null` echoed
  // that thread id straight back into the outcome even with no credentials
  // store in play, which made the Provider show the reply-aware toast and
  // wake() a thread client that (under the veto) doesn't even exist. Once no
  // credentials seam is in play, reply metadata must be ignored end-to-end:
  // no threadId, no persisted token.
  it('ignores a server-provisioned thread/device block end-to-end when no credentials store is in play (local veto)', async () => {
    const fetchImpl = makeResponseFetch({
      thread: { id: 't9' },
      device: { token: 'txr_' + 'c'.repeat(43) },
    });
    const result = await submitReportFromDraft({
      ...baseDeps,
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      credentials: null, // the veto already nulls the seam before this call
    });
    expect(result.threadId).toBeNull();
    // No X-TX-Device-Token header was ever sent (the veto omits it), and
    // nothing exists to persist into since the seam itself is null — the
    // fix must not conjure a store to write to just because the server
    // echoed a thread/device block.
    const call = fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(call[1].headers['X-TX-Device-Token']).toBeUndefined();
  });

  // Round-5 PR-review item 6 — the local veto (`replies: { disabled: true }`)
  // must also tell the SERVER not to provision a thread/device on its
  // no-token fallback (previously it would mint one anyway, creating an
  // admin-visible conversation the reporter can never see). `opts.config` is
  // directly reachable at this call site, so the opt-out is read straight
  // off `config.replies?.disabled` — the same boolean the adapter used to
  // decide whether to null out `credentials` in the first place (see
  // adapter.ts's `reporterCredentials` seam), rather than re-derived from
  // `credentials`'s absence.
  it('sends X-TX-Replies-Opt-Out: 1 when the local veto (config.replies.disabled) is active', async () => {
    const fetchImpl = makeResponseFetch({});
    await submitReportFromDraft({
      ...baseDeps,
      config: { ...config, replies: { disabled: true } },
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      credentials: null,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(call[1].headers['X-TX-Replies-Opt-Out']).toBe('1');
  });

  it('does not send X-TX-Replies-Opt-Out when the local veto is not active', async () => {
    const store: ReporterCredentialStore = {
      randomBytes: (n: number) => new Uint8Array(n).fill(7),
      load: async () => 'txr_' + 'b'.repeat(43),
      save: async () => {},
      clear: async () => {},
    };
    const fetchImpl = makeResponseFetch({});
    await submitReportFromDraft({
      ...baseDeps,
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      credentials: store,
    });
    const call = fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect('X-TX-Replies-Opt-Out' in call[1].headers).toBe(false);
  });
});

// Finding 3 (round-4 PR review): drainOutbox resolves `deviceToken` ONCE for
// the whole batch, then on each item's response saves any `result.device.token`
// to the store WITHOUT updating the batch-local variable. With two queued
// items and a revoked/absent token, both requests present the STALE token,
// each response mints a DIFFERENT replacement, and only the second one
// survives in the store — the first conversation's replacement is discarded
// even though it was the one actually presented (and accepted) by the first
// request. The fix must feed a response's `device.token` back into the
// batch-local variable immediately so every subsequent item in the SAME
// drain presents the identity the server just accepted.
const INGEST_URL = 'http://localhost:8787';

describe('drainOutbox — device token rotation propagates within a batch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("propagates a server-minted replacement token to the batch's subsequent items", async () => {
    const originalToken = 'txr_' + 'a'.repeat(43);
    const rotatedToken = 'txr_' + 'f'.repeat(43);
    let stored = originalToken;
    const store: ReporterCredentialStore = {
      randomBytes: (n: number) => new Uint8Array(n).fill(7),
      load: async () => stored,
      save: async (t: string) => { stored = t; },
      clear: async () => {},
    };
    const outbox: OutboxAdapter = createInMemoryOutbox();
    await outbox.enqueue({
      reportId: 'r1',
      enqueuedAt: 1,
      attempts: 0,
      payload: new TextEncoder().encode(JSON.stringify({ reportId: 'r1', protocolVersion: '1.0' })),
      metadata: { url: `${INGEST_URL}/api/ingest`, sdkKey: config.apiKey },
    });
    await outbox.enqueue({
      reportId: 'r2',
      enqueuedAt: 2,
      attempts: 0,
      payload: new TextEncoder().encode(JSON.stringify({ reportId: 'r2', protocolVersion: '1.0' })),
      metadata: { url: `${INGEST_URL}/api/ingest`, sdkKey: config.apiKey },
    });

    let callIndex = 0;
    const fetchImpl = vi.fn(async () => {
      const isFirstCall = callIndex === 0;
      callIndex += 1;
      const body =
        isFirstCall
          ? { thread: { id: 't1' }, device: { token: rotatedToken } }
          : {};
      return new Response(
        JSON.stringify({
          status: 'received',
          eventId: 'e1',
          deliveryCount: 0,
          idempotent: false,
          ...body,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const result = await drainOutbox({
      outbox,
      config,
      sdkVersion: '0.1.0',
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      retryScheduleMs: [],
      credentials: store,
    });

    expect(result.submitted).toBe(2);
    expect(fetchImpl.mock.calls).toHaveLength(2);

    const firstHeaders = (fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1].headers;
    const secondHeaders = (fetchImpl.mock.calls[1] as unknown as [string, { headers: Record<string, string> }])[1].headers;

    // First item presents the original (possibly revoked) token — that's what
    // triggered the server to mint a replacement in the first place.
    expect(firstHeaders['X-TX-Device-Token']).toBe(originalToken);
    // The SECOND item must present the rotated token the first response
    // handed back, not the stale original.
    expect(secondHeaders['X-TX-Device-Token']).toBe(rotatedToken);
    // And the store must hold exactly the rotated token at the end.
    expect(stored).toBe(rotatedToken);
  });

  it('unchanged: with no rotation, both items present the same original token', async () => {
    const originalToken = 'txr_' + 'a'.repeat(43);
    let stored = originalToken;
    const store: ReporterCredentialStore = {
      randomBytes: (n: number) => new Uint8Array(n).fill(7),
      load: async () => stored,
      save: async (t: string) => { stored = t; },
      clear: async () => {},
    };
    const outbox: OutboxAdapter = createInMemoryOutbox();
    await outbox.enqueue({
      reportId: 'r1',
      enqueuedAt: 1,
      attempts: 0,
      payload: new TextEncoder().encode(JSON.stringify({ reportId: 'r1', protocolVersion: '1.0' })),
      metadata: { url: `${INGEST_URL}/api/ingest`, sdkKey: config.apiKey },
    });
    await outbox.enqueue({
      reportId: 'r2',
      enqueuedAt: 2,
      attempts: 0,
      payload: new TextEncoder().encode(JSON.stringify({ reportId: 'r2', protocolVersion: '1.0' })),
      metadata: { url: `${INGEST_URL}/api/ingest`, sdkKey: config.apiKey },
    });

    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ status: 'received', eventId: 'e1', deliveryCount: 0, idempotent: false }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    await drainOutbox({
      outbox,
      config,
      sdkVersion: '0.1.0',
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      retryScheduleMs: [],
      credentials: store,
    });

    const firstHeaders = (fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1].headers;
    const secondHeaders = (fetchImpl.mock.calls[1] as unknown as [string, { headers: Record<string, string> }])[1].headers;
    expect(firstHeaders['X-TX-Device-Token']).toBe(originalToken);
    expect(secondHeaders['X-TX-Device-Token']).toBe(originalToken);
    expect(stored).toBe(originalToken);
  });
});

// Round-5 PR-review item 6, drain-path companion to the submit-path tests
// above: the outbox drain must send the SAME opt-out header, for the SAME
// reason — a vetoed client presents no device token on a drained item
// either, so the server's no-token fallback must be told not to provision a
// thread for it.
describe('drainOutbox — replies opt-out header', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function drainOneItem(opts: {
    fetchImpl: ReturnType<typeof vi.fn>;
    driveConfig: WebTraceItXConfig;
    credentials?: ReporterCredentialStore | null;
  }) {
    const outbox: OutboxAdapter = createInMemoryOutbox();
    await outbox.enqueue({
      reportId: 'r1',
      enqueuedAt: 1,
      attempts: 0,
      payload: new TextEncoder().encode(JSON.stringify({ reportId: 'r1', protocolVersion: '1.0' })),
      metadata: { url: `${INGEST_URL}/api/ingest`, sdkKey: opts.driveConfig.apiKey },
    });
    await drainOutbox({
      outbox,
      config: opts.driveConfig,
      sdkVersion: '0.1.0',
      fetch: opts.fetchImpl as unknown as typeof globalThis.fetch,
      retryScheduleMs: [],
      ...(opts.credentials !== undefined ? { credentials: opts.credentials } : {}),
    });
  }

  it('sends X-TX-Replies-Opt-Out: 1 on a drained item when the local veto is active', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ status: 'received', eventId: 'e1', deliveryCount: 0, idempotent: false }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    await drainOneItem({
      fetchImpl,
      driveConfig: { ...config, replies: { disabled: true } },
      credentials: null,
    });
    const headers = (fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1].headers;
    expect(headers['X-TX-Replies-Opt-Out']).toBe('1');
  });

  it('does not send X-TX-Replies-Opt-Out on a drained item when the local veto is not active', async () => {
    const store: ReporterCredentialStore = {
      randomBytes: (n: number) => new Uint8Array(n).fill(7),
      load: async () => 'txr_' + 'd'.repeat(43),
      save: async () => {},
      clear: async () => {},
    };
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ status: 'received', eventId: 'e1', deliveryCount: 0, idempotent: false }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    await drainOneItem({ fetchImpl, driveConfig: config, credentials: store });
    const headers = (fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1].headers;
    expect('X-TX-Replies-Opt-Out' in headers).toBe(false);
  });
});

// Round-6 PR-review Finding 1 (HIGH) — the localStorage outbox is
// origin-wide (every `traceitx:outbox:*` key regardless of which mounted
// app enqueued it), but each app owns an app-SCOPED reply credential
// (device token + veto). Pre-fix, `drainOutbox` resolved ONE token and ONE
// `repliesOptOut` from whichever app happens to be mounted and applied it
// to EVERY queued item, taking only the request's API key from the item's
// own metadata. That sent app A's queued report with app B's device token
// (and B's local veto), and any server-minted replacement token for A's
// report got persisted into B's scoped credential store — orphaning A's
// new thread and corrupting B's credential.
//
// The fix resolves reply context PER ITEM, keyed off the item's own
// effective sdk key (`item.metadata?.sdkKey ?? opts.config.apiKey`)
// compared against the currently-mounted app's `opts.config.apiKey`.
describe('drainOutbox — per-item app scoping (round-6 Finding 1)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const APP_A_KEY = 'txx_live_app_a';
  const APP_B_KEY = 'txx_live_app_b';
  const configB: WebTraceItXConfig = { ...config, apiKey: APP_B_KEY };

  async function seedTwoAppOutbox(): Promise<OutboxAdapter> {
    const outbox: OutboxAdapter = createInMemoryOutbox();
    // Enqueued by app B (matches the currently-mounted app).
    await outbox.enqueue({
      reportId: 'r-b',
      enqueuedAt: 1,
      attempts: 0,
      payload: new TextEncoder().encode(JSON.stringify({ reportId: 'r-b', protocolVersion: '1.0' })),
      metadata: { url: `${INGEST_URL}/api/ingest`, sdkKey: APP_B_KEY },
    });
    // Enqueued by app A (a DIFFERENT app than the one currently mounted).
    await outbox.enqueue({
      reportId: 'r-a',
      enqueuedAt: 2,
      attempts: 0,
      payload: new TextEncoder().encode(JSON.stringify({ reportId: 'r-a', protocolVersion: '1.0' })),
      metadata: { url: `${INGEST_URL}/api/ingest`, sdkKey: APP_A_KEY },
    });
    return outbox;
  }

  it("presents app B's token with no opt-out for the B item, and app A's key with NO device token but the opt-out header for the A item", async () => {
    const bToken = 'txr_' + 'b'.repeat(43);
    let storedB = bToken;
    const storeB: ReporterCredentialStore = {
      randomBytes: (n: number) => new Uint8Array(n).fill(7),
      load: async () => storedB,
      save: async (t: string) => { storedB = t; },
      clear: async () => {},
    };
    const outbox = await seedTwoAppOutbox();

    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ status: 'received', eventId: 'e1', deliveryCount: 0, idempotent: false }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    const result = await drainOutbox({
      outbox,
      config: configB,
      sdkVersion: '0.1.0',
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      retryScheduleMs: [],
      credentials: storeB,
    });

    expect(result.submitted).toBe(2);
    expect(fetchImpl.mock.calls).toHaveLength(2);

    type Call = [string, { headers: Record<string, string> }];
    const calls = fetchImpl.mock.calls as unknown as Call[];
    const bCall = calls.find((c) => c[1].headers.Authorization === `Bearer ${APP_B_KEY}`);
    const aCall = calls.find((c) => c[1].headers.Authorization === `Bearer ${APP_A_KEY}`);
    expect(bCall).toBeDefined();
    expect(aCall).toBeDefined();

    // The B item: this app's token presented, no opt-out header.
    expect(bCall![1].headers['X-TX-Device-Token']).toBe(bToken);
    expect('X-TX-Replies-Opt-Out' in bCall![1].headers).toBe(false);

    // The A (foreign) item: NO device token, and the opt-out header IS sent
    // even though app B's own local veto is not active.
    expect(aCall![1].headers['X-TX-Device-Token']).toBeUndefined();
    expect(aCall![1].headers['X-TX-Replies-Opt-Out']).toBe('1');

    // App B's store is unaffected by the foreign item.
    expect(storedB).toBe(bToken);
  });

  it("does not persist a foreign item's server-minted device token into this app's store", async () => {
    const bToken = 'txr_' + 'b'.repeat(43);
    let storedB = bToken;
    const storeB: ReporterCredentialStore = {
      randomBytes: (n: number) => new Uint8Array(n).fill(7),
      load: async () => storedB,
      save: async (t: string) => { storedB = t; },
      clear: async () => {},
    };
    const outbox: OutboxAdapter = createInMemoryOutbox();
    // Only the foreign (app A) item this time.
    await outbox.enqueue({
      reportId: 'r-a',
      enqueuedAt: 1,
      attempts: 0,
      payload: new TextEncoder().encode(JSON.stringify({ reportId: 'r-a', protocolVersion: '1.0' })),
      metadata: { url: `${INGEST_URL}/api/ingest`, sdkKey: APP_A_KEY },
    });

    const foreignMintedToken = 'txr_' + 'f'.repeat(43);
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({
        status: 'received',
        eventId: 'e1',
        deliveryCount: 0,
        idempotent: false,
        thread: { id: 't-orphan' },
        device: { token: foreignMintedToken },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    const result = await drainOutbox({
      outbox,
      config: configB,
      sdkVersion: '0.1.0',
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      retryScheduleMs: [],
      credentials: storeB,
    });

    expect(result.submitted).toBe(1);
    // B's store is byte-for-byte unchanged — the foreign item's minted
    // token must never be adopted.
    expect(storedB).toBe(bToken);
    // A foreign item's thread must not count toward THIS app's
    // provisioned-thread signal (round-6 Finding 2's wake trigger).
    expect(result.provisionedThreadIds).toEqual([]);
  });
});

// Round-6 PR-review Finding 2 (HIGH) — a successful outbox retry that
// provisions a thread must be OBSERVABLE to the caller so it can wake the
// idle poller (provider.tsx wires this into `adapter.threads?.wake()`).
// Pre-fix, `drainOutbox` returned only `{ submitted, failed }`, deliberately
// dropping any `result.thread` from a successful response.
describe('drainOutbox — provisionedThreadIds (round-6 Finding 2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports the thread id when a THIS-app item provisions a thread', async () => {
    const store: ReporterCredentialStore = {
      randomBytes: (n: number) => new Uint8Array(n).fill(7),
      load: async () => null,
      save: async () => {},
      clear: async () => {},
    };
    const outbox: OutboxAdapter = createInMemoryOutbox();
    await outbox.enqueue({
      reportId: 'r1',
      enqueuedAt: 1,
      attempts: 0,
      payload: new TextEncoder().encode(JSON.stringify({ reportId: 'r1', protocolVersion: '1.0' })),
      metadata: { url: `${INGEST_URL}/api/ingest`, sdkKey: config.apiKey },
    });
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({
        status: 'received',
        eventId: 'e1',
        deliveryCount: 0,
        idempotent: false,
        thread: { id: 't-new' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const result = await drainOutbox({
      outbox,
      config,
      sdkVersion: '0.1.0',
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      retryScheduleMs: [],
      credentials: store,
    });
    expect(result.provisionedThreadIds).toEqual(['t-new']);
  });

  it('reports an empty list when no item provisions a thread', async () => {
    const outbox: OutboxAdapter = createInMemoryOutbox();
    await outbox.enqueue({
      reportId: 'r1',
      enqueuedAt: 1,
      attempts: 0,
      payload: new TextEncoder().encode(JSON.stringify({ reportId: 'r1', protocolVersion: '1.0' })),
      metadata: { url: `${INGEST_URL}/api/ingest`, sdkKey: config.apiKey },
    });
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ status: 'received', eventId: 'e1', deliveryCount: 0, idempotent: false }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const result = await drainOutbox({
      outbox,
      config,
      sdkVersion: '0.1.0',
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      retryScheduleMs: [],
    });
    expect(result.provisionedThreadIds).toEqual([]);
  });
});
