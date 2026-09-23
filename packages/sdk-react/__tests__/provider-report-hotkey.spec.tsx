// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@everframe/web/ui', () => ({
  ReporterDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="reporter-modal" /> : null,
  ReporterFab: () => null,
  CompanionPinCard: () => null,
  CompanionBadge: () => null,
  InboxDialog: () => null,
  Toast: () => null,
}));

import { EverframeProvider } from '../src/provider.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(binding: string): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/api/config')) {
      return new Response(JSON.stringify({
        replayEnabled: false,
        replayDurationSec: 30,
        samplingRate: 1,
        reportHotkey: { binding },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }));
}

describe('dashboard-owned report hotkey', () => {
  it('rebinds the Provider trigger to the remotely configured combination', async () => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Linux x86_64' });
    stubFetch('Alt+R');
    render(
      <EverframeProvider config={{ apiKey: 'txx_live_test' }}>
        <div>host</div>
      </EverframeProvider>,
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'B',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      }));
      await Promise.resolve();
    });
    expect(screen.queryByTestId('reporter-modal')).toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'R',
        altKey: true,
        bubbles: true,
      }));
    });
    expect(await screen.findByTestId('reporter-modal')).toBeInTheDocument();
  });
});
