// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import type { PlayerIntegrationContext } from '@traceitx/sdk-core';
import { hlsIntegration, HLS_EVENTS } from '../../../src/vitals/integrations/hls.js';

type Emitted = { type: string; data?: Record<string, unknown>; t?: number };

function fakeHls(over: Record<string, unknown> = {}) {
  const handlers = new Map<string, Array<(...a: unknown[]) => void>>();
  const hls = {
    on(name: string, fn: (...a: unknown[]) => void) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
    off(name: string, fn: (...a: unknown[]) => void) { handlers.set(name, (handlers.get(name) ?? []).filter((h) => h !== fn)); },
    fire(name: string, data?: unknown) { for (const h of handlers.get(name) ?? []) h(name, data); },
    handlerCount() { let n = 0; for (const l of handlers.values()) n += l.length; return n; },
    levels: [
      { bitrate: 800_000, width: 640, height: 360 },
      { bitrate: 3_000_000, width: 1920, height: 1080 },
    ],
    currentLevel: 1,
    bandwidthEstimate: 6_500_000,
    autoLevelEnabled: true,
    url: 'https://cdn.example.com/live/main.m3u8?token=1',
    config: {},
    constructor: { version: '1.5.7' },
    ...over,
  };
  return hls;
}

function attach(hls: ReturnType<typeof fakeHls>, clock = { t: 1000 }) {
  const emitted: Emitted[] = [];
  const integ = hlsIntegration(hls);
  const ctx: PlayerIntegrationContext = {
    element: {},
    emit: (type, data, t) => emitted.push(data === undefined ? { type } : t === undefined ? { type, data } : { type, data, t }),
    now: () => clock.t,
  };
  integ.attach(ctx);
  return { integ, emitted, clock };
}

