// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
const state = vi.hoisted(() => ({ register: vi.fn(), node: { canonical: { nativeTag: 91 } } }));
vi.mock('react', async (original) => ({
  ...(await original<typeof React>()),
  useRef: () => ({ current: state.node }),
  useCallback: (fn: unknown) => fn,
}));
vi.mock('../src/EverframeProvider.js', () => ({
  useEverframe: () => ({ sensitive: { register: state.register } }),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: 'View',
  requireNativeComponent: (name: string) => name,
}));
import { EverframeSensitive } from '../src/Sensitive.js';

describe('iOS sensitive mount contract', () => {
  it('preserves a native host for Fabric sensitivity lookup', () => {
    const style = { flex: 1, alignSelf: 'stretch' as const };
    const onLayout = vi.fn();
    const child = React.createElement('Child');
    const result = EverframeSensitive({
      nativeID: 'caller',
      collapsable: true,
      style,
      accessible: true,
      accessibilityLabel: 'private group',
      onLayout,
      children: child,
    });
    expect(result.type).toBe('View');
    expect(result.props).toMatchObject({
      nativeID: 'caller',
      collapsable: false,
      style,
      accessible: true,
      accessibilityLabel: 'private group',
      children: child,
    });
    expect(state.register).not.toHaveBeenCalled();
    const event = { nativeEvent: { layout: { x: 0, y: 0, width: 3, height: 4 } } };
    (result.props as { onLayout: (event: unknown) => void }).onLayout(event);
    expect(state.register).toHaveBeenCalledWith(91, event.nativeEvent.layout);
    expect(onLayout).toHaveBeenCalledWith(event);
  });
});
