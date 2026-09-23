// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect, afterEach, vi } from 'vitest';
import { installFetchPatcher, type BodyCaptureHooks } from '../../src/capture/network.js';
import { createNetworkBodyBuffer } from '@everframe/sdk-core';

describe('body capture end-to-end (patcher → buffer → snapshot)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('gate OFF by default ⇒ no bodies buffered', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })));
    const buf = createNetworkBodyBuffer();
    let id = 0;
    const h: BodyCaptureHooks = {
      enabled: () => false, // default gate off
      config: () => ({ bodyByteCap: 8192, bodyContentTypes: ['application/json'] }),
      redaction: () => ({}), nextReqId: () => ++id, sink: (e) => buf.add(e),
    };
    const uninstall = installFetchPatcher({ bodyCapture: h });
    await fetch('https://api.test/x');
    await vi.waitFor(() => expect(buf.size).toBe(0));
    buf.freeze();
    expect(buf.takeFrozen()).toEqual([]);
    uninstall();
  });

  it('budget eviction sheds the oldest body while later requests survive', async () => {
    // Body sized well above the fixed per-entry overhead (F20's 256-byte
    // ENTRY_OVERHEAD, plus header bytes) so the budget below is dominated by
    // body size, not swamped by the fixed cost — mirrors the native suites'
    // post-F2 budget rescaling.
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('B'.repeat(2000), { status: 200, headers: { 'content-type': 'text/plain' } })));
    const buf = createNetworkBodyBuffer({ byteBudget: 3000 });
    let id = 0;
    let sunkCount = 0;
    const h: BodyCaptureHooks = {
      enabled: () => true,
      config: () => ({ bodyByteCap: 8192, bodyContentTypes: ['text/*'] }),
      redaction: () => ({}), nextReqId: () => ++id, sink: (e) => { buf.add(e); sunkCount++; },
    };
    const uninstall = installFetchPatcher({ bodyCapture: h });
    await fetch('https://api.test/a'); // ref 1, 2000 bytes
    await vi.waitFor(() => expect(sunkCount).toBe(1)); // background sink completes before the next request
    await fetch('https://api.test/b'); // ref 2, 2000 bytes → total well over 3000 budget → evict ref 1
    await vi.waitFor(() => expect(sunkCount).toBe(2));
    buf.freeze();
    const refs = (buf.takeFrozen() ?? []).map((e) => e.ref);
    expect(refs).toEqual([2]);
    uninstall();
  });
});
