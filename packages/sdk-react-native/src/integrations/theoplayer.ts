// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Session Vitals adapter for react-native-theoplayer (spec 2026-09-06 §3).
// Structural types only — the library is NOT imported. Event names verified
// against src/api/player/PlayerEventMap.ts + src/api/event/*.ts (develop):
//   sourcechange / loadstart / playing / pause / ended / waiting / seeking /
//   seeked / ratechange{playbackRate} / error{error:{errorCode,errorMessage}} /
//   contentprotectionerror{error} / progress / timeupdate{currentTime} /
//   mediatrack{subType:'activequalitychanged', trackType, qualities:Quality|Quality[]} /
//   destroy.  Quality{bandwidth,width,height}; player.version.version;
//   player.buffered: TimeRange[]; SourceDescription.sources: TypedSource|TypedSource[];
//   TypedSource.contentProtection keys: widevine | fairplay | playready | clearkey.
import { useEffect } from 'react';
import { trackPlayer, type TrackPlayerOptions } from '../vitals.js';
import { createPlayerTranslator } from './player-translator.js';

export interface TheoTypedSource { src?: string; type?: string; contentProtection?: Record<string, unknown> }
export interface TheoPlayerLike {
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
  readonly source?: { sources?: TheoTypedSource | TheoTypedSource[] } | undefined;
  readonly buffered?: Array<{ start: number; end: number }>;
  readonly currentTime?: number;
  readonly paused?: boolean;
  readonly version?: { version?: string };
  readonly videoTracks?: Array<{ uid: number; activeQuality?: { bandwidth?: number; width?: number; height?: number } }>;
}
export interface TheoPlayerVitalsOptions {
  name?: string;
}

const LIBRARY = 'theoplayer';
const KEY_SYSTEMS = ['widevine', 'fairplay', 'playready', 'clearkey'] as const;

function firstSource(desc: TheoPlayerLike['source']): TheoTypedSource | undefined {
  const s = desc?.sources;
  return Array.isArray(s) ? s[0] : s;
}
function keySystemOf(src: TheoTypedSource | undefined): string | undefined {
  const cp = src?.contentProtection;
  if (!cp) return undefined;
  return KEY_SYSTEMS.find((k) => k in cp) ?? (typeof cp.integration === 'string' ? cp.integration : 'unknown');
}
function bufferAheadMs(player: TheoPlayerLike): number | undefined {
  const t = player.currentTime; const ranges = player.buffered;
  if (typeof t !== 'number' || !Array.isArray(ranges)) return undefined;
  const r = ranges.find((x) => x.start <= t && t <= x.end);
  return r ? Math.round(Math.max(0, (r.end - t) * 1000)) : 0;
}

