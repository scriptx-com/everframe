// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import NativeEverframe from '../src/NativeEverframe.js';
import { attachVideoPlayerVitals, useVideoPlayerVitals, type VideoPlayerLike } from '../src/integrations/react-native-video.js';
import { __resetPlayerTokenCounterForTests } from '../src/vitals.js';

// `fileURLToPath(import.meta.url)` per this package's existing convention
// (see rbridge-no-surface.test.ts, companion-bridge-wiring.spec.ts,
// install-id-inheritance.spec.ts) — `new URL(x, import.meta.url)` throws
// under the jsdom environment this spec needs for @testing-library/react.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const native = NativeEverframe as unknown as Record<string, ReturnType<typeof vi.fn>>;
const fixture = JSON.parse(readFileSync(path.join(__dirname, 'fixtures/vitals/react-native-video/session.json'), 'utf8'));

// `addEventListener` does NOT throw on a released react-native-video player
// (the emitter field is never nulled by release()) — the getter that throws
// 'player/released' is `player`, which backs `source` and `isPlaying`. The
// released-player case below models that by making `source` throw.
function fakePlayer(init: Partial<VideoPlayerLike> = {}) {
  const listeners = new Map<string, Set<(...a: unknown[]) => void>>();
  const player: VideoPlayerLike & { fire(e: string, ...a: unknown[]): void; count(): number } = {
    ...init,
    addEventListener(event, cb) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
      return { remove: () => listeners.get(event)!.delete(cb) };
    },
    fire(e, ...a) { listeners.get(e)?.forEach((cb) => cb(...a)); },
    count() { let n = 0; listeners.forEach((s) => (n += s.size)); return n; },
  };
  return player;
}
const BASE = 1_757_000_000_000;

