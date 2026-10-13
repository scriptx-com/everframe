// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// Crash-only sessions (spec 2026-10-12), through the REAL adapter and client
// wiring. `reporter.disabled` turns off every on-device way to open the
// reporter, keeps network bodies off and samples replay against
// `crashOnlySamplingRate`. A companion bond upgrades replay and bodies to the
// normal server rules; the reporter stays off.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient, __internalClientState, type ReportDraft } from '@everframe/sdk-core';
import { createWebPlatformAdapter, type WebPlatformAdapter } from '../src/adapter.js';
import { EverframeReporterDisabledError } from '../src/reporter-types.js';
import { EverframeReporterDisabledError as PublicError } from '../src/index.js';

const adapters: WebPlatformAdapter[] = [];

afterEach(() => {
  while (adapters.length) adapters.pop()!.__testCleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

const BREADCRUMBS = {
  enabled: true,
  kinds: ['console', 'network'],
  maxCount: 100,
  byteBudget: 16384,
  consoleEntryCap: 1024,
};

function wire(configBody: Record<string, unknown>, reporterDisabled: boolean) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    if (urlOf(input).includes('/api/config')) {
      return new Response(JSON.stringify(configBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  const config = { sdkKey: 'k', ...(reporterDisabled ? { reporter: { disabled: true } } : {}) };
  const adapter = createWebPlatformAdapter(config);
  adapters.push(adapter);
  const client = createClient(adapter);
  client.init(config);
  adapter.__setNetworkBodiesBuffer(() => __internalClientState.get(client)?.networkBodies);
  return { adapter, fetchMock, bodies: () => __internalClientState.get(client)!.networkBodies };
}

const replayOn = (extra: Record<string, unknown> = {}) => ({
  replayEnabled: true,
  replayDurationSec: 30,
  samplingRate: 1,
  ...extra,
});

describe('crash-only sessions: config negotiation', () => {
  it('declares the crashonly feature token', async () => {
    const { adapter, fetchMock } = wire(replayOn(), true);
    await adapter.__initReplay();
    const init = fetchMock.mock.calls.find(([input]) => urlOf(input).includes('/api/config'))?.[1];
    const header = (init?.headers as Record<string, string>)['X-Everframe-SDK-Features'];
    expect(header.split(', ')).toContain('crashonly');
  });
});

describe('crash-only sessions: replay coverage', () => {
  it('does not record when the server sends no crash-only rate', async () => {
    const { adapter } = wire(replayOn(), true);
    await adapter.__initReplay();
    expect(adapter.__replayLifecycle?.state).toBe('IDLE');
  });

  it('does not record at a crash-only rate of 0, whatever samplingRate says', async () => {
    const { adapter } = wire(replayOn({ crashOnlySamplingRate: 0 }), true);
    await adapter.__initReplay();
    expect(adapter.__replayLifecycle?.state).toBe('IDLE');
  });

  it('records when the crash-only rate admits the session', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.03);
    const { adapter } = wire(replayOn({ samplingRate: 0, crashOnlySamplingRate: 0.05 }), true);
    await adapter.__initReplay();
    expect(adapter.__replayLifecycle?.state).toBe('BUFFERING');
  });

  it('a report session ignores the crash-only rate', async () => {
    const { adapter } = wire(replayOn({ crashOnlySamplingRate: 0 }), false);
    await adapter.__initReplay();
    expect(adapter.__replayLifecycle?.state).toBe('BUFFERING');
  });

  it('a companion bond upgrades the session and starts recording at once', async () => {
    const { adapter } = wire(replayOn({ crashOnlySamplingRate: 0 }), true);
    await adapter.__initReplay();
    expect(adapter.__replayLifecycle?.state).toBe('IDLE');
    adapter.__setCompanionAttached();
    expect(adapter.__replayLifecycle?.state).toBe('BUFFERING');
  });

  it('an upgrade keeps a recording the crash-only rate admitted', async () => {
    // Draw 0.03: under the crash-only 5%, over the report 1%.
    vi.spyOn(Math, 'random').mockReturnValue(0.03);
    const { adapter } = wire(replayOn({ samplingRate: 0.01, crashOnlySamplingRate: 0.05 }), true);
    await adapter.__initReplay();
    expect(adapter.__replayLifecycle?.state).toBe('BUFFERING');
    adapter.__setCompanionAttached();
    expect(adapter.__replayLifecycle?.state).toBe('BUFFERING');
    // A restart after an identity change samples the upgraded kind.
    adapter.__replayLifecycle!.forceDiscard();
    expect(adapter.__replayLifecycle!.tryStart()).toBe(true);
  });

  it('an upgraded session records at the crash-only rate when samplingRate is lower', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.03);
    const { adapter } = wire(replayOn({ samplingRate: 0.01, crashOnlySamplingRate: 0.05 }), true);
    adapter.__setCompanionAttached();
    await adapter.__initReplay();
    expect(adapter.__replayLifecycle?.state).toBe('BUFFERING');
  });

  it('a bond before config resolves takes effect once config arrives', async () => {
    const { adapter } = wire(replayOn({ crashOnlySamplingRate: 0 }), true);
    adapter.__setCompanionAttached();
    expect(adapter.__replayLifecycle?.state).toBe('IDLE');
    await adapter.__initReplay();
    expect(adapter.__replayLifecycle?.state).toBe('BUFFERING');
  });

  it('sessionReplay.disabled still wins after an upgrade', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(replayOn()), { status: 200 })),
    );
    const adapter = createWebPlatformAdapter({
      sdkKey: 'k',
      reporter: { disabled: true },
      sessionReplay: { disabled: true },
    });
    adapters.push(adapter);
    await adapter.__initReplay();
    adapter.__setCompanionAttached();
    expect(adapter.__replayLifecycle?.state).toBe('IDLE');
  });

  it('is a no-op in a report session', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const { adapter } = wire(replayOn({ samplingRate: 0.5, crashOnlySamplingRate: 1 }), false);
    await adapter.__initReplay();
    adapter.__setCompanionAttached();
    expect(adapter.__replayLifecycle?.state).toBe('IDLE');
  });
});

