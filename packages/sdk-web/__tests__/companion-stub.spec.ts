// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// Everframe Companion has been removed. Its documented API stays as
// deprecated no-op stubs: these tests pin that the stubs never open a socket
// or make a request, stay idle, warn once, and that the wire changes hold (no
// `companionbadge` feature token, a config carrying `companionBadge` still
// applies the rest of the config).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@everframe/sdk-core';
import { companion, createCompanion, start, stop, __getCompanionApi } from '../src/index.js';
import * as root from '../src/index.js';
import {
  __companionDeprecationCount,
  __resetCompanionDeprecation,
} from '../src/companion/deprecation.js';
import { createWebPlatformAdapter, type WebPlatformAdapter } from '../src/adapter.js';
import { CompanionBadge, CompanionPinCard } from '../src/ui.js';

const adapters: WebPlatformAdapter[] = [];

beforeEach(() => {
  __resetCompanionDeprecation();
});

afterEach(() => {
  while (adapters.length) adapters.pop()!.__testCleanup();
  __resetCompanionDeprecation();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('deprecated Companion stubs', () => {
  it('start warns once, opens no socket, and stays unpaired', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ws = vi.fn();
    vi.stubGlobal('WebSocket', ws);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    stop(); // stop before start is safe
    companion.start({
      sdkKey: 'evf_live_x',
      attachPinUi: 'custom',
      companionBadge: { enabled: false },
      onReportRequest: (_id, _ws) => undefined,
    });
    companion.start();
    companion.stop();
    start();
    stop();

    expect(__companionDeprecationCount()).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('Everframe Companion has been removed');
    expect(ws).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    const api = __getCompanionApi();
    const handler = vi.fn();
    const offs = [
      api.onState(handler),
      api.onPairUrl(handler),
      api.onCode(handler),
      api.onAttachedUserName(handler),
      api.onResolvedName(handler),
      api.onAttachChallenge(handler),
    ];
    offs.forEach((off) => {
      off();
      off();
    });
    expect(handler).not.toHaveBeenCalled();
    expect(api.getState()).toBe('unpaired');
    expect(api.getPairUrl()).toBeNull();
    expect(api.getCode()).toBeNull();
    expect(api.getAttachedUserName()).toBeNull();
    expect(api.getResolvedName()).toBeNull();
    expect(api.getAttachChallenge()).toBeNull();
    expect(createCompanion().getState()).toBe('unpaired');
    expect(companion.createCompanion().getState()).toBe('unpaired');
  });

  it('the removed plumbing is gone from the package root, and the test seams are not exported', () => {
    const exports = root as Record<string, unknown>;
    for (const removed of [
      'announce',
      'createRelayWSClient',
      'handleReportRequest',
      'handleCompanionSubmitText',
      'handleCompanionSubmitBinary',
      '__setCompanionHost',
      '__watchCompanionBond',
      '__setCompanionDefaults',
      '__resetDeviceIdForTests',
      '__companionDeprecationCount',
      '__resetCompanionDeprecation',
    ]) {
      expect(exports[removed], removed).toBeUndefined();
    }
  });

  it('the ui stubs render nothing', () => {
    expect(CompanionBadge()).toBeNull();
    expect(CompanionPinCard()).toBeNull();
  });
});

describe('config negotiation without Companion', () => {
  function wire(): { adapter: WebPlatformAdapter; fetchMock: ReturnType<typeof vi.fn> } {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            replayEnabled: false,
            replayDurationSec: 30,
            samplingRate: 1,
            companionBadge: { enabled: true, position: 'top-left' },
            reportHotkey: { binding: 'Alt+R' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createWebPlatformAdapter({ sdkKey: 'k' });
    adapters.push(adapter);
    createClient(adapter).init({ sdkKey: 'k' });
    return { adapter, fetchMock };
  }

  it('a config with a companionBadge block still applies the rest of the config', async () => {
    const { adapter } = wire();
    const bindings: string[] = [];
    const unsubscribe = adapter.__subscribeReportHotkey((binding) => bindings.push(binding));
    await adapter.__initReplay();
    adapter.__applyBreadcrumbsConfig();
    expect(bindings.at(-1)).toBe('Alt+R');
    unsubscribe();
  });

  it('the features header no longer declares companionbadge', async () => {
    const { adapter, fetchMock } = wire();
    await adapter.__initReplay();
    const header = (fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>)[
      'X-Everframe-SDK-Features'
    ];
    expect(header.split(', ')).not.toContain('companionbadge');
    expect(header.split(', ')).toContain('branding');
  });
});