describe('react-native-video v7 adapter', () => {
  beforeEach(() => { for (const f of Object.values(native)) f.mockClear?.(); __resetPlayerTokenCounterForTests(); vi.restoreAllMocks(); });

  it('replays the recorded session into the expected vocabulary', () => {
    let now = BASE; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const p = fakePlayer(); const detach = attachVideoPlayerVitals(p, { name: 'main', libraryVersion: '7.0.0', platform: 'ios' });
    expect(native.trackPlayer).toHaveBeenCalledWith('rp1', 'react-native-video', 'main', '7.0.0');
    for (const ev of fixture.events) { now = BASE + ev.at; p.fire(ev.event, ...ev.args); }
    const got = native.recordPlayerEvent.mock.calls.map(([, type, t, data]) => ({ type, ...(data ? { data } : {}), t: t - BASE }));
    expect(got).toEqual(fixture.expect);
    expect(native.updatePlayerStats.mock.calls.map(([, s]) => s)).toEqual(fixture.expectStats);
    detach();
    expect(native.detachPlayer).toHaveBeenCalledWith('rp1'); expect(p.count()).toBe(0);
  });

  it('seeds from an already-playing player with a loaded source', () => {
    const p = fakePlayer({ isPlaying: true, source: { uri: 'https://c/x.mpd', config: { drm: { type: 'fairplay' } } } });
    attachVideoPlayerVitals(p);
    expect(native.recordPlayerEvent.mock.calls.map((c) => c[1])).toEqual(['source_change', 'drm', 'play']);
    expect(native.recordPlayerEvent.mock.calls[0][3]).toEqual({ src: 'https://c/x.mpd' });
  });

  it('a released player is treated as already detached', () => {
    const p = fakePlayer();
    Object.defineProperty(p, 'source', { get() { throw new Error('player/released'); } });
    const detach = attachVideoPlayerVitals(p);
    expect(native.trackPlayer).not.toHaveBeenCalled();
    expect(p.count()).toBe(0);
    expect(() => detach()).not.toThrow();
  });

  it('ignores onError unless captureErrors is set', () => {
    const p = fakePlayer(); attachVideoPlayerVitals(p, { platform: 'ios' });
    p.fire('onLoadStart', { sourceType: 'network', source: { uri: 'u' } });
    p.fire('onError', { code: 'source/invalid-uri', message: 'bad uri' });
    expect(native.recordPlayerEvent.mock.calls.map((c) => c[1])).toEqual(['source_change']);
  });

  it('captureErrors: true forwards onError with code and fatal classification', () => {
    let now = BASE; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const p = fakePlayer(); attachVideoPlayerVitals(p, { platform: 'ios', captureErrors: true });
    for (const ev of fixture.events) { now = BASE + ev.at; p.fire(ev.event, ...ev.args); }
    const errors = native.recordPlayerEvent.mock.calls.filter(([, type]) => type === 'error').map(([, , t, data]) => ({ ...data, t: t - BASE }));
    // The onStatusChange('error') that follows it must NOT double-report.
    expect(errors).toEqual([{ message: 'bad uri', fatal: true, code: 'source/invalid-uri', t: 4000 }]);
  });

  it('on Android onBandwidthUpdate is a bandwidth estimate, not a bitrate', () => {
    let now = BASE; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const p = fakePlayer(); attachVideoPlayerVitals(p, { platform: 'android' });
    for (const ev of fixture.events) { now = BASE + ev.at; p.fire(ev.event, ...ev.args); }
    const got = native.recordPlayerEvent.mock.calls.map(([, type, t, data]) => ({ type, ...(data ? { data } : {}), t: t - BASE }));
    // Same run, one substitution: the rendition size is real information, the
    // ExoPlayer bandwidth estimate is not a bitrate_change.
    expect(got).toEqual(fixture.expect.map((e: { type: string }) => (
      e.type === 'bitrate_change' ? { type: 'quality_change', data: { width: 1920, height: 1080 }, t: 2300 } : e
    )));
    // Android's `bufferDuration` is ALREADY the time buffered ahead of the
    // playhead, so it is used raw — unlike iOS, where it is the buffered
    // range's absolute end and the playhead has to come off it.
    // The dimensions come from `onLoad` (900) and are carried on every push from then on
    // (codex round-2, D3) — the bandwidth estimate at 2300 replaces them with the rendition's.
    expect(native.updatePlayerStats.mock.calls.map(([, s]) => s)).toEqual([
      { bufferAheadMs: 8500, width: 1280, height: 720 },
      { bufferAheadMs: 12000, bandwidthEstimate: 4200000, width: 1920, height: 1080 },
    ]);
  });

  it('onStatusChange("error") closes spans when no onError fired', () => {
    const p = fakePlayer(); attachVideoPlayerVitals(p);
    p.fire('onLoadStart', { sourceType: 'network', source: { uri: 'u' } }); p.fire('onPlaybackStateChange', { isPlaying: true, isBuffering: false });
    p.fire('onStatusChange', 'error');
    expect(native.recordPlayerEvent.mock.calls.map((c) => c[1])).toEqual(['source_change', 'startup', 'play', 'error', 'pause']);
  });

  it('seeding a loaded but paused player never fabricates a startup latency', () => {
    let now = BASE; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const p = fakePlayer({ isPlaying: false, source: { uri: 'https://c/x.mpd' } });
    attachVideoPlayerVitals(p, { platform: 'ios' });
    now = BASE + 60_000;
    p.fire('onPlaybackStateChange', { isPlaying: true, isBuffering: false });
    expect(native.recordPlayerEvent.mock.calls.map((c) => c[1])).toEqual(['source_change', 'play']);
  });

  it('a load cycle drops the previous source cached bitrate so the next one is not de-duped', () => {
    let now = BASE; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const p = fakePlayer(); attachVideoPlayerVitals(p, { platform: 'ios' });
    p.fire('onLoadStart', { sourceType: 'network', source: { uri: 'a' } });
    p.fire('onBandwidthUpdate', { bitrate: 4_200_000, width: 1920, height: 1080 });
    p.fire('onLoadStart', { sourceType: 'network', source: { uri: 'b' } });
    p.fire('onBandwidthUpdate', { bitrate: 4_200_000, width: 1920, height: 1080 });
    expect(native.recordPlayerEvent.mock.calls.filter(([, type]) => type === 'bitrate_change')).toHaveLength(2);
  });

  it('a stats push right after a load cycle carries no stale bitrate or size', () => {
    let now = BASE; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const p = fakePlayer(); attachVideoPlayerVitals(p, { platform: 'ios' });
    p.fire('onLoadStart', { sourceType: 'network', source: { uri: 'a' } });
    p.fire('onBandwidthUpdate', { bitrate: 4_200_000, width: 1920, height: 1080 });
    p.fire('onProgress', { currentTime: 0.5, bufferDuration: 8.5 });
    now = BASE + 2000;
    p.fire('onLoadStart', { sourceType: 'network', source: { uri: 'b' } });
    p.fire('onProgress', { currentTime: 0.25, bufferDuration: 4.25 });
    expect(native.updatePlayerStats.mock.calls.map(([, s]) => s)).toEqual([
      { bufferAheadMs: 8000, bitrate: 4_200_000, width: 1920, height: 1080 },
      { bufferAheadMs: 4000 },
    ]);
  });

  it('a non-fatal captured error does not suppress a later fatal status error', () => {
    const p = fakePlayer(); attachVideoPlayerVitals(p, { platform: 'ios', captureErrors: true });
    p.fire('onError', { code: 'unknown/unknown', message: 'blip' });
    p.fire('onStatusChange', 'error');
    expect(native.recordPlayerEvent.mock.calls.filter(([, type]) => type === 'error').map((c) => c[3])).toEqual([
      { message: 'blip', fatal: false, code: 'unknown/unknown' },
      { message: 'player status error', fatal: true },
    ]);
  });

  // ---- Codex round-2, D2 — a stall's own state callbacks must not close its buffer span ----

  // react-native-video 7.0.0-beta.11 on Android reports a stall as
  // `onPlaybackStateChange({isPlaying:false, isBuffering:true})`, then `onBuffer(true)`,
  // then the SAME state event again. The adapter's unconditional `paused()` closed the
  // just-opened buffer span with `durationMs: 0`, so every rebuffer was reported as
  // instantaneous — and, having emitted a `pause`, it also cut the play span short.
  it('a buffering state callback opens the rebuffer span instead of closing it', () => {
    let now = BASE; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const p = fakePlayer(); attachVideoPlayerVitals(p, { platform: 'android' });
    p.fire('onLoadStart', { sourceType: 'network', source: { uri: 'a' } });
    p.fire('onPlaybackStateChange', { isPlaying: true, isBuffering: false });
    now = BASE + 300; p.fire('onPlaybackStateChange', { isPlaying: false, isBuffering: true });
    p.fire('onBuffer', true);
    now = BASE + 310; p.fire('onPlaybackStateChange', { isPlaying: false, isBuffering: true });
    now = BASE + 900; p.fire('onBuffer', false);
    const got = native.recordPlayerEvent.mock.calls.map(([, type, t, data]) => ({ type, ...(data ? { data } : {}), t: t - BASE }));
    expect(got).toEqual([
      { type: 'source_change', data: { src: 'a' }, t: 0 },
      { type: 'startup', data: { ttffMs: 0 }, t: 0 },
      { type: 'play', t: 0 },
      { type: 'buffer_start', t: 300 },
      { type: 'buffer_end', data: { durationMs: 600 }, t: 900 },
    ]);
  });

  it('a non-playing, non-buffering state is still a pause', () => {
    let now = BASE; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const p = fakePlayer(); attachVideoPlayerVitals(p, { platform: 'android' });
    p.fire('onLoadStart', { sourceType: 'network', source: { uri: 'a' } });
    p.fire('onPlaybackStateChange', { isPlaying: true, isBuffering: false });
    now = BASE + 500; p.fire('onPlaybackStateChange', { isPlaying: false, isBuffering: false });
    expect(native.recordPlayerEvent.mock.calls.map((c) => c[1])).toEqual(['source_change', 'startup', 'play', 'pause']);
  });

  // ---- Codex round-2, D3 — the iOS resolution reaches `stats` ----

  // `onBandwidthUpdate` carries `width`/`height` on ANDROID only, so on iOS the resolution
  // exists solely in `onLoad`. Nesting the dimensions inside the bitrate check meant an iOS
  // session reported a resolution in `quality_change` and never once in `stats`.
  it('iOS stats carry the onLoad resolution, and a dimensionless bandwidth update keeps it', () => {
    let now = BASE; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const p = fakePlayer(); attachVideoPlayerVitals(p, { platform: 'ios' });
    p.fire('onLoadStart', { sourceType: 'network', source: { uri: 'a' } });
    p.fire('onLoad', { width: 1280, height: 720 });
    p.fire('onProgress', { currentTime: 0.5, bufferDuration: 8.5 });
    now = BASE + 1000; p.fire('onBandwidthUpdate', { bitrate: 3e6 });
    p.fire('onProgress', { currentTime: 1, bufferDuration: 9 });
    expect(native.updatePlayerStats.mock.calls.map(([, s]) => s)).toEqual([
      { bufferAheadMs: 8000, width: 1280, height: 720 },
      { bufferAheadMs: 8000, bitrate: 3e6, width: 1280, height: 720 },
    ]);
  });

  // ---- Codex round-8, J2 — attaching mid-rebuffer must not lose the stall ----

  // A player 30 s into a source that is stalled at the moment we attach reports
  // `isPlaying: false`, so the old seed left the translator's startup gate armed and every
  // buffering callback was discarded until the next `playing` — i.e. the stall we attached
  // during, and any that followed it, went unreported.
  it('attaching to a paused-but-past-startup player seeds started without faking a startup', () => {
    let now = BASE; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const p = fakePlayer({ isPlaying: false, currentTime: 30, source: { uri: 'https://c/x.m3u8' } });
    attachVideoPlayerVitals(p, { platform: 'ios' });
    expect(native.recordPlayerEvent.mock.calls.map((c) => c[1])).toEqual(['source_change']);  // no startup, no play
    p.fire('onBuffer', true);
    now = BASE + 500; p.fire('onBuffer', false);
    const got = native.recordPlayerEvent.mock.calls.map(([, type, t, data]) => ({ type, ...(data ? { data } : {}), t: t - BASE }));
    expect(got).toEqual([
      { type: 'source_change', data: { src: 'https://c/x.m3u8' }, t: 0 },
      { type: 'buffer_start', t: 0 },
      { type: 'buffer_end', data: { durationMs: 500 }, t: 500 },
    ]);
  });

  // The mirror image: a source that has NOT produced a frame yet keeps the round-4 F2
  // startup gate, so its first buffering is startup and emits no span.
  it('a loading player at position 0 keeps the startup gate', () => {
    let now = BASE; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const p = fakePlayer({ isPlaying: false, currentTime: 0, status: 'loading', source: { uri: 'a' } });
    attachVideoPlayerVitals(p, { platform: 'ios' });
    p.fire('onBuffer', true); now = BASE + 500; p.fire('onBuffer', false);
    expect(native.recordPlayerEvent.mock.calls.map((c) => c[1])).toEqual(['source_change']);
  });

  it('a readyToPlay player parked at 0 is past startup', () => {
    const p = fakePlayer({ isPlaying: false, currentTime: 0, status: 'readyToPlay', source: { uri: 'a' } });
    attachVideoPlayerVitals(p, { platform: 'ios' });
    p.fire('onBuffer', true);
    expect(native.recordPlayerEvent.mock.calls.map((c) => c[1])).toEqual(['source_change', 'buffer_start']);
  });

  // ---- Codex round-8, J4 — one fatal error per episode, in EITHER callback order ----

  it('a fatal onError after onStatusChange("error") is not reported twice', () => {
    const p = fakePlayer(); attachVideoPlayerVitals(p, { platform: 'ios', captureErrors: true });
    p.fire('onStatusChange', 'error');
    p.fire('onError', { code: 'source/invalid-uri', message: 'bad uri' });
    expect(native.recordPlayerEvent.mock.calls.filter(([, type]) => type === 'error').map((c) => c[3])).toEqual([
      { message: 'player status error', fatal: true },
    ]);
  });

  it('an onStatusChange("error") after a fatal onError is not reported twice', () => {
    const p = fakePlayer(); attachVideoPlayerVitals(p, { platform: 'ios', captureErrors: true });
    p.fire('onError', { code: 'source/invalid-uri', message: 'bad uri' });
    p.fire('onStatusChange', 'error');
    expect(native.recordPlayerEvent.mock.calls.filter(([, type]) => type === 'error').map((c) => c[3])).toEqual([
      { message: 'bad uri', fatal: true, code: 'source/invalid-uri' },
    ]);
  });

  it('a new load cycle clears the episode latch', () => {
    const p = fakePlayer(); attachVideoPlayerVitals(p, { platform: 'ios', captureErrors: true });
    p.fire('onStatusChange', 'error');
    p.fire('onLoadStart', { sourceType: 'network', source: { uri: 'b' } });
    p.fire('onStatusChange', 'error');
    expect(native.recordPlayerEvent.mock.calls.filter(([, type]) => type === 'error')).toHaveLength(2);
  });

  it('useVideoPlayerVitals attaches per player instance and detaches on unmount/change', () => {
    const a = fakePlayer(); const b = fakePlayer();
    function C({ p }: { p: VideoPlayerLike }) { useVideoPlayerVitals(p, { name: 'n' }); return null; }
    const { rerender, unmount } = render(<C p={a} />);
    expect(native.trackPlayer).toHaveBeenCalledTimes(1); expect(a.count()).toBeGreaterThan(0);
    rerender(<C p={b} />);
    expect(native.detachPlayer).toHaveBeenCalledWith('rp1'); expect(a.count()).toBe(0); expect(native.trackPlayer).toHaveBeenCalledTimes(2);
    expect(native.trackPlayer).toHaveBeenLastCalledWith('rp2', 'react-native-video', 'n', undefined);
    unmount(); expect(native.detachPlayer).toHaveBeenCalledWith('rp2');
  });

  /** A null player must not mint a registration the session would then report with no events. */
  it('useVideoPlayerVitals registers nothing while the player is null', () => {
    function C({ p }: { p: VideoPlayerLike | null }) { useVideoPlayerVitals(p, { name: 'n' }); return null; }
    const { rerender } = render(<C p={null} />);
    expect(native.trackPlayer).not.toHaveBeenCalled();
    rerender(<C p={fakePlayer()} />);
    expect(native.trackPlayer).toHaveBeenCalledTimes(1);
  });
});
