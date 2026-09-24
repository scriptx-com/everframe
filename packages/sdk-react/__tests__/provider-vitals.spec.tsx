// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// Codex round-1 finding S1 (the biggest one) — `@everframe/web`'s `init.ts`
// calls `setupVitals()` right after building its client/adapter; this
// Provider builds the SAME `createWebPlatformAdapter` adapter (see the
// `ctxValue` useMemo in provider.tsx) but never called `setupVitals()` at
// all, so every React host shipped ZERO Session Vitals sessions, ever —
// only vanilla `@everframe/web` hosts (`init()`) got vitals.
//
// Mock-level (module-mock `@everframe/web`'s `setupVitals` export), per the
// spec's own guidance: driving a real vitals session end to end through this
// Provider would require also faking the resource sampler / player adapter
// the way `packages/sdk-web/__tests__/vitals/wiring.spec.ts` does, which is
// `@everframe/web`'s own test surface, not this package's — this spec's job
// is only to prove the WIRING (setupVitals invoked with the right deps on
// mount, its handle destroyed on unmount), which a mock proves directly.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { EverframeProvider } from '../src/provider.js';

const setupVitalsMock = vi.hoisted(() => vi.fn());

vi.mock('@everframe/web', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@everframe/web')>();
  return {
    ...actual,
    setupVitals: setupVitalsMock,
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setupVitalsMock.mockReset();
});

const config = { apiKey: 'txx_live_test' };

describe('EverframeProvider — Session Vitals wiring (Codex round-1 finding S1)', () => {
  it('calls setupVitals exactly once on mount, mirroring init.ts\'s deps', () => {
    const destroy = vi.fn();
    setupVitalsMock.mockReturnValue({ destroy });

    render(
      <EverframeProvider config={config}>
        <div>hello</div>
      </EverframeProvider>,
    );

    expect(setupVitalsMock).toHaveBeenCalledTimes(1);
    const deps = setupVitalsMock.mock.calls[0]![0] as {
      config: unknown;
      apiKey: string;
      apiUrl: string;
      sdkVersion: string;
      isKilled: () => boolean;
    };
    // Same deps init.ts passes: config, apiKey, apiUrl, isKilled, sdkVersion —
    // using THIS provider's own identity, not the vanilla SDK's.
    expect(deps.config).toBe(config);
    expect(deps.apiKey).toBe(config.apiKey);
    expect(typeof deps.apiUrl).toBe('string');
    expect(deps.apiUrl.length).toBeGreaterThan(0);
    expect(typeof deps.sdkVersion).toBe('string');
    expect(deps.sdkVersion.length).toBeGreaterThan(0);
    expect(typeof deps.isKilled).toBe('function');
    // Not killed yet — a freshly-mounted client's own state.killed is false.
    expect(deps.isKilled()).toBe(false);
  });

  it('calls the handle\'s destroy() in the unmount cleanup', () => {
    const destroy = vi.fn();
    setupVitalsMock.mockReturnValue({ destroy });

    const { unmount } = render(
      <EverframeProvider config={config}>
        <div>hello</div>
      </EverframeProvider>,
    );
    expect(destroy).not.toHaveBeenCalled();

    unmount();

    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('isKilled() reflects the live client — true after client.kill()', async () => {
    const destroy = vi.fn();
    setupVitalsMock.mockReturnValue({ destroy });

    const { unmount } = render(
      <EverframeProvider config={config}>
        <div>hello</div>
      </EverframeProvider>,
    );

    const deps = setupVitalsMock.mock.calls[0]![0] as { isKilled: () => boolean };
    expect(deps.isKilled()).toBe(false);

    // The Provider's own unmount effect calls client.kill() (DEFE-03
    // cleanup) — after that, isKilled() must read `true` for anything that
    // still holds this deps object (mirrors init.ts's permanent-not-
    // revivable `state.killed` doctrine).
    unmount();
    expect(deps.isKilled()).toBe(true);
  });
});
