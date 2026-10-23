// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// Real-device quick capture on web TVs: the Provider installs the quick-capture
// seam for the client it actually commits, and disposes it on unmount. Under
// StrictMode the first client is killed by the Provider's own cleanup and a
// fresh context is built, so exactly one install may stay live.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode, useContext } from 'react';
import { cleanup, render } from '@testing-library/react';

type InstallFn = typeof import('../../sdk-web/src/quickcapture/install.js').installQuickCapture;
const installs: Array<{ adapter: unknown; sdkName: string; disposed: boolean }> = [];

vi.mock('../../sdk-web/src/quickcapture/install.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sdk-web/src/quickcapture/install.js')>();
  const wrapped: InstallFn = (host, load) => {
    const record = { adapter: host.adapter, sdkName: host.sdkName, disposed: false };
    installs.push(record);
    const real = actual.installQuickCapture(host, load);
    return {
      dispose: () => {
        record.disposed = true;
        real.dispose();
      },
      __onGestureForTesting: () => real.__onGestureForTesting(),
    };
  };
  return { ...actual, installQuickCapture: wrapped };
});

import { __internalClientState } from '@everframe/sdk-core';
import { EverframeContext, EverframeProvider, type InternalContext } from '../src/provider.js';

const TIZEN =
  'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.5) AppleWebKit/537.36 (KHTML, like Gecko) 85.0.4183.93/6.5 TV Safari/537.36';

let liveCtx: InternalContext | null = null;
function Probe() {
  const ctx = useContext(EverframeContext);
  if (ctx && __internalClientState.get(ctx.client)?.killed !== true) liveCtx = ctx;
  return null;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

beforeEach(() => {
  installs.length = 0;
  liveCtx = null;
  localStorage.clear();
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(TIZEN);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      if (String(url).includes('/api/config')) {
        return new Response(
          JSON.stringify({
            replayEnabled: false,
            replayDurationSec: 30,
            samplingRate: 1,
            captureHotkey: { enabled: true, binding: 'Shift+B', replay: false },
            deviceLinking: { enabled: true },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('EverframeProvider quick capture', () => {
  it('the Provider installs quick capture once under StrictMode and disposes it on unmount', async () => {
    const { unmount } = render(
      <StrictMode>
        <EverframeProvider config={{ sdkKey: 'pk_test' }}>
          <Probe />
        </EverframeProvider>
      </StrictMode>,
    );
    await settle();

    const live = installs.filter((i) => !i.disposed);
    expect(live).toHaveLength(1);
    expect(live[0]!.sdkName).toBe('everframe-react');
    expect(liveCtx).not.toBeNull();
    expect(live[0]!.adapter).toBe(liveCtx!.adapter);
    expect((liveCtx!.adapter as { __tvPlatform: unknown }).__tvPlatform).toBe('tizen');

    unmount();
    expect(installs.every((i) => i.disposed)).toBe(true);
    expect(document.getElementById('everframe-quick-capture')).toBeNull();
  });

  it("the Provider's open path (hotkey, inbox, open()) bumps the reporter-open sequence before it freezes", async () => {
    render(
      <EverframeProvider config={{ sdkKey: 'pk_test' }}>
        <Probe />
      </EverframeProvider>,
    );
    await settle();
    const adapter = liveCtx!.adapter;
    const before = adapter.__reporterOpenSeq();
    liveCtx!.openModal();
    expect(adapter.__reporterOpenSeq()).toBe(before + 1);
  });
});
