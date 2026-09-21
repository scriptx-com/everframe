// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// MAI meter Plan 2b-ii — the config provider resolves the install identifier
// on EVERY fetch rather than taking a pre-assembled URL. Plan 2a baked it into
// `configUrl` once at adapter construction, so a per-day gate could never take
// effect: the same value rode every five-minute refetch for the adapter's
// whole lifetime.
//
// The load-bearing case is the last one: this endpoint is the SDK's remote
// kill switch, so a throwing supplier must still produce a completed fetch.
import { describe, it, expect, vi } from 'vitest';
import { createConfigProvider } from '../src/types/replay/config-provider.js';

function okResponse(): Response {
  return new Response(
    JSON.stringify({ replayEnabled: false, replayDurationSec: 30, samplingRate: 1 }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

const BASE = 'https://ingest.example.test/api/config';

describe('config provider: install identifier', () => {
  it('appends the supplier value as an installId query parameter', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const provider = createConfigProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      configUrl: BASE,
      apiKey: 'k',
      installIdProvider: () => 'iYgxBgJiRf1n_ekekB7M9g03ulCzNx2O4jfL8PWLegA',
    });
    await provider.refresh();
    const url = new URL(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[0]));
    expect(url.searchParams.get('installId')).toBe('iYgxBgJiRf1n_ekekB7M9g03ulCzNx2O4jfL8PWLegA');
    expect(url.pathname).toBe('/api/config');
  });

  it('leaves the url untouched when the supplier returns null', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const provider = createConfigProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      configUrl: BASE,
      apiKey: 'k',
      installIdProvider: () => null,
    });
    await provider.refresh();
    expect(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[0])).toBe(BASE);
  });

  it('leaves the url untouched when no supplier is given at all', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const provider = createConfigProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      configUrl: BASE,
      apiKey: 'k',
    });
    await provider.refresh();
    expect(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[0])).toBe(BASE);
  });

  it('resolves the supplier on every fetch, not once', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    let n = 0;
    const provider = createConfigProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      configUrl: BASE,
      apiKey: 'k',
      ttlMs: 0,
      installIdProvider: () => `id${++n}`,
    });
    await provider.refresh();
    await provider.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[0])).toContain('installId=id1');
    expect(String((fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[0])).toContain('installId=id2');
  });

  it('still fetches when the supplier throws — this read is the kill switch', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const provider = createConfigProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      configUrl: BASE,
      apiKey: 'k',
      installIdProvider: () => {
        throw new Error('boom');
      },
    });
    await expect(provider.refresh()).resolves.toBe(true);
    expect(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[0])).toBe(BASE);
  });
});
