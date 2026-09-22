// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  getNativeTagFromHostFiber,
  __resetHostTagWarn,
} from '../../src/capture/host-tag-rn.js';

describe('getNativeTagFromHostFiber', () => {
  beforeEach(() => {
    __resetHostTagWarn();
  });

  it('reads stateNode.canonical.nativeTag (RN ≥ 0.80 Fabric)', () => {
    // react-native-tvos@0.85.3-0 — confirmed empirically against
    // Libraries/Renderer/implementations/ReactFabric-dev.js getPublicInstance
    // which reads instance.canonical.nativeTag (no leading underscore).
    const fiber = { stateNode: { canonical: { nativeTag: 4242 } } };
    expect(getNativeTagFromHostFiber(fiber)).toBe(4242);
  });

  it('reads stateNode.canonical._nativeTag (Fabric RN 0.70–0.79)', () => {
    const fiber = { stateNode: { canonical: { _nativeTag: 1001 } } };
    expect(getNativeTagFromHostFiber(fiber)).toBe(1001);
  });

  it('reads stateNode.__nativeTag (Fabric public instance / ReactNativeElement)', () => {
    // The public instance exposes __nativeTag (double underscore) per
    // ReactFabricPublicInstanceUtils.js isPublicInstance().
    const fiber = { stateNode: { __nativeTag: 5050 } };
    expect(getNativeTagFromHostFiber(fiber)).toBe(5050);
  });

  it('reads stateNode._nativeTag (Paper / legacy architecture)', () => {
    const fiber = { stateNode: { _nativeTag: 1002 } };
    expect(getNativeTagFromHostFiber(fiber)).toBe(1002);
  });

  it('prefers new Fabric shape over legacy when both present', () => {
    // Defends against future RN versions exposing both during migration.
    const fiber = {
      stateNode: { canonical: { nativeTag: 7, _nativeTag: 99 } },
    };
    expect(getNativeTagFromHostFiber(fiber)).toBe(7);
  });

  it('returns null + warns once when stateNode is null', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(getNativeTagFromHostFiber({ stateNode: null })).toBeNull();
    expect(getNativeTagFromHostFiber({ stateNode: null })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('returns null when no recognized shape is present', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fiber = { stateNode: { canonical: { wrong: 1 }, unrelated: 'x' } };
    expect(getNativeTagFromHostFiber(fiber)).toBeNull();
    warn.mockRestore();
  });
});
