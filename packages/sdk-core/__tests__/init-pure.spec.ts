// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { createClient } from '../src/client.js';
import { createFakePlatformAdapter } from '../src/__test-helpers__/fake-platform-adapter.js';

describe('DEFE-01: init is pure (no I/O, no side effects)', () => {
  let fetchSpy: MockInstance;
  let setTimeoutSpy: MockInstance;
  let setIntervalSpy: MockInstance;

  beforeEach(() => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(''));
    setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('init() does not call fetch', () => {
    const client = createClient(createFakePlatformAdapter());
    client.init({ apiKey: 'test' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('init() does not schedule timers', () => {
    const client = createClient(createFakePlatformAdapter());
    client.init({ apiKey: 'test' });
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it('init() returns synchronously', () => {
    const client = createClient(createFakePlatformAdapter());
    const ret = client.init({ apiKey: 'test' });
    expect(ret).toBeUndefined();
  });

  it('init() does not call any adapter capture method', () => {
    const adapter = createFakePlatformAdapter();
    const client = createClient(adapter);
    client.init({ apiKey: 'test' });
    expect(adapter.__calls.captureScreenshot).toBe(0);
    expect(adapter.__calls.registerTrigger).toBe(0);
    expect(adapter.__calls.captureRecentLogs).toBe(0);
  });
});

describe('DEFE-01: importing sdk-core adds no globalThis keys', () => {
  // Mirror scripts/smoke-import.mjs UPSTREAM_ALLOWED_GLOBALS — Zod 4 lazily creates
  // `__zod_globalRegistry` on first module init when sdk-core re-exports from
  // @everframe/protocol. Locked + audited at protocol package; sdk-core inherits.
  const UPSTREAM_ALLOWED_GLOBALS = new Set(['__zod_globalRegistry']);

  it('snapshot before/after dynamic import', async () => {
    const before = new Set(Object.keys(globalThis));
    await import('../src/index.js');
    const after = new Set(Object.keys(globalThis));
    const added = [...after].filter(
      (k) => !before.has(k) && !UPSTREAM_ALLOWED_GLOBALS.has(k)
    );
    expect(added).toEqual([]);
  });
});
