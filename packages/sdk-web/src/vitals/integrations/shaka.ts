// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Shaka Player integration (spec 2026-09-02 §2). Duck-typed: we never import
// shaka-player as a value OR a type, so there is no peer dependency and no
// version coupling beyond the documented method and event names below. This
// is what lets a customer on any Shaka 4.x pass us their player instance.
//
// Timings prefer ctx.now() deltas across the library's own events, with
// getStats() as the fallback only when the corresponding event was missed
// (e.g. attach() ran mid-load) — event names are more stable across Shaka
// versions than the stats object's shape.
//
// Differs from the hls.js integration (its worked-example sibling) in two
// ways forced by Shaka's own API shape:
//   - Shaka's addEventListener handlers receive a single event object, not
//     (name, data) — so handler signatures here take one argument.
//   - Shaka exposes DRM/variant/manifest state as queryable methods
//     (getVariantTracks(), drmInfo(), getStats()) rather than putting it on
//     event payloads, so several handlers re-query the player instead of
//     reading the event.
import type { PlayerIntegration, PlayerIntegrationContext, PlayerSnapshot, PlayerStartupTimings } from '@everframe/sdk-core';
import { safeWrap } from '@everframe/sdk-core';

export const SHAKA_EVENTS = {
  LOADING: 'loading',
  MANIFEST_PARSED: 'manifestparsed',
  LOADED: 'loaded',
  ADAPTATION: 'adaptation',
  VARIANT_CHANGED: 'variantchanged',
  DRM_SESSION_UPDATE: 'drmsessionupdate',
  ERROR: 'error',
} as const;

type Handler = (event?: unknown) => void;

interface VariantTrack { active?: boolean; bandwidth?: number; width?: number; height?: number }
interface ShakaLike {
  addEventListener?(event: string, handler: Handler): void;
  removeEventListener?(event: string, handler: Handler): void;
  getAssetUri?(): string | null | undefined;
  getManifestType?(): unknown;
  isLive?(): boolean;
  getVariantTracks?(): VariantTrack[];
  getStats?(): unknown;
  drmInfo?(): { keySystem?: string } | null;
  keySystem?(): string;
  constructor?: { version?: unknown };
}

function finite(n: unknown): n is number { return typeof n === 'number' && Number.isFinite(n); }
function rec(v: unknown): Record<string, unknown> { return (v && typeof v === 'object' ? v : {}) as Record<string, unknown>; }