describe('hlsIntegration', () => {
  it('reports library + version', () => {
    const i = hlsIntegration(fakeHls());
    expect(i.library).toBe('hls.js');
    expect(i.version).toBe('1.5.7');
    expect(hlsIntegration(fakeHls({ constructor: {} })).version).toBeUndefined();
  });

  it('emits source_change once on the first level load, with live and the raw url (the adapter sanitises)', () => {
    const hls = fakeHls({ levels: [] });
    const { emitted } = attach(hls);
    hls.fire(HLS_EVENTS.MANIFEST_LOADING);
    hls.fire(HLS_EVENTS.MANIFEST_LOADED, { levels: [] });
    hls.fire(HLS_EVENTS.LEVEL_LOADED, { details: { live: true } });
    hls.fire(HLS_EVENTS.LEVEL_LOADED, { details: { live: true } });
    expect(emitted.filter((e) => e.type === 'source_change')).toEqual([
      { type: 'source_change', data: { src: 'https://cdn.example.com/live/main.m3u8?token=1', protocol: 'hls', live: true } },
    ]);
  });

  it('emits source_change immediately when attached after the manifest already loaded (late attach)', () => {
    const { emitted } = attach(fakeHls());
    expect(emitted[0]).toEqual({ type: 'source_change', data: { src: 'https://cdn.example.com/live/main.m3u8?token=1', protocol: 'hls' } });
  });

  it('measures manifestMs and firstFragmentMs with ctx.now() and exposes them via startupTimings()', () => {
    const hls = fakeHls({ levels: [] });
    const { integ, clock } = attach(hls);
    hls.fire(HLS_EVENTS.MANIFEST_LOADING);
    clock.t = 1080;
    hls.fire(HLS_EVENTS.MANIFEST_LOADED, { levels: [] });
    clock.t = 1300;
    hls.fire(HLS_EVENTS.FRAG_LOADED, {});
    clock.t = 1900;
    hls.fire(HLS_EVENTS.FRAG_LOADED, {}); // second fragment must not move the figure
    expect(integ.startupTimings?.()).toEqual({ manifestMs: 80, firstFragmentMs: 300 });
  });

  it('never emits an entry per fragment', () => {
    const hls = fakeHls();
    const { emitted } = attach(hls);
    for (let i = 0; i < 50; i++) hls.fire(HLS_EVENTS.FRAG_LOADED, {});
    expect(emitted.filter((e) => e.type !== 'source_change')).toEqual([]);
  });

  it('maps hlsLevelSwitched to bitrate_change with dims, level and reason', () => {
    const hls = fakeHls();
    const { emitted } = attach(hls);
    hls.fire(HLS_EVENTS.LEVEL_SWITCHED, { level: 1 });
    hls.autoLevelEnabled = false;
    hls.fire(HLS_EVENTS.LEVEL_SWITCHED, { level: 0 });
    hls.fire(HLS_EVENTS.LEVEL_SWITCHED, { level: 9 }); // unknown level → nothing
    expect(emitted.filter((e) => e.type === 'bitrate_change')).toEqual([
      { type: 'bitrate_change', data: { bitrate: 3_000_000, width: 1920, height: 1080, level: 1, reason: 'abr' } },
      { type: 'bitrate_change', data: { bitrate: 800_000, width: 640, height: 360, level: 0, reason: 'manual' } },
    ]);
  });

  it('emits drm from config.drmSystems at manifest load, once', () => {
    const hls = fakeHls({ levels: [], config: { emeEnabled: true, drmSystems: { 'com.widevine.alpha': { licenseUrl: 'x' } } } });
    const { emitted } = attach(hls);
    hls.fire(HLS_EVENTS.MANIFEST_LOADED, {});
    hls.fire(HLS_EVENTS.MANIFEST_LOADED, {});
    hls.fire(HLS_EVENTS.KEY_LOADED, { keyInfo: { decryptdata: { method: 'AES-128' } } });
    expect(emitted.filter((e) => e.type === 'drm')).toEqual([{ type: 'drm', data: { keySystem: 'com.widevine.alpha' } }]);
  });

  it('re-emits drm after a fresh hlsManifestLoading — a reused instance can switch protection across loads', () => {
    const hls = fakeHls({ levels: [], config: { emeEnabled: true, drmSystems: { 'com.widevine.alpha': { licenseUrl: 'x' } } } });
    const { emitted } = attach(hls);
    hls.fire(HLS_EVENTS.MANIFEST_LOADED, {}); // first load: widevine, from config

    hls.config = {}; // second asset has no DRM in config; detected via KEY_LOADED instead
    hls.fire(HLS_EVENTS.MANIFEST_LOADING); // reused instance starts a new load
    hls.fire(HLS_EVENTS.MANIFEST_LOADED, {});
    // Fix wave item 4 — with no key system in config, MANIFEST_LOADED now
    // ALSO emits the tentative `none` fallback before the real hlsKeyLoaded
    // arrives; the fallback does not pre-empt it (see the dedicated fix
    // wave item 4 spec above) — both land, in order.
    hls.fire(HLS_EVENTS.KEY_LOADED, { keyInfo: { decryptdata: { method: 'AES-128' } } });

    expect(emitted.filter((e) => e.type === 'drm')).toEqual([
      { type: 'drm', data: { keySystem: 'com.widevine.alpha' } },
      { type: 'drm', data: { keySystem: 'none' } },
      { type: 'drm', data: { keySystem: 'aes-128' } },
    ]);
  });

  it('falls back to widevineLicenseUrl, then to the AES-128 key method', () => {
    const a = fakeHls({ levels: [], config: { emeEnabled: true, widevineLicenseUrl: 'https://lic' } });
    const ra = attach(a); a.fire(HLS_EVENTS.MANIFEST_LOADED, {});
    expect(ra.emitted.filter((e) => e.type === 'drm')).toEqual([{ type: 'drm', data: { keySystem: 'com.widevine.alpha' } }]);
    const b = fakeHls({ levels: [] });
    const rb = attach(b); b.fire(HLS_EVENTS.MANIFEST_LOADED, {});
    // Fix wave item 4 — no key system in `b`'s config (it has none at all),
    // so MANIFEST_LOADED emits the tentative `none` fallback first; the
    // real hlsKeyLoaded below still fires and supersedes it (readers take
    // the LAST drm entry).
    b.fire(HLS_EVENTS.KEY_LOADED, { keyInfo: { decryptdata: { method: 'AES-128' } } });
    expect(rb.emitted.filter((e) => e.type === 'drm')).toEqual([
      { type: 'drm', data: { keySystem: 'none' } },
      { type: 'drm', data: { keySystem: 'aes-128' } },
    ]);
  });

  it('maps hlsError to error with code/fatal/detail', () => {
    const hls = fakeHls();
    const { emitted } = attach(hls);
    hls.fire(HLS_EVENTS.ERROR, { type: 'networkError', details: 'fragLoadError', fatal: false, reason: 'timeout' });
    hls.fire(HLS_EVENTS.ERROR, { type: 'mediaError', details: 'bufferStalledError', fatal: true });
    expect(emitted.filter((e) => e.type === 'error')).toEqual([
      { type: 'error', data: { message: 'fragLoadError', code: 'networkError', fatal: false, detail: 'timeout' } },
      { type: 'error', data: { message: 'bufferStalledError', code: 'mediaError', fatal: true } },
    ]);
  });

  it('snapshot() reads the current level and bandwidth estimate; tolerates a missing level', () => {
    const hls = fakeHls();
    const { integ } = attach(hls);
    expect(integ.snapshot?.()).toEqual({ bitrate: 3_000_000, width: 1920, height: 1080, bandwidthEstimate: 6_500_000 });
    hls.currentLevel = -1;
    expect(integ.snapshot?.()).toEqual({ bandwidthEstimate: 6_500_000 });
  });

  it('detach() removes every handler', () => {
    const hls = fakeHls();
    const { integ } = attach(hls);
    expect(hls.handlerCount()).toBeGreaterThan(0);
    integ.detach();
    expect(hls.handlerCount()).toBe(0);
  });

  it('attach() on an object without on/off does nothing, does not throw, and signals failure by returning false', () => {
    let result: boolean | void = undefined;
    expect(() => {
      result = hlsIntegration({}).attach({ element: {}, emit: () => {}, now: () => 0 });
    }).not.toThrow();
    expect(result).toBe(false);
  });

  // Fix wave item 4 — align with Shaka's clear-content fallback: an
  // unprotected manifest (no drmSystems/widevineLicenseUrl configured)
  // still gets a `drm` entry instead of nothing at all.
  it('emits drm { keySystem: "none" } at manifest load when no key system is configured', () => {
    const hls = fakeHls({ levels: [], config: {} });
    const { emitted } = attach(hls);
    hls.fire(HLS_EVENTS.MANIFEST_LOADED, {});
    hls.fire(HLS_EVENTS.MANIFEST_LOADED, {}); // must not double-emit the fallback
    expect(emitted.filter((e) => e.type === 'drm')).toEqual([{ type: 'drm', data: { keySystem: 'none' } }]);
  });

  it('a real hlsKeyLoaded after the "none" fallback still fires — the fallback does not pre-empt it', () => {
    const hls = fakeHls({ levels: [], config: {} }); // no drmSystems/widevineLicenseUrl — config alone can't predict AES-128
    const { emitted } = attach(hls);
    hls.fire(HLS_EVENTS.MANIFEST_LOADED, {}); // emits the tentative 'none' fallback
    hls.fire(HLS_EVENTS.KEY_LOADED, { keyInfo: { decryptdata: { method: 'AES-128' } } }); // the real, later signal
    expect(emitted.filter((e) => e.type === 'drm')).toEqual([
      { type: 'drm', data: { keySystem: 'none' } },
      { type: 'drm', data: { keySystem: 'aes-128' } },
    ]);
  });

  it('re-emits the "none" fallback after a fresh hlsManifestLoading, same as a real drm entry', () => {
    const hls = fakeHls({ levels: [], config: {} });
    const { emitted } = attach(hls);
    hls.fire(HLS_EVENTS.MANIFEST_LOADED, {});
    hls.fire(HLS_EVENTS.MANIFEST_LOADING); // reused instance starts a new load
    hls.fire(HLS_EVENTS.MANIFEST_LOADED, {});
    expect(emitted.filter((e) => e.type === 'drm')).toEqual([
      { type: 'drm', data: { keySystem: 'none' } },
      { type: 'drm', data: { keySystem: 'none' } },
    ]);
  });

  it('does not emit the "none" fallback when a config-declared key system is present', () => {
    const hls = fakeHls({ levels: [], config: { emeEnabled: true, drmSystems: { 'com.widevine.alpha': { licenseUrl: 'x' } } } });
    const { emitted } = attach(hls);
    hls.fire(HLS_EVENTS.MANIFEST_LOADED, {});
    expect(emitted.filter((e) => e.type === 'drm')).toEqual([{ type: 'drm', data: { keySystem: 'com.widevine.alpha' } }]);
  });

  // codex round 1, item 1 — hlsLevelSwitched reads hls.levels/autoLevelEnabled
  // BEFORE reaching the safe-wrapped ctx.emit. A duck-typed instance whose
  // getter throws must not be able to throw through hls.js's own dispatch
  // (`hls.fire` here stands in for that dispatch loop).
  it('a handler whose foreign property getter throws does not escape into hls.js dispatch', () => {
    const hls = fakeHls({ levels: [] });
    const { emitted } = attach(hls);
    Object.defineProperty(hls, 'levels', {
      configurable: true,
      get() { throw new Error('duck-typed instance is broken'); },
    });
    expect(() => hls.fire(HLS_EVENTS.LEVEL_SWITCHED, { level: 0 })).not.toThrow();
    expect(emitted.filter((e) => e.type === 'bitrate_change')).toEqual([]);
  });
});
