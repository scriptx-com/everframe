// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Singleton wiring for device naming (naming spec 2026-08-24): start() builds
// a deviceProvider from companionDeviceId + UA facts, badge config follows
// the attachPinUi first-start()-wins contract, useCompanion exposes
// resolvedName.
//
// `start()` builds a real `RelayWSClient` via `createRelayWSClient`, and
// `CompanionStartOptions` has no `webSocketCtor` test seam (only
// `RelayWSClientOpts` does) — jsdom has no native WebSocket, so every test
// that calls `start()` stubs the global the same way `attach-pin.spec.tsx`
// does, and unstubs it afterward.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  start, stop,
  __getCompanionApi, __getCompanionBadgeConfig,
  __resetDeviceIdForTests,
} from '@traceitx/web';
import { useCompanion } from '../../src/companion/use-companion.js';

function makeNoopWSCtor(): typeof WebSocket {
  return class NoopWS {
    readyState = 0;
    binaryType = 'blob';
    addEventListener(): void {}
    send(): void {}
    close(): void {}
  } as unknown as typeof WebSocket;
}

afterEach(() => {
  stop();
  __getCompanionApi().__setResolvedName(null);
  __resetDeviceIdForTests();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('companion singleton device naming', () => {
  it('badge config defaults on, bottom-right; first start() wins', () => {
    vi.stubGlobal('WebSocket', makeNoopWSCtor());
    start({ companionBadge: { position: 'top-left' } });
    expect(__getCompanionBadgeConfig()).toEqual({ enabled: true, position: 'top-left' });
    // Repeat start() with different config is a no-op (attachPinUi contract).
    start({ companionBadge: { enabled: false } });
    expect(__getCompanionBadgeConfig()).toEqual({ enabled: true, position: 'top-left' });
  });

  it('companionBadge.enabled: false turns the badge off', () => {
    vi.stubGlobal('WebSocket', makeNoopWSCtor());
    start({ companionBadge: { enabled: false } });
    expect(__getCompanionBadgeConfig().enabled).toBe(false);
  });

  it('useCompanion exposes resolvedName reactively', () => {
    const { result } = renderHook(() => useCompanion());
    expect(result.current.resolvedName).toBeNull();
    act(() => { __getCompanionApi().__setResolvedName('QA Lobby TV'); });
    expect(result.current.resolvedName).toBe('QA Lobby TV');
  });

  // External review W2: a stopped client has no live attach — stop() must
  // clear attachedUserName so the badge doesn't survive a manual stop().
  it('stop() after an attach clears attachedUserName', () => {
    vi.stubGlobal('WebSocket', makeNoopWSCtor());
    start();
    act(() => { __getCompanionApi().__setAttachedUserName('Aurimas'); });
    expect(__getCompanionApi().getAttachedUserName()).toBe('Aurimas');

    stop();

    expect(__getCompanionApi().getAttachedUserName()).toBeNull();
  });
});
