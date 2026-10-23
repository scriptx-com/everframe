// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// Everframe Companion has been removed. `useCompanion()` stays as a
// deprecated stub returning the same idle object on every render, the
// `companion` namespace keeps its documented members, and the Provider no
// longer renders any Companion surface.
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EverframeProvider } from '../src/provider.js';
import * as root from '../src/index.js';
import { companion, useCompanion } from '../src/index.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('deprecated Companion stubs (React)', () => {
  it('useCompanion returns the same idle object on every render', () => {
    const { result, rerender } = renderHook(() => useCompanion());
    const first = result.current;
    rerender();
    rerender();
    expect(result.current).toBe(first);
    expect(first).toEqual({
      state: 'unpaired',
      pairUrl: null,
      code: null,
      attachedUserName: null,
      resolvedName: null,
      attachChallenge: null,
      running: false,
    });
    expect(companion.useCompanion).toBe(useCompanion);
  });

  it('keeps the documented namespace members and drops the removed plumbing', () => {
    expect(typeof companion.start).toBe('function');
    expect(typeof companion.stop).toBe('function');
    expect(typeof companion.createCompanion).toBe('function');
    const ns = companion as Record<string, unknown>;
    for (const removed of ['announce', 'createRelayWSClient', 'handleReportRequest']) {
      expect(ns[removed], removed).toBeUndefined();
    }
    expect((root as Record<string, unknown>).__setCompanionHost).toBeUndefined();
  });

  it('the provider renders no companion surface, and companion.start() opens nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ws = vi.fn();
    vi.stubGlobal('WebSocket', ws);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ replayEnabled: false, replayDurationSec: 30, samplingRate: 1 }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const { container } = render(
      <EverframeProvider config={{ sdkKey: 'txx_live_test' }}>
        <div data-testid="child" />
      </EverframeProvider>,
    );
    act(() => {
      companion.start();
      companion.start();
      companion.stop();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(ws).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="companion-pin-card"]')).toBeNull();
    expect(container.querySelector('[data-testid="companion-badge"]')).toBeNull();
    expect(document.querySelector('[data-everframe-companion-badge]')).toBeNull();
    const companionWarnings = warn.mock.calls.filter(([m]) =>
      String(m).includes('Everframe Companion has been removed'),
    );
    expect(companionWarnings.length).toBeLessThanOrEqual(1);
  });
});
