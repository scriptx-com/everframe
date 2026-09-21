// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// The ambient FAB's render gate, mirroring provider.tsx:
// `adapter.threads && replies.ui !== 'headless' && count > 0`. Ported here so
// the vanilla path and the React path put the FAB on screen under exactly the
// same conditions — see provider-fab-kill-switch.spec.tsx in @traceitx/react
// for why the gate is `count > 0` and NOT `enabled`.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { init, type TraceItXHandle } from '../../src/init.js';
import { REPORTER_TOKEN_STORAGE_KEY } from '../../src/reporter/credential-store.js';

let handle: TraceItXHandle | null = null;

afterEach(() => {
  handle?.destroy();
  handle = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  localStorage.clear();
});

const oneOpenThread = [
  {
    id: 'thread-1',
    status: 'open',
    reportTitle: 'Broken checkout',
    createdAt: new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
    unreadCount: 2,
  },
];

function stubFetch(state: { enabled: boolean; threads: unknown[] }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/config')) {
        return new Response(
          JSON.stringify({
            replayEnabled: false,
            replayDurationSec: 30,
            samplingRate: 1,
            replies: { enabled: state.enabled },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/api/reporter/threads')) {
        return new Response(JSON.stringify({ threads: state.threads }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

function shadow(): ShadowRoot {
  const root = document.getElementById('traceitx-host')?.shadowRoot;
  if (!root) throw new Error('no shadow root');
  return root;
}

const fab = (): Element | null => shadow().querySelector('[data-testid=reporter-fab]');

describe('ambient FAB thread gate', () => {
  it('stays hidden while this device has no threads', async () => {
    stubFetch({ enabled: true, threads: [] });
    handle = init({ apiKey: 'txx_live_test' });
    await new Promise((r) => setTimeout(r, 30));
    expect(fab()).toBeNull();
  });

  it('appears once a thread exists, carrying the unread count in its label', async () => {
    localStorage.setItem(REPORTER_TOKEN_STORAGE_KEY, `txr_${'0'.repeat(36)}`);
    stubFetch({ enabled: true, threads: oneOpenThread });
    handle = init({ apiKey: 'txx_live_test' });
    await vi.waitFor(() => expect(fab()).not.toBeNull(), { timeout: 3000 });
    expect(fab()?.getAttribute('aria-label')).toBe('Your reports — 2 unread');
  });

  it("never appears under replies.ui: 'headless' — the host owns the UI", async () => {
    localStorage.setItem(REPORTER_TOKEN_STORAGE_KEY, `txr_${'0'.repeat(36)}`);
    stubFetch({ enabled: true, threads: oneOpenThread });
    handle = init({
      apiKey: 'txx_live_test',
      replies: { ui: 'headless' },
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(fab()).toBeNull();
  });

  it('destroy() takes the FAB down with the host', async () => {
    localStorage.setItem(REPORTER_TOKEN_STORAGE_KEY, `txr_${'0'.repeat(36)}`);
    stubFetch({ enabled: true, threads: oneOpenThread });
    handle = init({ apiKey: 'txx_live_test' });
    await vi.waitFor(() => expect(fab()).not.toBeNull(), { timeout: 3000 });
    handle.destroy();
    handle = null;
    expect(document.getElementById('traceitx-host')).toBeNull();
  });
});