describe('crash-only sessions: network bodies', () => {
  const bodiesOn = {
    replayEnabled: false,
    replayDurationSec: 30,
    samplingRate: 1,
    breadcrumbs: BREADCRUMBS,
    networkBodies: { captureBodies: true },
  };

  it('captures no bodies in a crash-only session', async () => {
    const { adapter, bodies } = wire(bodiesOn, true);
    await adapter.__initReplay();
    await fetch('https://api.test/x');
    await flush();
    expect(bodies().size).toBe(0);
  });

  it('captures bodies by the server rules after a companion bond', async () => {
    const { adapter, bodies } = wire(bodiesOn, true);
    await adapter.__initReplay();
    adapter.__setCompanionAttached();
    await fetch('https://api.test/x');
    await flush();
    expect(bodies().size).toBeGreaterThan(0);
  });

  it('a report session still captures bodies', async () => {
    const { adapter, bodies } = wire(bodiesOn, false);
    await adapter.__initReplay();
    await fetch('https://api.test/x');
    await flush();
    expect(bodies().size).toBeGreaterThan(0);
  });
});

describe('crash-only sessions: entry points', () => {
  it('open() rejects with EverframeReporterDisabledError and shows nothing', async () => {
    const { adapter } = wire(replayOn(), true);
    const show = vi.fn();
    adapter.__registerShowModal(show);
    const result = adapter.__openReporter();
    await expect(result).rejects.toBeInstanceOf(EverframeReporterDisabledError);
    await expect(adapter.__openReporter()).rejects.toMatchObject({
      name: 'EverframeReporterDisabledError',
    });
    expect(show).not.toHaveBeenCalled();
    expect(PublicError).toBe(EverframeReporterDisabledError);
  });

  it('open() still rejects after a companion upgrade', async () => {
    const { adapter } = wire(replayOn(), true);
    const show = vi.fn();
    adapter.__registerShowModal(show);
    adapter.__setCompanionAttached();
    await expect(adapter.__openReporter()).rejects.toBeInstanceOf(EverframeReporterDisabledError);
    expect(show).not.toHaveBeenCalled();
  });

  it('never hands out a hotkey binding', async () => {
    const { adapter } = wire(replayOn({ reportHotkey: { binding: 'Alt+R' } }), true);
    const listener = vi.fn();
    const unsubscribe = adapter.__subscribeReportHotkey(listener);
    await adapter.__initReplay();
    adapter.__applyBreadcrumbsConfig();
    expect(listener).not.toHaveBeenCalled();
    expect(() => unsubscribe()).not.toThrow();
  });

  it('the sdk-core report flow gets a discarded draft without a dialog', async () => {
    const { adapter } = wire(replayOn(), true);
    const show = vi.fn();
    adapter.__registerShowModal(show);
    await expect(adapter.showReporterUI({} as ReportDraft)).resolves.toBeNull();
    expect(show).not.toHaveBeenCalled();
  });

  it('a report session still opens the reporter and binds the hotkey', async () => {
    const { adapter } = wire(replayOn(), false);
    const show = vi.fn();
    adapter.__registerShowModal(show);
    void adapter.__openReporter();
    expect(show).toHaveBeenCalledTimes(1);
    adapter.__resolveOpen({ status: 'cancelled' });
    const listener = vi.fn();
    adapter.__subscribeReportHotkey(listener);
    expect(listener).toHaveBeenCalledWith('Mod+Shift+B');
  });
});
