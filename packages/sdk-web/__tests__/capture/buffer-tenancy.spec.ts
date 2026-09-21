// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
// @vitest-environment jsdom
//
// Codex round-3 finding 1 (P1) — destroyed instances leaked capture into the
// next instance.
//
// The console/fetch/XHR patchers are page-global and install-once behind
// Symbol markers. `destroy()` deliberately leaves them installed (they are
// shared with anything else on the page and re-claimed by the next `init()`),
// their writes into the raw ring buffers were UNCONDITIONAL, and the next
// adapter's "resize" PRESERVED whatever was already there. Composed, that is:
//
//   init tenant A → destroy() → log a secret / make a request → init tenant B
//   → file a report, and B's envelope carries A's console lines and A's URLs.
//
// A cross-instance data leak, not staleness. Two independent gates now close
// it, and this spec pins both separately so neither can quietly regress behind
// the other:
//
//   1. ADMISSION (`__setCaptureAccepting`) — a killed instance stops admitting
//      writes at all, so the "between instances" window captures nothing.
//   2. CLAIM (`__claimCaptureBuffers`) — a fresh adapter DROPS what it finds,
//      so nothing a previous tenant captured can ever be read back out.
//
// Every case is paired with a live control on the same buffers, so a gate that
// swallowed everything fails exactly as loudly as no gate at all.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebPlatformAdapter } from '../../src/adapter.js';
import { consoleBuffer, networkBuffer } from '../../src/capture/buffers.js';

const adapters: Array<{ __testCleanup: () => void }> = [];

const mk = (config: Parameters<typeof createWebPlatformAdapter>[0]) => {
  const adapter = createWebPlatformAdapter(config);
  adapters.push(adapter);
  return adapter;
};

beforeEach(() => {
  // Stubbed BEFORE any adapter exists: the fetch patcher wraps whatever
  // `globalThis.fetch` is at install time, and install is install-once.
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response('{}', { status: 200 })),
  );
});

afterEach(() => {
  while (adapters.length) adapters.pop()!.__testCleanup();
  vi.unstubAllGlobals();
});

describe('the raw capture buffers are per-tenant, not per-page', () => {
  it('LIVE control: a live adapter captures console lines and requests', async () => {
    const a = mk({ apiKey: 'pk_a' });

    console.log('live-control-line');
    await fetch('https://example.test/live-control-url');

    expect(a.captureRecentLogs().map((e) => e.message)).toContain('live-control-line');
    expect(a.captureRecentNetwork().map((e) => e.url)).toContain(
      'https://example.test/live-control-url',
    );
  });

  it('admits nothing once the instance is killed', async () => {
    const a = mk({ apiKey: 'pk_a' });

    console.log('before-kill-line');
    await fetch('https://example.test/before-kill-url');
    a.onKill?.();
    console.log('after-kill-line');
    await fetch('https://example.test/after-kill-url');

    // Asserted against the RAW module buffers, not through an adapter. Reading
    // through a fresh adapter would prove nothing about admission: that
    // adapter's own claim clears the buffers, so the entries would be absent
    // whether they had been admitted or not. This is the gate itself.
    const logs = consoleBuffer.snapshot().map((e) => e.message);
    const urls = networkBuffer.snapshot().map((e) => e.url);

    expect(logs).toContain('before-kill-line'); // control: the writer works
    expect(urls).toContain('https://example.test/before-kill-url');

    expect(logs).not.toContain('after-kill-line');
    expect(urls).not.toContain('https://example.test/after-kill-url');
  });

  it("a new tenant's report can never contain the previous tenant's activity", async () => {
    const a = mk({ apiKey: 'pk_a' });
    console.log('tenant-a-secret');
    await fetch('https://example.test/tenant-a-secret-url');
    // The whole of `destroy()` that matters here: `client.kill()` → onKill().
    a.onKill?.();

    // The window between the two instances, where the page-global patchers are
    // still installed and nobody owns them.
    console.log('between-instances-secret');
    await fetch('https://example.test/between-instances-url');

    const b = mk({ apiKey: 'pk_b' });
    console.log('tenant-b-line');
    await fetch('https://example.test/tenant-b-url');

    const logs = b.captureRecentLogs().map((e) => e.message);
    const urls = b.captureRecentNetwork().map((e) => e.url);

    // The control half — B genuinely captures, so the assertions below are
    // about tenancy and not about a dead harness.
    expect(logs).toContain('tenant-b-line');
    expect(urls).toContain('https://example.test/tenant-b-url');

    expect(logs).not.toContain('tenant-a-secret');
    expect(logs).not.toContain('between-instances-secret');
    expect(urls).not.toContain('https://example.test/tenant-a-secret-url');
    expect(urls).not.toContain('https://example.test/between-instances-url');
  });

  it('a StrictMode remount re-opens admission rather than going quiet forever', () => {
    // The revive half of the admission gate. provider.tsx's simulated unmount
    // calls `client.kill()` on a LIVE Provider and the remount re-claims the
    // adapter through `__rebindCrumbHooks()`; without the re-open, every
    // Next.js dev app would capture zero console lines for the rest of the
    // session — the same class of regression codex round-2 finding 3 found in
    // the 'online' drain listener.
    const a = mk({ apiKey: 'pk_a' });
    a.onKill?.();
    a.__rebindCrumbHooks();

    console.log('after-strictmode-remount');

    expect(a.captureRecentLogs().map((e) => e.message)).toContain('after-strictmode-remount');
  });
});
