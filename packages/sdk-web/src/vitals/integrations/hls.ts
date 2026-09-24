// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// hls.js integration (spec 2026-09-02 §2). Duck-typed: we never import
// hls.js, so there is no peer dependency and no version coupling beyond the
// event-name strings below (stable since hls.js 1.0: `Hls.Events.X` are the
// literal 'hlsX' strings). Timings use ctx.now() rather than hls.js `stats`
// so they survive shape changes between minor versions.
import type { PlayerIntegration, PlayerIntegrationContext, PlayerSnapshot, PlayerStartupTimings } from '@everframe/sdk-core';
import { safeWrap } from '@everframe/sdk-core';

export const HLS_EVENTS = {
  MANIFEST_LOADING: 'hlsManifestLoading',
  MANIFEST_LOADED: 'hlsManifestLoaded',
  LEVEL_LOADED: 'hlsLevelLoaded',
  LEVEL_SWITCHED: 'hlsLevelSwitched',
  FRAG_LOADED: 'hlsFragLoaded',
  KEY_LOADED: 'hlsKeyLoaded',
  ERROR: 'hlsError',
} as const;

type Handler = (event: string, data: unknown) => void;

interface HlsLevel { bitrate?: number; width?: number; height?: number }
interface HlsLike {
  on?(event: string, handler: Handler): void;
  off?(event: string, handler: Handler): void;
  levels?: HlsLevel[];
  currentLevel?: number;
  bandwidthEstimate?: number;
  autoLevelEnabled?: boolean;
  url?: string | null;
  config?: { emeEnabled?: boolean; drmSystems?: Record<string, unknown>; widevineLicenseUrl?: string };
  constructor?: { version?: unknown };
}

function finite(n: unknown): n is number { return typeof n === 'number' && Number.isFinite(n); }
function rec(v: unknown): Record<string, unknown> { return (v && typeof v === 'object' ? v : {}) as Record<string, unknown>; }