export function shakaIntegration(instance: unknown): PlayerIntegration {
  const player = (instance ?? {}) as ShakaLike;
  const rawVersion = player.constructor?.version;
  const version = typeof rawVersion === 'string' ? rawVersion : undefined;
  let handlers: Array<[string, Handler]> = [];
  let loadingT: number | undefined;
  let manifestMs: number | undefined;
  let firstFragmentMs: number | undefined;
  let lastLicenseMs: number | undefined;
  let drmEmitted = false;
  let sourceEmitted = false;

  function activeVariant(): Record<string, number> {
    let tracks: unknown;
    try { tracks = player.getVariantTracks?.(); } catch { return {}; }
    const t = Array.isArray(tracks) ? tracks.find((x) => rec(x).active === true) : undefined;
    const v = rec(t);
    const out: Record<string, number> = {};
    if (finite(v.bandwidth)) out.bitrate = v.bandwidth;
    if (finite(v.width)) out.width = v.width;
    if (finite(v.height)) out.height = v.height;
    return out;
  }

  function stats(): Record<string, unknown> {
    try { return rec(player.getStats?.()); } catch { return {}; }
  }

  /**
   * Codex round-2 item 8 — an instance with no `getManifestType` at all (an
   * older/minimal duck-typed Shaka 4.x shape) has no way to ANSWER the
   * protocol question, which is different from asking and getting "I don't
   * know" (a present method returning something other than HLS/DASH, still
   * `'unknown'` below — that IS Shaka's own explicit answer). Returning
   * `undefined` rather than asserting `'unknown'` for the absent-method case
   * lets the adapter's own URL-based inference
   * (`player-adapter.ts`'s `sanitizeSource` fallback) have a shot at a
   * perfectly inferable `.mpd`/`.m3u8` asset URI instead of an explicit
   * `'unknown'` overriding it outright — coupling the claimed "any Shaka
   * 4.x" support to one method is exactly what this fixes.
   */
  function protocolOf(): 'hls' | 'dash' | 'unknown' | undefined {
    if (typeof player.getManifestType !== 'function') return undefined;
    let t: unknown;
    try { t = player.getManifestType(); } catch { t = undefined; }
    return t === 'HLS' ? 'hls' : t === 'DASH' ? 'dash' : 'unknown';
  }

  function currentSource(): Record<string, unknown> {
    let src: unknown;
    try { src = player.getAssetUri?.(); } catch { src = undefined; }
    let live: unknown;
    try { live = player.isLive?.(); } catch { live = undefined; }
    const protocol = protocolOf();
    return {
      src: typeof src === 'string' ? src : '',
      ...(protocol !== undefined ? { protocol } : {}),
      live: live === true,
    };
  }

  function emitDrm(ctx: PlayerIntegrationContext): void {
    if (drmEmitted) return;
    drmEmitted = true;
    // drmInfo() and keySystem() are two independent, separately-throwing
    // duck-typed calls — a throw from one must not suppress the fallback to
    // the other, or a real fallback path silently degrades to 'none'.
    let ks: unknown;
    try { ks = rec(player.drmInfo?.()).keySystem; } catch { ks = undefined; }
    if (ks === undefined) {
      try { ks = player.keySystem?.(); } catch { ks = undefined; }
    }
    const keySystem = typeof ks === 'string' && ks !== '' ? ks : 'none';
    const lt = stats().licenseTime;
    const licenseMs = finite(lt) && lt > 0 ? Math.round(lt * 1000) : undefined;
    lastLicenseMs = licenseMs;
    ctx.emit('drm', { keySystem, ...(licenseMs !== undefined ? { licenseMs } : {}) });
  }

  return {
    library: 'shaka',
    ...(version ? { version } : {}),

    attach(ctx: PlayerIntegrationContext): boolean | void {
      // Fix wave item 5 — signal (not throw) that this instance doesn't
      // look like a Shaka player at all, so the adapter can degrade to
      // native instead of leaving the player labelled 'shaka' but
      // permanently silent.
      if (typeof player.addEventListener !== 'function' || typeof player.removeEventListener !== 'function') return false;
      // Item 1 (codex round 1) — same reasoning as hls.ts: these handlers
      // run from Shaka's own event dispatch and read foreign methods
      // (getVariantTracks(), drmInfo(), getStats(), …) before reaching the
      // safe-wrapped ctx.emit. Wrap each handler individually so a throwing
      // duck-typed instance cannot throw through Shaka's dispatch loop.
      const on = (name: string, fn: Handler) => {
        const wrapped = safeWrap(fn, { name: `vitals.shaka.${name}` }) as Handler;
        player.addEventListener!(name, wrapped);
        handlers.push([name, wrapped]);
      };

      on(SHAKA_EVENTS.LOADING, () => {
        loadingT = ctx.now();
        manifestMs = undefined;
        firstFragmentMs = undefined;
        sourceEmitted = false;
        // A Shaka instance is routinely reused across load() calls (channel
        // change, playlist advance). DRM is a property of the CURRENT
        // source, not the attached lifetime, so both the once-per-load latch
        // and its cached licenseMs must reset here — otherwise a clear asset
        // loaded after a protected one keeps reporting the old key system,
        // and a later asset with no license step still reports the
        // previous asset's licenseMs.
        drmEmitted = false;
        lastLicenseMs = undefined;
      });
      on(SHAKA_EVENTS.MANIFEST_PARSED, () => {
        if (manifestMs === undefined) {
          manifestMs = loadingT !== undefined
            ? Math.max(0, ctx.now() - loadingT)
            : (() => { const s = stats().manifestTimeSeconds; return finite(s) ? Math.round(s * 1000) : undefined; })();
        }
        if (sourceEmitted) return; // late-attach already described this load's source
        sourceEmitted = true;
        ctx.emit('source_change', currentSource());
      });
      on(SHAKA_EVENTS.LOADED, () => {
        if (firstFragmentMs === undefined && loadingT !== undefined) firstFragmentMs = Math.max(0, ctx.now() - loadingT);
        emitDrm(ctx);
      });
      on(SHAKA_EVENTS.DRM_SESSION_UPDATE, () => { emitDrm(ctx); });
      on(SHAKA_EVENTS.ADAPTATION, () => {
        const dims = activeVariant();
        if (!('bitrate' in dims)) return;
        ctx.emit('bitrate_change', { ...dims, reason: 'abr' });
      });
      on(SHAKA_EVENTS.VARIANT_CHANGED, () => {
        const dims = activeVariant();
        if (!('bitrate' in dims)) return;
        ctx.emit('bitrate_change', { ...dims, reason: 'manual' });
      });
      on(SHAKA_EVENTS.ERROR, (event) => {
        const d = rec(rec(event).detail);
        const code = d.code;
        const category = d.category;
        ctx.emit('error', {
          message: typeof d.message === 'string' ? d.message : `shaka error ${finite(code) ? code : String(code)}`,
          ...(finite(code) ? { code } : {}),
          fatal: d.severity === 2,
          ...(finite(category) ? { detail: `category ${category}` } : {}),
        });
      });

      // Late attach: Task 7 allows trackPlayer() to attach well after load()
      // already resolved, and no further manifestparsed will fire for a
      // load that is already in the past — so describe the current source
      // immediately, and latch it so a manifestparsed racing right behind
      // attach() cannot double-fire it for the same load.
      let uri: unknown;
      try { uri = player.getAssetUri?.(); } catch { uri = undefined; }
      if (typeof uri === 'string' && uri !== '') {
        sourceEmitted = true;
        ctx.emit('source_change', currentSource());
      }
    },

    snapshot(): PlayerSnapshot {
      const out: PlayerSnapshot = { ...activeVariant() };
      const bw = stats().estimatedBandwidth;
      if (finite(bw)) out.bandwidthEstimate = bw;
      return out;
    },

    startupTimings(): PlayerStartupTimings {
      return {
        ...(manifestMs !== undefined ? { manifestMs } : {}),
        ...(firstFragmentMs !== undefined ? { firstFragmentMs } : {}),
        ...(lastLicenseMs !== undefined ? { licenseMs: lastLicenseMs } : {}),
      };
    },

    detach(): void {
      for (const [name, fn] of handlers) { try { player.removeEventListener?.(name, fn); } catch { /* ignore */ } }
      handlers = [];
    },
  };
}
