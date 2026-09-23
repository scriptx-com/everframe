// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Attach-time name badge (naming spec 2026-08-24 §4). Visible ONLY while a
// companion session is attached (attachedUserName non-null); carries all
// THREE capture-exclusion markers (the CompanionPinCard precedent); never
// renders when disabled. Identification only — NOT the removed sharing
// indicator.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { CompanionBadge } from '@everframe/web/ui';
import {
  start,
  stop,
  __getCompanionApi,
  __setCompanionBadgeServerConfig,
} from '@everframe/web';

function attachSession(): void {
  act(() => {
    __getCompanionApi().__setAttachedUserName('Aurimas');
    __getCompanionApi().__setResolvedName('Pixel 7 · Android 14 · Emulator');
    __getCompanionApi().__setCode('7K2Q');
  });
}

/**
 * Minimal WebSocket stub for the `enabled: false` case, which drives state
 * through a real `start()` call — jsdom has no WebSocket, and
 * `CompanionStartOptions` has no `webSocketCtor` test seam (only
 * `RelayWSClientOpts` does), so the global is stubbed instead. Mirrors
 * attach-pin.spec.tsx's `makeNoopWSCtor`. Never fires any event; a real
 * connection is never attempted.
 */
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
  cleanup();
  stop();
  vi.unstubAllGlobals();
  act(() => {
    __getCompanionApi().__setAttachedUserName(null);
    __getCompanionApi().__setResolvedName(null);
    __getCompanionApi().__setCode(null);
  });
});

describe('CompanionBadge', () => {
  it('hidden by default; appears on attach with name + code; gone on detach', () => {
    render(<CompanionBadge />);
    expect(screen.queryByTestId('everframe-companion-badge')).toBeNull();
    attachSession();
    const badge = screen.getByTestId('everframe-companion-badge');
    expect(badge.textContent).toContain('Pixel 7 · Android 14 · Emulator');
    expect(badge.textContent).toContain('7K2Q');
    act(() => { __getCompanionApi().__setAttachedUserName(null); });
    expect(screen.queryByTestId('everframe-companion-badge')).toBeNull();
  });

  it('falls back to the code alone when no resolvedName exists', () => {
    render(<CompanionBadge />);
    act(() => {
      __getCompanionApi().__setAttachedUserName('Aurimas');
      __getCompanionApi().__setCode('7K2Q');
    });
    expect(screen.getByTestId('everframe-companion-badge').textContent).toContain('7K2Q');
  });

  it('is excluded from screenshot, uiTree, sensitive registry, and replay', () => {
    // The three-marker contract — mirrors attach-pin.spec.tsx's
    // 'is excluded from capture and replay via both mechanisms'.
    render(<CompanionBadge />);
    attachSession();
    const badge = screen.getByTestId('everframe-companion-badge');
    expect(badge.getAttribute('data-everframe-skip-capture')).toBe('true'); // screenshot filter + uiTree walks
    expect(badge.hasAttribute('data-everframe-sensitive')).toBe(true);      // registry masking
    expect(badge.className).toContain('rr-block');                          // rrweb blockClass (late-mount safe)
  });

  it('the screenshot filter actually drops it', async () => {
    // Direct predicate check against the real filter, mirroring
    // __tests__/capture/screenshot.spec.ts's technique.
    render(<CompanionBadge />);
    attachSession();
    const { __filterNodeForTests } = await import('@everframe/web');
    expect(__filterNodeForTests(screen.getByTestId('everframe-companion-badge'))).toBe(false);
  });

  it('renders nothing when companionBadge.enabled is false', () => {
    vi.stubGlobal('WebSocket', makeNoopWSCtor());
    try {
      start({ companionBadge: { enabled: false } });
      render(<CompanionBadge />);
      attachSession();
      expect(screen.queryByTestId('everframe-companion-badge')).toBeNull();
    } finally {
      // Restore the default so this module-scope config doesn't leak into
      // other test files sharing the same singleton within this worker —
      // mirrors attach-pin.spec.tsx's "restore builtin" cleanup for
      // __getAttachPinUiMode().
      stop();
      start({ companionBadge: { enabled: true } });
      stop();
    }
  });
});

describe('server config overlay', () => {
  afterEach(() => {
    __setCompanionBadgeServerConfig(undefined);
  });

  it('server enabled:false hides the badge over inline default-on', () => {
    vi.stubGlobal('WebSocket', makeNoopWSCtor());
    try {
      start({});
      render(<CompanionBadge />);
      attachSession();
      expect(screen.getByTestId('everframe-companion-badge')).toBeTruthy();
      act(() => {
        __setCompanionBadgeServerConfig({ enabled: false });
      });
      expect(screen.queryByTestId('everframe-companion-badge')).toBeNull();
    } finally {
      stop();
    }
  });

  it('server enabled:true shows the badge over inline enabled:false', () => {
    vi.stubGlobal('WebSocket', makeNoopWSCtor());
    try {
      start({ companionBadge: { enabled: false } });
      render(<CompanionBadge />);
      attachSession();
      expect(screen.queryByTestId('everframe-companion-badge')).toBeNull();
      act(() => {
        __setCompanionBadgeServerConfig({ enabled: true });
      });
      expect(screen.getByTestId('everframe-companion-badge')).toBeTruthy();
    } finally {
      stop();
    }
  });

  it('codex round-1 fix B: box set then cleared (undefined) restores inline behavior', () => {
    // Mirrors what adapter.ts's onKill() now does (__setCompanionBadgeServerConfig(undefined))
    // on client teardown — a dead adapter's override must never outlive it,
    // and the badge must fall all the way back to the inline config, not
    // just stop tracking further server changes.
    vi.stubGlobal('WebSocket', makeNoopWSCtor());
    try {
      start({ companionBadge: { enabled: false, position: 'top-right' } });
      render(<CompanionBadge />);
      attachSession();
      expect(screen.queryByTestId('everframe-companion-badge')).toBeNull(); // inline enabled:false

      act(() => {
        __setCompanionBadgeServerConfig({ enabled: true, position: 'bottom-left' });
      });
      let badge = screen.getByTestId('everframe-companion-badge');
      expect(badge.style.left).toBe('24px');
      expect(badge.style.bottom).toBe('24px');

      act(() => {
        __setCompanionBadgeServerConfig(undefined); // the clear-on-kill helper path
      });
      // Inline enabled:false must win again once the override clears entirely.
      expect(screen.queryByTestId('everframe-companion-badge')).toBeNull();
    } finally {
      stop();
    }
  });

  it('server position wins; absent server position falls back to inline', () => {
    vi.stubGlobal('WebSocket', makeNoopWSCtor());
    try {
      start({ companionBadge: { position: 'top-right' } });
      render(<CompanionBadge />);
      attachSession();
      let badge = screen.getByTestId('everframe-companion-badge');
      expect(badge.style.right).toBe('24px');
      expect(badge.style.top).toBe('24px');

      act(() => {
        __setCompanionBadgeServerConfig({ enabled: true, position: 'bottom-left' });
      });
      badge = screen.getByTestId('everframe-companion-badge');
      expect(badge.style.left).toBe('24px');
      expect(badge.style.bottom).toBe('24px');

      act(() => {
        __setCompanionBadgeServerConfig({ enabled: true });
      });
      badge = screen.getByTestId('everframe-companion-badge');
      expect(badge.style.right).toBe('24px');
      expect(badge.style.top).toBe('24px');
    } finally {
      stop();
    }
  });
});
