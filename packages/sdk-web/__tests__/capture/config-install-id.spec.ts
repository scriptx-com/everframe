// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Task 6 (MAI meter, web SDK) — the config read carries a derived install
// identifier as a query param (`GET /api/config?installId=<value>`), and —
// the load-bearing case — a failure anywhere in deriving it must never
// break the config read itself. That endpoint is the SDK's remote kill
// switch: an uncounted install is cosmetic, a config fetch that never fires
// is not.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createWebPlatformAdapter, type WebPlatformAdapter } from '../../src/adapter.js';
import * as credentialStore from '../../src/reporter/credential-store.js';

const adapters: WebPlatformAdapter[] = [];
afterEach(() => {
  while (adapters.length) adapters.pop()!.__testCleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function configResponse(): Response {
  return new Response(
    JSON.stringify({
      replayEnabled: false,
      replayDurationSec: 30,
      samplingRate: 1,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('config read: install identifier', () => {
  it('carries a non-empty installId query param on a healthy storage seam', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => configResponse());
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createWebPlatformAdapter({ apiKey: 'txx_live_install_id_ok' });
    adapters.push(adapter);
    await adapter.__initReplay();

    expect(fetchMock).toHaveBeenCalled();
    const calledUrl = urlOf(fetchMock.mock.calls[0]![0]);
    const parsed = new URL(calledUrl);
    expect(parsed.pathname.endsWith('/api/config')).toBe(true);
    const installId = parsed.searchParams.get('installId');
    expect(installId).not.toBeNull();
    expect(installId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(installId!.length).toBeLessThanOrEqual(128);
  });

  // THE important test: force the install-id derivation seam to throw (not
  // just "return nothing") and confirm the config fetch still fires, still
  // targets plain /api/config, and carries no installId param at all — i.e.
  // the failure is fully contained and never reaches the config read.
  //
  // Plan 2b-ii: the adapter now calls `makeWebInstallIdSupplier` (once, at
  // construction) rather than `deriveWebInstallId` (on every fetch), so the
  // seam this test must break is the SUPPLIER the adapter actually holds —
  // mocking `deriveWebInstallId` no longer reaches the adapter at all, since
  // it is only ever called from inside credential-store.ts's own module
  // scope now (a same-module call a spy on the exported binding cannot
  // intercept; `makeWebInstallIdSupplier` is still imported cross-module by
  // adapter.ts, so mocking IT is what actually lands on the code under test).
  it('still fetches config with a clean, parameter-free URL when the install-id supplier throws', async () => {
    vi.spyOn(credentialStore, 'makeWebInstallIdSupplier').mockReturnValue(() => {
      throw new Error('storage seam exploded');
    });

    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => configResponse());
    vi.stubGlobal('fetch', fetchMock);

    let adapter: WebPlatformAdapter | undefined;
    expect(() => {
      adapter = createWebPlatformAdapter({ apiKey: 'txx_live_install_id_throws' });
    }).not.toThrow();
    adapters.push(adapter!);
    await adapter!.__initReplay();

    expect(fetchMock).toHaveBeenCalled();
    const calledUrl = urlOf(fetchMock.mock.calls[0]![0]);
    const parsed = new URL(calledUrl);
    expect(parsed.pathname.endsWith('/api/config')).toBe(true);
    expect(parsed.search).toBe('');
    expect(parsed.searchParams.get('installId')).toBeNull();
  });

  // Task 7 — the opt-out. Default is ON (the two tests above cover that); this
  // confirms setting `installIdentifier: { disabled: true }` omits the param
  // entirely while the config read itself still fires normally.
  it('omits the installId query param when installIdentifier.disabled is set, but still fetches config', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => configResponse());
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createWebPlatformAdapter({
      apiKey: 'txx_live_install_id_optout',
      installIdentifier: { disabled: true },
    });
    adapters.push(adapter);
    await adapter.__initReplay();

    expect(fetchMock).toHaveBeenCalled();
    const calledUrl = urlOf(fetchMock.mock.calls[0]![0]);
    const parsed = new URL(calledUrl);
    expect(parsed.pathname.endsWith('/api/config')).toBe(true);
    expect(parsed.search).toBe('');
    expect(parsed.searchParams.get('installId')).toBeNull();
  });

  it('reproduces the cross-SDK vector when the stored seed is the vector seed', () => {
    // Plan 2b-i: pins that the WEB path feeds its stored seed to
    // deriveInstallId in the same byte order install-id.v1.json fixes for
    // iOS and Android. The derivation itself is covered in sdk-core; what is
    // covered here is the hex-decode ordering between localStorage and the
    // HMAC key, where a nibble or endianness flip would yield a stable,
    // plausible, WRONG identifier that no other test would notice.
    const scope = 'txx_live_vector_scope';
    localStorage.setItem(
      credentialStore.scopedInstallSeedStorageKey(scope),
      '000102030405060708090a0b0c0d0e0f',
    );
    expect(credentialStore.deriveWebInstallId(scope)).toBe(
      'iYgxBgJiRf1n_ekekB7M9g03ulCzNx2O4jfL8PWLegA',
    );
  });
});
