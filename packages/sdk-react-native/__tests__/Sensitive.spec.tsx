// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Plan 06-05 Task 2 — <TraceItXSensitive> uses a pure helper
// `handleSensitiveLayout(node, register, event)` that reads the dual-shape
// native tag (Paper: node._nativeTag; Fabric: node.canonical._nativeTag) and
// forwards (tag, rect) to the provider's sensitive registry. Testing the
// helper directly avoids RN renderer + RTL setup; the wrapper component
// just wires `ref.current` + `e.nativeEvent.layout` into it.
import { describe, it, expect, vi } from 'vitest';
import { handleSensitiveLayout } from '../src/Sensitive.js';

type LayoutEvent = {
  nativeEvent: { layout: { x: number; y: number; width: number; height: number } };
};

function evt(): LayoutEvent {
  return { nativeEvent: { layout: { x: 1, y: 2, width: 3, height: 4 } } };
}

describe('<TraceItXSensitive> handleSensitiveLayout (Plan 06-05 Task 2)', () => {
  it('reads Paper _nativeTag and calls register(tag, rect)', () => {
    const register = vi.fn();
    handleSensitiveLayout({ _nativeTag: 4242 } as unknown, register, evt());
    expect(register).toHaveBeenCalledWith(4242, { x: 1, y: 2, width: 3, height: 4 });
  });

  it('reads Fabric canonical._nativeTag in preference', () => {
    const register = vi.fn();
    handleSensitiveLayout(
      { _nativeTag: 1, canonical: { _nativeTag: 9999 } } as unknown,
      register,
      evt()
    );
    expect(register).toHaveBeenCalledWith(9999, { x: 1, y: 2, width: 3, height: 4 });
  });

  it('no-op when node is null/undefined', () => {
    const register = vi.fn();
    handleSensitiveLayout(null, register, evt());
    handleSensitiveLayout(undefined, register, evt());
    expect(register).not.toHaveBeenCalled();
  });

  it('no-op when both tags are missing', () => {
    const register = vi.fn();
    handleSensitiveLayout({ foo: 'bar' } as unknown, register, evt());
    expect(register).not.toHaveBeenCalled();
  });
});
