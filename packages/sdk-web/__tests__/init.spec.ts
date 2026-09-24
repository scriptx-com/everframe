// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { init } from '../src/init.js';
import type { Everframe } from '../src/init.js';

let handles: Array<{ destroy(): void }> = [];

beforeEach(() => {
  // Every mount() runs a real `__initReplay()` and a real outbox drain. Without
  // a stub those hit INGEST_URL, so the spec's behaviour would change the
  // moment a dev API happened to be listening on that port — config would
  // resolve, polling would arm, and timers would outlive the test. Every
  // sdk-react provider spec stubs fetch for the same reason.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })),
  );
});

afterEach(() => {
  handles.forEach((h) => h.destroy());
  handles = [];
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  localStorage.clear();
});

function mount(): Everframe {
  const h = init({ apiKey: 'pk_test', appVersion: '1.0.0' });
  handles.push(h);
  return h;
}

describe('init()', () => {
  it('creates one shadow host tagged so capture skips it', () => {
    mount();
    const host = document.getElementById('everframe-host');
    expect(host).not.toBeNull();
    expect(host?.getAttribute('data-everframe-skip-capture')).toBe('true');
    expect(host?.shadowRoot).not.toBeNull();
  });

  it('injects the reporter stylesheet into the shadow root, not the document', () => {
    mount();
    const shadow = document.getElementById('everframe-host')?.shadowRoot;
    expect(shadow?.querySelector('style[data-everframe-styles]')).not.toBeNull();
    expect(document.head.querySelector('style[data-everframe-styles]')).toBeNull();
  });

  it('is idempotent per page — a second call returns the same handle and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const a = mount();
    const b = init({ apiKey: 'pk_test', appVersion: '1.0.0' });
    expect(b).toBe(a);
    expect(warn).toHaveBeenCalled();
    expect(document.querySelectorAll('#everframe-host')).toHaveLength(1);
  });

  it('destroy() removes the host and allows a clean re-init', () => {
    const h = mount();
    h.destroy();
    expect(document.getElementById('everframe-host')).toBeNull();
    const again = mount();
    expect(again).not.toBe(h);
    expect(document.getElementById('everframe-host')).not.toBeNull();
  });

  // Codex round-1 finding 7, second site. `expect.any(Function)` asserted only
  // that SOME function was handed to removeEventListener under that name, so
  // `removeEventListener('visibilitychange', somethingElse)` kept this green
  // while the real listener stayed attached — and a stale listener here calls
  // `threads.wake()`/`stopPolling()` on a torn-down instance on every tab
  // switch. Matched by CALLBACK IDENTITY instead.
  it('destroy() unregisters the exact document visibilitychange listener it added', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    try {
      mount().destroy();

      const of = (spy: typeof add): unknown[] =>
        spy.mock.calls.filter(([type]) => type === 'visibilitychange').map(([, fn]) => fn);
      const added = of(add);
      // Not vacuous: an init() that stopped listening at all fails here.
      expect(added).toHaveLength(1);
      // toContain compares by reference — the same function object, not merely
      // another one registered under the same event name.
      for (const fn of added) expect(of(remove)).toContain(fn);
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });

  it('exposes the client facade without a React tree', () => {
    const h = mount();
    expect(typeof h.open).toBe('function');
    expect(typeof h.addBreadcrumb).toBe('function');
    expect(typeof h.setUser).toBe('function');
    expect(typeof h.setIdentityToken).toBe('function');
    expect(typeof h.kill).toBe('function');
  });

  // sdk-core's `markSensitive` is a no-op that has never reached the sensitive
  // registry, so this brand-new handle deliberately does not carry it: a
  // privacy method that silently does nothing is worse than none at all.
  // Masking is `data-everframe-sensitive` + `sensitiveRegistry.addRef` only.
  it('does not expose the dead markSensitive privacy call', () => {
    const h = mount() as unknown as Record<string, unknown>;
    expect('markSensitive' in h).toBe(false);
  });

  it('exposes trackPlayer and trackVitals on the handle', () => {
    const h = mount();
    expect(typeof h.trackPlayer).toBe('function');
    expect(typeof h.trackVitals).toBe('function');
    const p = h.trackPlayer({ element: document.createElement('video'), name: 'x' });
    expect(p.id).toMatch(/^p\d+$/);
    expect(() => h.trackVitals('n', { a: 1 })).not.toThrow();
    p.detach();
  });
});
