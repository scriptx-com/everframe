// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@traceitx/sdk-core';
import { createWebPlatformAdapter, type WebPlatformAdapter } from '../../src/adapter.js';

const adapters: WebPlatformAdapter[] = [];

afterEach(() => {
  while (adapters.length) adapters.pop()!.__testCleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function configResponse(binding: string): Response {
  return new Response(JSON.stringify({
    replayEnabled: false,
    replayDurationSec: 30,
    samplingRate: 1,
    reportHotkey: { binding },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('dashboard report hotkey', () => {
  it('starts with the default and publishes the dashboard binding after config resolves', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      configResponse('Alt+R'));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createWebPlatformAdapter({ apiKey: 'k' });
    adapters.push(adapter);
    const client = createClient(adapter);
    client.init({ apiKey: 'k' });
    const bindings: string[] = [];

    const unsubscribe = adapter.__subscribeReportHotkey((binding) => bindings.push(binding));
    await adapter.__initReplay();
    adapter.__applyBreadcrumbsConfig();

    expect(bindings).toEqual(['Mod+Shift+B', 'Alt+R']);
    const request = fetchMock.mock.calls[0]?.[1];
    expect((request?.headers as Record<string, string>)['X-TX-SDK-Features'])
      .toContain('reporthotkey');
    unsubscribe();
  });

  it('publishes a changed dashboard binding after a live config refresh', async () => {
    let binding = 'Mod+Shift+B';
    vi.stubGlobal('fetch', vi.fn(async () => configResponse(binding)));
    const adapter = createWebPlatformAdapter({ apiKey: 'k' });
    adapters.push(adapter);
    const client = createClient(adapter);
    client.init({ apiKey: 'k' });
    const bindings: string[] = [];
    adapter.__subscribeReportHotkey((value) => bindings.push(value));

    await adapter.__initReplay();
    adapter.__applyBreadcrumbsConfig();
    binding = 'Ctrl+Alt+K';
    await adapter.__testRefreshConfigNow();

    expect(bindings.at(-1)).toBe('Ctrl+Alt+K');
  });
});
