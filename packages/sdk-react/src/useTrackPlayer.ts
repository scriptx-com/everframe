// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import { useEffect, type RefObject } from 'react';
import { trackPlayer, type TrackPlayerOptions } from '@traceitx/web';

/**
 * Session Vitals phase 4: attach the media element behind `ref` for
 * per-player playback tracing. Attaches once the ref resolves, detaches on
 * unmount, re-attaches when any option's identity changes (pass a stable
 * hls/shaka instance — a new object every render re-attaches every render).
 */
export function useTrackPlayer(
  ref: RefObject<HTMLMediaElement | null>,
  opts: Omit<TrackPlayerOptions, 'element'> = {},
): void {
  const { hls, shaka, integration, name } = opts;
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const handle = trackPlayer({
      element,
      ...(hls !== undefined ? { hls } : {}),
      ...(shaka !== undefined ? { shaka } : {}),
      ...(integration !== undefined ? { integration } : {}),
      ...(name !== undefined ? { name } : {}),
    });
    return () => handle.detach();
  }, [ref, hls, shaka, integration, name]);
}