export function attachTheoPlayerVitals(player: TheoPlayerLike, opts: TheoPlayerVitalsOptions = {}): () => void {
  // `exactOptionalPropertyTypes` forbids `{ libraryVersion: undefined }`
  // against an optional field, so build field-by-field (see ./react-native-video.ts).
  const trackOpts: TrackPlayerOptions = { library: LIBRARY };
  const libraryVersion = player.version?.version;
  if (libraryVersion !== undefined) trackOpts.libraryVersion = libraryVersion;
  if (opts.name !== undefined) trackOpts.name = opts.name;
  const tr = createPlayerTranslator(trackPlayer(trackOpts));
  const subs: Array<[string, (e: any) => void]> = [];
  const on = (type: string, l: (e: any) => void) => { const w = tr.wrap(l); subs.push([type, w]); player.addEventListener(type, w); };
  let bitrate: number | undefined; let width: number | undefined; let height: number | undefined;
  // Consumable latch, NOT a "last armed URL". THEOplayer fires
  // `sourcechange` then `loadstart` for one load, so the second of the pair
  // must be swallowed — but only once. Remembering the URL instead made a
  // genuine reload of the SAME URL (a retry, a live restart) invisible
  // forever, since every later `loadstart` still matched it.
  let pendingLoadstart = false;

  const push = () => {
    const b = bufferAheadMs(player); if (b === undefined) return;
    const s: Record<string, number> = { bufferAheadMs: b };
    if (bitrate !== undefined) { s.bitrate = bitrate; if (width !== undefined) s.width = width; if (height !== undefined) s.height = height; }
    tr.stats(s as { bufferAheadMs: number });
  };
  // `exactOptionalPropertyTypes` forbids `{ mime: undefined }` against an
  // optional `mime?: string` field, so build the extra object field-by-field
  // (mirrors `drmExtra` in ./react-native-video.ts).
  const readSource = (): { src: string | undefined; extra: { mime?: string; keySystem?: string } } => {
    const s = firstSource(player.source);
    const mime = s?.type; const keySystem = keySystemOf(s);
    const extra: { mime?: string; keySystem?: string } = {};
    if (mime !== undefined) extra.mime = mime;
    if (keySystem !== undefined) extra.keySystem = keySystem;
    return { src: s?.src, extra };
  };
  // The cached rendition figures belong to the OLD source; carrying them past
  // a load would attach them to the new source's stats pushes.
  const load = () => {
    bitrate = undefined; width = undefined; height = undefined;
    const { src, extra } = readSource();
    tr.loadStart(src, extra);
  };
  const quality = (q: { bandwidth?: number; width?: number; height?: number } | undefined) => {
    if (!q) return;
    if (typeof q.bandwidth === 'number') { bitrate = q.bandwidth; width = q.width; height = q.height; tr.bitrateChanged(q.bandwidth, q.width, q.height); }
    if (q.width && q.height) tr.sizeChanged(q.width, q.height);
  };

  let done = false;
  const detach = () => {
    if (done) return; done = true;
    subs.forEach(([t, l]) => { try { player.removeEventListener(t, l); } catch { /* destroyed */ } });
    tr.close();
  };

  // Codex round-8, J3 — the subscription loop AND the seed reads run under ONE try/catch,
  // exactly as in ./react-native-video.ts. A THEOplayer instance destroyed between the
  // caller's null check and this line throws from `addEventListener` (and from the `source`
  // / `paused` / `videoTracks` getters); without a rollback the attach left half its
  // listeners installed on a dead player and — worse — a registration the native side
  // reports as a live player that never emits another event. On any throw: remove whatever
  // was installed, `tr.close()` (which detaches the native token), and hand the host an
  // inert detach so unmount is still a safe no-op.
  try {
    on('sourcechange', () => { pendingLoadstart = true; load(); });
    on('loadstart', () => { const paired = pendingLoadstart; pendingLoadstart = false; if (!paired) load(); });
    on('playing', () => { tr.bufferingChanged(false); tr.playing(); });
    on('pause', () => tr.paused());
    on('ended', () => tr.ended());
    on('waiting', () => tr.bufferingChanged(true));
    on('seeked', () => tr.seek());
    on('ratechange', (e) => { if (typeof e?.playbackRate === 'number') tr.rateChanged(e.playbackRate); });
    on('error', (e) => tr.error(String(e?.error?.errorMessage ?? 'error'), e?.error?.errorCode, true));
    on('contentprotectionerror', (e) => tr.error(String(e?.error?.errorMessage ?? 'content protection error'), e?.error?.errorCode, false));
    on('timeupdate', push);
    on('mediatrack', (e) => {
      if (e?.subType !== 'activequalitychanged' || e?.trackType !== 'video') return;
      quality(Array.isArray(e.qualities) ? e.qualities[0] : e.qualities);
    });
    on('destroy', detach);

    // Seed from current state. `seedSource`, not `load()`: the source was
    // loaded before we attached, so arming the startup clock here would report
    // the gap from ATTACH to the next `playing` as this source's startup.
    const seed = readSource();
    if (seed.src) tr.seedSource(seed.src, seed.extra);
    if (player.paused === false) tr.seedPlaying();
    quality(player.videoTracks?.find((t) => t.activeQuality)?.activeQuality);
  } catch {
    detach();            // removes the listeners installed so far and closes the translator
    return () => {};
  }

  return detach;
}

/** Effect-bound form: attaches per player INSTANCE, detaches on unmount or change. */
export function useTheoPlayerVitals(player: TheoPlayerLike | null | undefined, opts: TheoPlayerVitalsOptions = {}): void {
  const { name } = opts;
  useEffect(() => {
    if (!player) return;
    const attachOpts: TheoPlayerVitalsOptions = {};
    if (name !== undefined) attachOpts.name = name;
    return attachTheoPlayerVitals(player, attachOpts);
  }, [player, name]);
}
