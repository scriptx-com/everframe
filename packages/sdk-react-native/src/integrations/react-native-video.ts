// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Session Vitals adapter for react-native-video v7 (spec 2026-09-06 §3).
// Structural types only — react-native-video is NOT imported. Verified
// against packages/react-native-video/src/core/types/Events.ts (master):
//   onLoadStart({ sourceType, source })      onLoad({ width, height, duration, … })
//   onPlaybackStateChange({ isPlaying, isBuffering })   onBuffer(boolean)
//   onProgress({ currentTime, bufferDuration })         onBandwidthUpdate({ bitrate, width?, height? })
//   onPlaybackRateChange(rate)  onSeek(seekTime)  onEnd()  onError(VideoRuntimeError{code,message})
//   onStatusChange('idle'|'loading'|'readyToPlay'|'error')
//
// Released players: `release()` nulls the Nitro player box but NOT the event
// emitter, so `addEventListener` does NOT throw afterwards. The getter that
// throws `VideoRuntimeError('player/released')` is `VideoPlayer.player`, and
// it backs BOTH `get source()` and `get isPlaying()` — and `get currentTime()`
// and `get status()`, i.e. exactly the attach-time seed reads below. They are
// therefore taken first, inside one try/catch, before anything is registered:
// a released player yields a no-op detach with no registration and no
// React-visible throw.
//
// Also verified: `VideoPlayer.throwError` only rethrows synchronously from
// play()/pause()/seekBy()/seekTo()/selectTextTrack()/getAvailableTextTracks()
// when NO `onError` listener is registered. Subscribing to `onError` silently
// swallows those throws for the WHOLE host app, which is why it is opt-in
// (`captureErrors`) and off by default.
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { trackPlayer, type TrackPlayerOptions } from '../vitals.js';
import { createPlayerTranslator } from './player-translator.js';

export interface VideoPlayerLike {
  addEventListener(event: string, cb: (...args: any[]) => void): { remove(): void };
  readonly isPlaying?: boolean;
  readonly source?: { uri?: string; config?: { drm?: { type?: string } } } | null;
  /** Playhead position in seconds; > 0 means this source has already produced frames. */
  readonly currentTime?: number;
  /** `'idle' | 'loading' | 'readyToPlay' | 'error'` — `'readyToPlay'` also means past startup. */
  readonly status?: string;
}
export interface VideoPlayerVitalsOptions {
  name?: string;
  libraryVersion?: string;
  /**
   * Subscribe to `onError` so errors carry the library's `code`. OFF by
   * default: registering an `onError` listener makes react-native-video stop
   * throwing synchronously from `play()`/`pause()`/`seek*()` for the entire
   * host app, which is a behaviour change TraceItX must not make silently.
   * Without it, a fatal error is still reported via `onStatusChange('error')`
   * — just without a `code`.
   */
  captureErrors?: boolean;
  /**
   * TEST-ONLY override for the platform split on `onBandwidthUpdate`
   * (iOS reports the rendition's declared bitrate, Android reports
   * ExoPlayer's bandwidth estimate). Defaults to `Platform.OS`; hosts should
   * never set it.
   * @internal
   */
  platform?: 'ios' | 'android';
}

const LIBRARY = 'react-native-video';

function isFatal(code: unknown): boolean {
  return typeof code === 'string' && (code.startsWith('player/') || code.startsWith('source/'));
}

// `exactOptionalPropertyTypes` forbids `{ keySystem: undefined }` against an
// optional `keySystem?: string` field, so build the extra object field-by-field.
function drmExtra(keySystem: string | undefined): { keySystem?: string } | undefined {
  return keySystem !== undefined ? { keySystem } : undefined;
}