export function hlsIntegration(instance: unknown): PlayerIntegration {
  const hls = (instance ?? {}) as HlsLike;
  const rawVersion = hls.constructor?.version;
  const version = typeof rawVersion === 'string' ? rawVersion : undefined;
  let handlers: Array<[string, Handler]> = [];
  let loadingT: number | undefined;
  let manifestMs: number | undefined;
  let firstFragmentMs: number | undefined;
  let sourceEmitted = false;
  let drmEmitted = false;
  /**
   * Fix wave item 4 — the `drm: 'none'` fallback's OWN once-per-load latch,
   * separate from `drmEmitted`. Emitting `'none'` for an unprotected-looking
   * config must not set `drmEmitted`: a real `#EXT-X-KEY` the static config
   * couldn't predict (e.g. AES-128, which needs no `drmSystems` entry at
   * all) still has to fire its own `drm` event later in this same load, and
   * the admin's `derivePlayers` takes the LAST `drm` entry per player, so
   * the real one correctly supersedes this tentative fallback. This latch
   * only prevents the FALLBACK ITSELF from firing twice for one load.
   */
  let noneEmitted = false;

  function levelDims(level: HlsLevel | undefined): Record<string, number> {
    const out: Record<string, number> = {};
    if (finite(level?.bitrate)) out.bitrate = level.bitrate;
    if (finite(level?.width)) out.width = level.width;
    if (finite(level?.height)) out.height = level.height;
    return out;
  }

  return {
    library: 'hls.js',
    ...(version ? { version } : {}),

    attach(ctx: PlayerIntegrationContext): boolean | void {
      // Fix wave item 5 — signal (not throw) that this instance doesn't
      // look like hls.js at all, so the adapter can degrade to native
      // instead of leaving the player labelled 'hls.js' but permanently
      // silent.
      if (typeof hls.on !== 'function' || typeof hls.off !== 'function') return false;
      // Item 1 (codex round 1) — every handler we hand to hls.js is invoked
      // FROM hls.js's own event dispatch, not from our call stack. Handler
      // bodies read foreign properties (hls.levels, hls.autoLevelEnabled,
      // hls.url, …) before control ever reaches the safe-wrapped ctx.emit,
      // so a duck-typed instance whose getter throws would otherwise throw
      // straight through hls.js's dispatch loop and into the host page.
      // Wrap each handler individually — the same safeWrap used everywhere
      // else a foreign call boundary exists — so a throw here is caught,
      // logged, and never escapes into the library.
      const on = (name: string, fn: Handler) => {
        const wrapped = safeWrap(fn, { name: `vitals.hls.${name}` }) as Handler;
        hls.on!(name, wrapped);
        handlers.push([name, wrapped]);
      };
      const emitDrmFromConfig = () => {
        if (drmEmitted) return;
        const cfg = hls.config ?? {};
        const systems = cfg.drmSystems ? Object.keys(cfg.drmSystems) : [];
        const keySystem = systems[0] ?? (cfg.widevineLicenseUrl ? 'com.widevine.alpha' : undefined);
        if (!keySystem || cfg.emeEnabled === false) {
          // Fix wave item 4 — align with Shaka, which always emits `drm`
          // and falls back to `keySystem: 'none'` for unprotected content.
          // hls.js has no synchronous "is this encrypted" query the way
          // Shaka's drmInfo()/keySystem() do, so this is a TENTATIVE
          // fallback based on static config only — see `noneEmitted`'s own
          // comment for why it deliberately does NOT set `drmEmitted`.
          if (!noneEmitted) {
            noneEmitted = true;
            ctx.emit('drm', { keySystem: 'none' });
          }
          return;
        }
        drmEmitted = true;
        ctx.emit('drm', { keySystem });
      };

      on(HLS_EVENTS.MANIFEST_LOADING, () => {
        loadingT = ctx.now();
        manifestMs = undefined;
        firstFragmentMs = undefined;
        sourceEmitted = false;
        // A reused hls.js instance can load a different asset with
        // different protection (e.g. a channel change from a protected to
        // a clear stream) — DRM describes the CURRENT source, not the
        // attached lifetime, so the once-per-load latch must reset here
        // too (cross-task fix landed alongside shaka.ts's identical reset;
        // see task-6-report.md).
        drmEmitted = false;
        // Fix wave item 4 — the 'none' fallback's own latch resets with the
        // real one on every fresh load, for the same reason.
        noneEmitted = false;
      });
      on(HLS_EVENTS.MANIFEST_LOADED, () => {
        if (loadingT !== undefined && manifestMs === undefined) manifestMs = Math.max(0, ctx.now() - loadingT);
        emitDrmFromConfig();
      });
      on(HLS_EVENTS.LEVEL_LOADED, (_e, data) => {
        if (sourceEmitted) return;
        sourceEmitted = true;
        const details = rec(rec(data).details);
        ctx.emit('source_change', { src: hls.url ?? '', protocol: 'hls', live: details.live === true });
      });
      on(HLS_EVENTS.LEVEL_SWITCHED, (_e, data) => {
        const idx = rec(data).level;
        if (!finite(idx)) return;
        const level = hls.levels?.[idx];
        const dims = levelDims(level);
        if (!('bitrate' in dims)) return;
        ctx.emit('bitrate_change', { ...dims, level: idx, reason: hls.autoLevelEnabled === false ? 'manual' : 'abr' });
      });
      on(HLS_EVENTS.FRAG_LOADED, () => {
        if (firstFragmentMs === undefined && loadingT !== undefined) firstFragmentMs = Math.max(0, ctx.now() - loadingT);
      });
      on(HLS_EVENTS.KEY_LOADED, (_e, data) => {
        if (drmEmitted) return;
        drmEmitted = true;
        const d = rec(data);
        const method = rec(rec(rec(d.keyInfo).decryptdata)).method ?? rec(rec(rec(d.frag).decryptdata)).method;
        ctx.emit('drm', { keySystem: typeof method === 'string' ? method.toLowerCase() : 'aes-128' });
      });
      on(HLS_EVENTS.ERROR, (_e, data) => {
        const d = rec(data);
        const detail = typeof d.reason === 'string' ? d.reason : typeof rec(d.error).message === 'string' ? (rec(d.error).message as string) : undefined;
        ctx.emit('error', {
          message: typeof d.details === 'string' ? d.details : 'hls error',
          ...(typeof d.type === 'string' ? { code: d.type } : {}),
          fatal: d.fatal === true,
          ...(detail ? { detail } : {}),
        });
      });

      // Late attach: the manifest is already in — describe the source now.
      if (Array.isArray(hls.levels) && hls.levels.length > 0 && hls.url) {
        sourceEmitted = true;
        ctx.emit('source_change', { src: hls.url, protocol: 'hls' });
      }
    },

    snapshot(): PlayerSnapshot {
      const out: PlayerSnapshot = {};
      const idx = hls.currentLevel;
      if (finite(idx) && idx >= 0) Object.assign(out, levelDims(hls.levels?.[idx]));
      if (finite(hls.bandwidthEstimate)) out.bandwidthEstimate = hls.bandwidthEstimate;
      return out;
    },

    startupTimings(): PlayerStartupTimings {
      return {
        ...(manifestMs !== undefined ? { manifestMs } : {}),
        ...(firstFragmentMs !== undefined ? { firstFragmentMs } : {}),
      };
    },

    detach(): void {
      for (const [name, fn] of handlers) { try { hls.off?.(name, fn); } catch { /* ignore */ } }
      handlers = [];
    },
  };
}
