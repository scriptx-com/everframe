// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// Crash-only sessions (spec 2026-10-12), React host. A Provider whose config
// sets `reporter: { disabled: true }` binds no hotkey, rejects `open()`,
// hands the inbox no "New report" action, and upgrades replay coverage when
// the page-wide companion bonds, including after a StrictMode rebuild. Each
// refusal is paired with a live control on a report session.
import { StrictMode, useContext } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const inboxProps: Array<{ onNewReport?: () => void }> = [];
vi.mock('@everframe/web/ui', () => ({
  ReporterDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="reporter-modal" /> : null,
  ReporterFab: () => null,
  CompanionPinCard: () => null,
  CompanionBadge: () => null,
  InboxDialog: (props: { onNewReport?: () => void }) => {
    inboxProps.push(props);
    return null;
  },
  Toast: () => null,
}));

import { __getCompanionApi } from '@everframe/web';
import { EverframeProvider, EverframeContext, type InternalContext } from '../src/provider.js';
import { useEverframe } from '../src/hook.js';
import { open as topLevelOpen, EverframeReporterDisabledError } from '../src/index.js';
import { EverframeReporterDisabledError as WebError } from '@everframe/web';

let latest: InternalContext | null = null;
let hookOpen: (() => Promise<unknown>) | null = null;

function Probe(): null {
  latest = useContext(EverframeContext);
  hookOpen = useEverframe().open;
  return null;
}

beforeEach(() => {
  __getCompanionApi().__setState('unpaired');
});

afterEach(() => {
  cleanup();
  latest = null;
  hookOpen = null;
  inboxProps.length = 0;
  __getCompanionApi().__setState('unpaired');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(replayEnabled: boolean): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/api/config')) {
      return new Response(JSON.stringify({
        replayEnabled,
        replayDurationSec: 30,
        samplingRate: 1,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }));
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

function mount(reporterDisabled: boolean, strict = false): void {
  const tree = (
    <EverframeProvider
      config={{ sdkKey: 'txx_live_test', ...(reporterDisabled ? { reporter: { disabled: true } } : {}) }}
    >
      <Probe />
    </EverframeProvider>
  );
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

async function pressHotkey(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'B',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
    }));
    await Promise.resolve();
  });
}

describe('crash-only Provider: entry points', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Linux x86_64' });
  });

  it('LIVE control: the hotkey opens the reporter in a report session', async () => {
    stubFetch(false);
    mount(false);
    await settle();
    await pressHotkey();
    expect(await screen.findByTestId('reporter-modal')).toBeInTheDocument();
  });

  it('binds no hotkey', async () => {
    stubFetch(false);
    mount(true);
    await settle();
    await pressHotkey();
    expect(screen.queryByTestId('reporter-modal')).toBeNull();
  });

  it('useEverframe().open() and the top-level open() reject', async () => {
    stubFetch(false);
    mount(true);
    await settle();
    await expect(hookOpen!()).rejects.toBeInstanceOf(EverframeReporterDisabledError);
    await expect(topLevelOpen()).rejects.toBeInstanceOf(EverframeReporterDisabledError);
    expect(screen.queryByTestId('reporter-modal')).toBeNull();
    expect(EverframeReporterDisabledError).toBe(WebError);
  });

  it('openModal() opens nothing', async () => {
    stubFetch(false);
    mount(true);
    await settle();
    act(() => latest!.openModal());
    expect(screen.queryByTestId('reporter-modal')).toBeNull();
  });

  it('LIVE control: a report session hands the inbox a New report action', async () => {
    stubFetch(false);
    mount(false);
    await settle();
    expect(typeof inboxProps.at(-1)?.onNewReport).toBe('function');
  });

  it('hands the inbox no New report action', async () => {
    stubFetch(false);
    mount(true);
    await settle();
    expect(inboxProps.length).toBeGreaterThan(0);
    expect(inboxProps.at(-1)?.onNewReport).toBeUndefined();
  });
});

describe('crash-only Provider: companion upgrade', () => {
  it('records nothing until a companion bonds, then starts at once', async () => {
    stubFetch(true);
    mount(true);
    await settle();
    expect(latest!.adapter.__replayLifecycle?.state).toBe('IDLE');

    act(() => __getCompanionApi().__setState('paired'));
    expect(latest!.adapter.__replayLifecycle?.state).toBe('BUFFERING');
  });

  it('upgrades the adapter StrictMode commits when the bond came first', async () => {
    stubFetch(true);
    __getCompanionApi().__setState('paired');
    mount(true, true);
    await settle();
    await settle();
    expect(latest!.adapter.__replayLifecycle?.state).toBe('BUFFERING');
  });

  it('LIVE control: a report session records without a bond', async () => {
    stubFetch(true);
    mount(false);
    await settle();
    expect(latest!.adapter.__replayLifecycle?.state).toBe('BUFFERING');
  });
});
