// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// A host that installs history.pushState/replaceState read-only (an analytics
// guard keeping a tag from hooking them) must still get a working SDK. Before
// the fix, the navigation patcher's assignment threw in strict mode and init()
// threw with it: the crash hooks were already live, the breadcrumb buffer was
// never bound, and the host had no handle to kill.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportEnvelope } from '@everframe/protocol';
import { init, type Everframe } from '../src/index.js';

let handle: Everframe | undefined;
let sent: ReportEnvelope[];

function lockHistory(): void {
  for (const method of ['pushState', 'replaceState'] as const) {
    // configurable only so the test can undo it; writable: false is what bites.
    Object.defineProperty(history, method, {
      value: History.prototype[method],
      writable: false,
      configurable: true,
    });
  }
}

beforeEach(() => {
  localStorage.clear();
  sent = [];
  lockHistory();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, options?: RequestInit) => {
      if (String(url).endsWith('/api/ingest')) {
        const body = options?.body as FormData;
        const envelope = ReportEnvelope.parse(
          JSON.parse(await (body.get('envelope') as Blob).text()),
        );
        if (!sent.some((e) => e.reportId === envelope.reportId)) sent.push(envelope);
      }
      return new Response(JSON.stringify({ status: 'received' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  handle?.destroy();
  handle = undefined;
  delete (history as unknown as Record<string, unknown>)['pushState'];
  delete (history as unknown as Record<string, unknown>)['replaceState'];
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('init() with read-only history methods', () => {
  it('returns a handle, and errors carry the breadcrumb trail', async () => {
    expect(() => {
      handle = init({ sdkKey: 'evf_live_readonlyhistory0000000', reporter: { disabled: true } });
    }).not.toThrow();
    expect(handle).toBeDefined();

    handle!.addBreadcrumb({ kind: 'navigation', message: '/apps/:id' });
    handle!.captureException(new Error('boom'));

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.payload.breadcrumbs?.some((b) => b.message === '/apps/:id')).toBe(true);
  });

  it('leaves the host’s history methods in place', () => {
    const pushState = history.pushState;
    handle = init({ sdkKey: 'evf_live_readonlyhistory0000000', reporter: { disabled: true } });
    expect(history.pushState).toBe(pushState);
    history.pushState(null, '', '/still-works');
    expect(location.pathname).toBe('/still-works');
  });

  it('can be killed, after which nothing is reported', async () => {
    handle = init({ sdkKey: 'evf_live_readonlyhistory0000000', reporter: { disabled: true } });
    handle.kill();
    handle.captureException(new Error('after kill'));
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toHaveLength(0);
  });
});
