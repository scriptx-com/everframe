// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Session Vitals — useTrackPlayer hook unit tests (spec 2026-09-06 §3, Task 3).
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import NativeEverframe from '../src/NativeEverframe.js';
import { useTrackPlayer, __resetPlayerTokenCounterForTests, type PlayerHandle } from '../src/vitals.js';

const native = NativeEverframe as unknown as Record<string, ReturnType<typeof vi.fn>>;

function Probe({ name, onHandle }: { name: string; onHandle: (h: PlayerHandle) => void }) {
  const h = useTrackPlayer({ library: 'test-lib', name });
  onHandle(h);
  return null;
}

describe('useTrackPlayer', () => {
  beforeEach(() => { for (const f of Object.values(native)) f.mockClear?.(); __resetPlayerTokenCounterForTests(); });

  it('tracks on mount, detaches on unmount, and the returned handle is stable', () => {
    const seen: PlayerHandle[] = [];
    const { unmount, rerender } = render(<Probe name="a" onHandle={(h) => seen.push(h)} />);
    expect(native.trackPlayer).toHaveBeenCalledWith('rp1', 'test-lib', 'a', undefined);
    rerender(<Probe name="a" onHandle={(h) => seen.push(h)} />);
    expect(seen[0]).toBe(seen[1]);
    seen[0].emit('play');
    expect(native.recordPlayerEvent).toHaveBeenCalledWith('rp1', 'play', expect.any(Number), undefined);
    unmount();
    expect(native.detachPlayer).toHaveBeenCalledWith('rp1');
    native.recordPlayerEvent.mockClear();
    seen[0].emit('pause');
    expect(native.recordPlayerEvent).not.toHaveBeenCalled();
  });

  it('a changed option re-tracks with a fresh token', () => {
    const { rerender } = render(<Probe name="a" onHandle={() => {}} />);
    rerender(<Probe name="b" onHandle={() => {}} />);
    expect(native.detachPlayer).toHaveBeenCalledWith('rp1');
    expect(native.trackPlayer).toHaveBeenLastCalledWith('rp2', 'test-lib', 'b', undefined);
  });
});
