// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Session Vitals — the library-agnostic JS player API (spec 2026-09-06 §3).
// A handle is a thin, fail-soft forwarder to the TurboModule. Native queues
// the registration until a controller exists, so nothing here waits for
// mount/configure. After detach() a handle is inert and never crosses the
// bridge again.
import { useEffect, useMemo, useRef } from 'react';
import type { VitalsPlayerEventType } from '@traceitx/protocol';
import NativeTraceItX from './NativeTraceItX.js';

export interface PlayerStats {
  bufferAheadMs: number;
  bandwidthEstimate?: number;
  bitrate?: number;
  width?: number;
  height?: number;
  /** CUMULATIVE; native derives the per-tick delta. */
  droppedFrames?: number;
}

export interface TrackPlayerOptions {
  /** ≤ 32 chars, free string ('react-native-video', 'theoplayer', …). */
  library: string;
  libraryVersion?: string;
  name?: string;
}

/**
 * The event types a HOST may emit. `player_attach` / `player_detach` are
 * reserved for the native registry's own lifecycle markers — native drops
 * them if they arrive from JS, so the type excludes them up front.
 */
export type HostPlayerEventType = Exclude<VitalsPlayerEventType, 'player_attach' | 'player_detach'>;

export interface PlayerHandle {
  readonly token: string;
  readonly detached: boolean;
  emit(type: HostPlayerEventType, data?: Record<string, unknown>, t?: number): void;
  updateStats(stats: PlayerStats): void;
  track(name: string, data?: unknown): void;
  detach(): void;
}

let tokenCounter = 0;
export function __resetPlayerTokenCounterForTests(): void { tokenCounter = 0; }

function guarded(fn: () => void): void {
  try { fn(); } catch (e) {
    if (typeof __DEV__ !== 'undefined' && __DEV__) console.warn('[traceitx] vitals bridge call failed', e);
  }
}

/** JSON string for the bridge, or undefined when absent/unserialisable. */
export function serializeVitalsData(data: unknown): string | undefined {
  if (data === undefined) return undefined;
  try {
    const s = JSON.stringify(data);
    return s === undefined ? undefined : s;
  } catch (e) {
    if (typeof __DEV__ !== 'undefined' && __DEV__) console.warn('[traceitx] trackVitals data is not JSON-serialisable; sent without data', e);
    return undefined;
  }
}

export function trackPlayer(opts: TrackPlayerOptions): PlayerHandle {
  const token = `rp${++tokenCounter}`;
  let detached = false;
  guarded(() => NativeTraceItX.trackPlayer(token, opts.library, opts.name, opts.libraryVersion));
  return {
    token,
    get detached() { return detached; },
    emit(type, data, t) {
      if (detached) return;
      const at = t ?? Date.now();
      guarded(() => NativeTraceItX.recordPlayerEvent(token, type, at, data));
    },
    updateStats(stats) {
      if (detached) return;
      guarded(() => NativeTraceItX.updatePlayerStats(token, stats as unknown as Record<string, unknown>));
    },
    track(name, data) {
      if (detached) return;
      guarded(() => NativeTraceItX.trackVitals(name, serializeVitalsData(data), token));
    },
    detach() {
      if (detached) return;
      detached = true;
      guarded(() => NativeTraceItX.detachPlayer(token));
    },
  };
}

export function trackVitals(name: string, data?: unknown, player?: PlayerHandle): void {
  if (player) { player.track(name, data); return; }
  guarded(() => NativeTraceItX.trackVitals(name, serializeVitalsData(data), undefined));
}

/**
 * Bind a player registration to a component's lifetime: track on mount,
 * detach on unmount, fresh token when an option changes. The returned
 * handle is STABLE (same identity every render) and forwards to the live
 * inner handle — inert before mount and after unmount — so Fast Refresh and
 * StrictMode's effect double-run cannot leak a registration.
 */
export function useTrackPlayer(opts: TrackPlayerOptions): PlayerHandle {
  const inner = useRef<PlayerHandle | null>(null);
  const { library, libraryVersion, name } = opts;
  useEffect(() => {
    const h = trackPlayer(opts);
    inner.current = h;
    return () => { h.detach(); if (inner.current === h) inner.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `opts` is re-read through its
    // destructured fields, which ARE the deps; the object identity changes every render.
  }, [library, libraryVersion, name]);
  return useMemo<PlayerHandle>(() => ({
    get token() { return inner.current?.token ?? ''; },
    get detached() { return inner.current?.detached ?? true; },
    emit: (type, data, t) => inner.current?.emit(type, data, t),
    updateStats: (s) => inner.current?.updateStats(s),
    track: (n, d) => inner.current?.track(n, d),
    detach: () => inner.current?.detach(),
  }), []);
}
