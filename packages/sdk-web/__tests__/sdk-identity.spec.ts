// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
// @vitest-environment jsdom
//
// `envelope.sdk` must name the SDK that actually hosts the adapter. This
// package is shared by `@traceitx/react` and `@traceitx/web`, which have
// different names on the wire and independent versions — a hardcoded name
// here files every Vue/Svelte/plain-HTML report under the React SDK.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebPlatformAdapter } from '../src/adapter.js';
import { PKG_VERSION } from '../src/internal/version.js';

const adapters: Array<{ __testCleanup: () => void }> = [];

/** Drive a real uncaught error and read the envelope the crash drain POSTs. */
async function crashEnvelope(
  fetchMock: ReturnType<typeof vi.fn>,
): Promise<Record<string, never> & { sdk: { name: string; version: string } }> {
  const err = new TypeError('boom');
  err.stack = 'TypeError: boom\n    at f (a.ts:1:1)';
  window.onerror?.('boom', 'a.ts', 1, 1, err);
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
  return JSON.parse(await (body.get('envelope') as Blob).text());
}

describe('envelope.sdk identity', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ status: 'received' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    while (adapters.length) adapters.pop()!.__testCleanup();
    vi.unstubAllGlobals();
  });

  const mk = (...args: Parameters<typeof createWebPlatformAdapter>) => {
    const adapter = createWebPlatformAdapter(...args);
    adapters.push(adapter);
    return adapter;
  };

  it('stamps the host SDK the adapter was constructed with (vanilla)', async () => {
    mk({ apiKey: 'pk_test' }, { sdkName: 'traceitx-web', sdkVersion: '9.9.9' });
    const envelope = await crashEnvelope(fetchMock);
    expect(envelope.sdk.name).toBe('traceitx-web');
    expect(envelope.sdk.version).toBe('9.9.9');
  });

  it('stamps the React SDK when the React Provider constructs it', async () => {
    mk({ apiKey: 'pk_test' }, { sdkName: 'traceitx-react', sdkVersion: '1.2.3' });
    const envelope = await crashEnvelope(fetchMock);
    expect(envelope.sdk.name).toBe('traceitx-react');
    expect(envelope.sdk.version).toBe('1.2.3');
  });

  // Codex round-2 finding 2 (P1, attribution). This default used to be
  // `traceitx-react` + THIS package's PKG_VERSION — a pair that cannot occur
  // legitimately, because `@traceitx/react` is versioned separately and its
  // Provider passes both values explicitly (the test above). Since
  // `createWebPlatformAdapter` is a PUBLIC export of `@traceitx/web`, a Vue /
  // Svelte / plain-HTML host that constructed an adapter directly had its
  // whole crash stream billed to the React SDK under a version React has
  // never published. The fallback now names the package that owns the module.
  //
  // The two assertions are a pair: the name alone would still pass if the
  // version fallback regressed to something else, and it is the COMBINATION
  // that was impossible.
  it('defaults to the vanilla SDK and this package version when unspecified', async () => {
    mk({ apiKey: 'pk_test' });
    const envelope = await crashEnvelope(fetchMock);
    expect(envelope.sdk.name).toBe('traceitx-web');
    expect(envelope.sdk.version).toBe(PKG_VERSION);
  });
});