export function attachVideoPlayerVitals(player: VideoPlayerLike, opts: VideoPlayerVitalsOptions = {}): () => void {
  // Seed reads come FIRST (see header): these three getters are the ones that
  // throw 'player/released', and they must not do so from inside React.
  let seedUri: string | undefined;
  let seedKeySystem: string | undefined;
  let seedIsPlaying = false;
  // Codex round-8, J2 — is the source already PAST startup even though it is not playing
  // right now? A positive playhead means frames have been shown; `readyToPlay` is
  // react-native-video saying the same thing for a source parked at 0. Either way the next
  // stall is a rebuffer, and without seeding `started` the translator's startup gate would
  // discard it (and every stall after it) until the next `playing`.
  let seedPastStartup = false;
  try {
    const src = player.source;
    seedUri = src?.uri;
    seedKeySystem = src?.config?.drm?.type;
    seedIsPlaying = !!player.isPlaying;
    const t = player.currentTime;
    seedPastStartup = (typeof t === 'number' && t > 0) || player.status === 'readyToPlay';
  } catch {
    return () => {};
  }

  const subs: Array<{ remove(): void }> = [];
  const on = (event: string, cb: (...a: any[]) => void) => { subs.push(player.addEventListener(event, cb)); };

  const trackOpts: TrackPlayerOptions = { library: LIBRARY };
  if (opts.libraryVersion !== undefined) trackOpts.libraryVersion = opts.libraryVersion;
  if (opts.name !== undefined) trackOpts.name = opts.name;
  const tr = createPlayerTranslator(trackPlayer(trackOpts));
  const platform = opts.platform ?? (Platform.OS === 'android' ? 'android' : 'ios');
  // iOS: `bitrate` is the rendition's declared bitrate (access log
  // `indicatedBitrate`). Android: it is ExoPlayer's `bitrateEstimate`, i.e.
  // available network bandwidth — a different quantity that must never be
  // reported as the stream's bitrate.
  let bitrate: number | undefined; let bandwidthEstimate: number | undefined;
  let width: number | undefined; let height: number | undefined;
  // Codex round-8, J4 — ONE fatal-error episode per source (cleared by `onLoadStart`).
  // react-native-video reports a fatal failure through both `onError` and
  // `onStatusChange('error')`, in EITHER order, and the previous latch was only set by
  // `onError`: a status error arriving first therefore did not stop the `onError` behind it,
  // and the session carried the same failure twice. Both handlers now check it and both set
  // it. NON-fatal captured errors neither check nor set it (round-2 rule): a blip must not
  // suppress a genuine fatal error that arrives later.
  let errorEpisode = false;
  // Every accepted load cycle drops the cached rendition figures: they belong
  // to the OLD source. Without this a stats push for the new source would
  // carry the previous source's bitrate/size, and the iOS bitrate de-dup
  // below would swallow the new source's first `bitrate_change` whenever the
  // two renditions happen to share a bitrate.
  const resetSourceCache = () => { bitrate = undefined; bandwidthEstimate = undefined; width = undefined; height = undefined; };

  // Codex round-2, D3 — the resolution is INDEPENDENT of the rate figure. On iOS
  // `onBandwidthUpdate` carries no `width`/`height` (only Android's does), so nesting the
  // dimensions inside `primary !== undefined` meant an iOS session never reported a
  // resolution in `stats` at all, even though `onLoad` had announced one. `bufferAheadMs`
  // plus the dimensions is a perfectly valid push.
  const push = (bufferAheadMs: number) => {
    const s: Record<string, number> = { bufferAheadMs };
    const primary = platform === 'android' ? bandwidthEstimate : bitrate;
    if (primary !== undefined) {
      if (platform === 'android') s.bandwidthEstimate = primary; else s.bitrate = primary;
    }
    if (width !== undefined) s.width = width;
    if (height !== undefined) s.height = height;
    tr.stats(s as { bufferAheadMs: number });
  };

  try {
    on('onLoadStart', tr.wrap((e: { source?: { uri?: string; config?: { drm?: { type?: string } } } }) => {
      errorEpisode = false; resetSourceCache(); tr.loadStart(e?.source?.uri, drmExtra(e?.source?.config?.drm?.type));
    }));
    // `onLoad` carries the source's declared resolution, and on iOS it is the ONLY event
    // that ever does — `onBandwidthUpdate` reports `width`/`height` on Android only (codex
    // round-2, D3). Caching it here is what puts a resolution on iOS stats pushes at all.
    on('onLoad', tr.wrap((e: { width?: number; height?: number }) => {
      if (e?.width && e?.height) { width = e.width; height = e.height; tr.sizeChanged(e.width, e.height); }
    }));
    // Codex round-2, D2 — `isBuffering` decides whether a non-playing state is a PAUSE.
    // react-native-video 7.0.0-beta.11 on Android reports a stall as
    // `{isPlaying:false, isBuffering:true}`, then `onBuffer(true)`, then the SAME state event
    // again. The unconditional `paused()` here closed the buffer span `onBuffer(true)` had
    // just opened, with `durationMs: 0`, and every real rebuffer was reported as
    // instantaneous. `bufferingChanged` is idempotent, so the repeat is a no-op; the pause is
    // reported only when the player is stopped and NOT stalled.
    on('onPlaybackStateChange', tr.wrap((e: { isPlaying?: boolean; isBuffering?: boolean }) => {
      if (e?.isPlaying) { tr.playing(); return; }
      if (e?.isBuffering) { tr.bufferingChanged(true); return; }
      tr.paused();
    }));
    on('onBuffer', tr.wrap((b: boolean) => tr.bufferingChanged(!!b)));
    // `bufferDuration` is NOT the same quantity on both platforms. iOS
    // (AVPlayerItem+getBufferedDurration.swift) reports the buffered range's
    // ABSOLUTE END position, so the buffer AHEAD of the playhead is
    // `bufferDuration - currentTime`; Android (HybridVideoPlayer.kt) already
    // reports the time buffered ahead. Using the iOS number raw would fold
    // the playhead position into the stat and drift upward all session.
    on('onProgress', tr.wrap((e: { currentTime?: number; bufferDuration?: number }) => {
      if (typeof e?.bufferDuration !== 'number') return;
      const ahead = platform === 'android'
        ? e.bufferDuration
        : e.bufferDuration - (typeof e.currentTime === 'number' ? e.currentTime : 0);
      push(Math.round(Math.max(0, ahead) * 1000));
    }));
    on('onBandwidthUpdate', tr.wrap((e: { bitrate?: number; width?: number; height?: number }) => {
      if (typeof e?.bitrate !== 'number') return;
      // Round-2, D3 — KEEP the cached dimensions when this update omits them. Overwriting
      // with `undefined` erased the resolution `onLoad` established, which on iOS (where
      // this event never carries dimensions) meant every stats push after the first
      // bandwidth update lost the size for good.
      if (e.width !== undefined) width = e.width;
      if (e.height !== undefined) height = e.height;
      if (platform === 'android') {
        bandwidthEstimate = e.bitrate;
        // A bandwidth estimate is not a bitrate change; only the rendition
        // size is real information here (the translator de-dups it).
        if (e.width !== undefined && e.height !== undefined) tr.sizeChanged(e.width, e.height);
        return;
      }
      // Adapter-level de-dup: the access log repeats the same indicated
      // bitrate on every sample and the translator does not de-dup bitrate.
      if (e.bitrate === bitrate) return;
      bitrate = e.bitrate; tr.bitrateChanged(e.bitrate, e.width, e.height);
    }));
    on('onPlaybackRateChange', tr.wrap((rate: number) => tr.rateChanged(rate)));
    on('onSeek', tr.wrap(() => tr.seek()));
    on('onEnd', tr.wrap(() => tr.ended()));
    if (opts.captureErrors) {
      // Only a FATAL captured error consults the episode latch — and a fatal one that finds
      // it already set is dropped, because the generic status error reported the same
      // failure moments earlier. Non-fatal errors are always forwarded (subject to the
      // translator's rolling budget) and never latch.
      on('onError', tr.wrap((err: { code?: string; message?: string }) => {
        const fatal = isFatal(err?.code);
        if (fatal) {
          if (errorEpisode) return;
          errorEpisode = true;
        }
        tr.error(String(err?.message ?? 'error'), err?.code, fatal);
      }));
    }
    on('onStatusChange', tr.wrap((status: string) => {
      if (status !== 'error' || errorEpisode) return;
      errorEpisode = true;
      tr.error('player status error', undefined, true);
    }));
  } catch {
    subs.forEach((s) => { try { s.remove(); } catch { /* released */ } });
    tr.close();
    return () => {};
  }

  // Apply the seed (an already-playing player must open its span now).
  // `seedSource`, not `loadStart`: the load happened before we attached, so
  // arming the startup clock here would report the time from ATTACH to the
  // next `playing` as this source's startup latency.
  if (seedUri) tr.seedSource(seedUri, drmExtra(seedKeySystem));
  // `seedPlaying` already implies started; `seedStarted` is the not-playing-but-past-startup
  // case (round-8, J2) — notably a player that is MID-REBUFFER when we attach. The stall in
  // flight is not fabricated: the next `onBuffer(true)` / buffering state event opens the
  // span normally.
  if (seedIsPlaying) tr.seedPlaying();
  else if (seedPastStartup) tr.seedStarted();

  let done = false;
  return () => {
    if (done) return; done = true;
    subs.forEach((s) => { try { s.remove(); } catch { /* released */ } });
    tr.close();
  };
}

/** Effect-bound form: attaches per player INSTANCE, detaches on unmount or change. */
export function useVideoPlayerVitals(player: VideoPlayerLike | null | undefined, opts: VideoPlayerVitalsOptions = {}): void {
  const { name, libraryVersion, captureErrors, platform } = opts;
  useEffect(() => {
    if (!player) return;
    const attachOpts: VideoPlayerVitalsOptions = {};
    if (name !== undefined) attachOpts.name = name;
    if (libraryVersion !== undefined) attachOpts.libraryVersion = libraryVersion;
    if (captureErrors !== undefined) attachOpts.captureErrors = captureErrors;
    if (platform !== undefined) attachOpts.platform = platform;
    return attachVideoPlayerVitals(player, attachOpts);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `platform` is a TEST-ONLY
    // override that never changes at runtime; keeping it out of the deps stops a host that
    // spreads a fresh options object from re-attaching on every render.
  }, [player, name, libraryVersion, captureErrors]);
}
