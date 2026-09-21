// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// `useCompanion().running` (spec 2026-09-17 — React SDK surface parity): the
// SDK now owns the cross-mount "is a session wanted" flag hosts previously
// had to track themselves in a module-scoped variable. Covers start()/stop()
// and — the whole point of the feature — that a FRESH mount seeds `running`
// from the live singleton value (`useState(__getCompanionRunning())`) on its
// very first render, not from a `false` default that only self-corrects once
// an effect fires.
//
// Same WebSocket-stub doctrine as singleton-device.spec.tsx: `start()` builds
// a real `RelayWSClient`, and jsdom has no native WebSocket.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { start, stop } from '@traceitx/web';
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
  vi.unstubAllGlobals();
});

describe('useCompanion().running', () => {
  it('tracks start() and stop() across the same mount', () => {
    vi.stubGlobal('WebSocket', makeNoopWSCtor());
    const { result } = renderHook(() => useCompanion());
    expect(result.current.running).toBe(false);

    act(() => {
      start();
    });
    expect(result.current.running).toBe(true);

    act(() => {
      stop();
    });
    expect(result.current.running).toBe(false);
  });

  it('seeds a fresh mount from the live value on its FIRST render', () => {
    vi.stubGlobal('WebSocket', makeNoopWSCtor());
    start();

    // No render of this hook has happened yet at this point — the singleton
    // was started independently. A brand-new mount must still observe
    // `running: true` immediately.
    const { result } = renderHook(() => useCompanion());
    expect(result.current.running).toBe(true);
  });
});
