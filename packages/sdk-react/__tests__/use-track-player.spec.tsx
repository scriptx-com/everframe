// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, renderHook, cleanup } from '@testing-library/react';
import { useRef, type ReactNode } from 'react';

const trackPlayerMock = vi.hoisted(() => vi.fn());
const trackVitalsMock = vi.hoisted(() => vi.fn());
vi.mock('@traceitx/web', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@traceitx/web')>();
  return { ...actual, trackPlayer: trackPlayerMock, trackVitals: trackVitalsMock };
});

import { TraceItXProvider } from '../src/provider.js';
import { useTraceItX } from '../src/hook.js';
import { useTrackPlayer } from '../src/useTrackPlayer.js';

const cfg = { apiKey: 'txx_live_test' };
const wrapper = ({ children }: { children: ReactNode }) => <TraceItXProvider config={cfg}>{children}</TraceItXProvider>;
afterEach(() => { cleanup(); trackPlayerMock.mockReset(); trackVitalsMock.mockReset(); });

describe('useTraceItX().trackPlayer / trackVitals', () => {
  it('forward to @traceitx/web', () => {
    const detach = vi.fn();
    trackPlayerMock.mockReturnValue({ id: 'p1', track: vi.fn(), detach });
    const { result, unmount } = renderHook(() => useTraceItX(), { wrapper });
    const el = document.createElement('video');
    const h = result.current.trackPlayer({ element: el, name: 'main' });
    expect(trackPlayerMock).toHaveBeenCalledWith({ element: el, name: 'main' });
    expect(h.id).toBe('p1');
    result.current.trackVitals('x', { a: 1 }, { player: h });
    expect(trackVitalsMock).toHaveBeenCalledWith('x', { a: 1 }, { player: h });
    unmount();
  });
});

describe('useTrackPlayer', () => {
  function Player({ name, hls }: { name?: string; hls?: unknown }) {
    const ref = useRef<HTMLVideoElement | null>(null);
    useTrackPlayer(ref, { ...(name !== undefined ? { name } : {}), ...(hls !== undefined ? { hls } : {}) });
    return <video ref={ref} data-testid="v" />;
  }
  it('attaches once the ref resolves and detaches on unmount', () => {
    const detach = vi.fn();
    trackPlayerMock.mockReturnValue({ id: 'p1', track: vi.fn(), detach });
    const { unmount, getByTestId } = render(<Player name="main" />, { wrapper });
    expect(trackPlayerMock).toHaveBeenCalledWith({ element: getByTestId('v'), name: 'main' });
    unmount();
    expect(detach).toHaveBeenCalledTimes(1);
  });
  it('re-attaches when an option identity changes', () => {
    const detach = vi.fn();
    trackPlayerMock.mockReturnValue({ id: 'p1', track: vi.fn(), detach });
    const hlsA = {}, hlsB = {};
    const { rerender } = render(<Player hls={hlsA} />, { wrapper });
    rerender(<Player hls={hlsA} />);
    expect(trackPlayerMock).toHaveBeenCalledTimes(1);
    rerender(<Player hls={hlsB} />);
    expect(detach).toHaveBeenCalledTimes(1);
    expect(trackPlayerMock).toHaveBeenCalledTimes(2);
    expect(trackPlayerMock).toHaveBeenLastCalledWith(expect.objectContaining({ hls: hlsB }));
  });
});
