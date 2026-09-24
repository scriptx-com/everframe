// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import type { PlayerIntegrationContext } from '@everframe/sdk-core';
import { shakaIntegration, SHAKA_EVENTS } from '../../../src/vitals/integrations/shaka.js';

type Emitted = { type: string; data?: Record<string, unknown>; t?: number };
type VariantTrack = { active?: boolean; bandwidth?: number; width?: number; height?: number };

function fakeShaka(over: Record<string, unknown> = {}) {
  const handlers = new Map<string, Array<(event?: unknown) => void>>();
  const shaka = {
    addEventListener(name: string, fn: (event?: unknown) => void) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    removeEventListener(name: string, fn: (event?: unknown) => void) {
      handlers.set(name, (handlers.get(name) ?? []).filter((h) => h !== fn));
    },
    fire(name: string, event?: unknown) { for (const h of handlers.get(name) ?? []) h(event); },
    handlerCount() { let n = 0; for (const l of handlers.values()) n += l.length; return n; },
    getAssetUri: () => 'https://cdn.example.com/d/manifest.mpd?sig=1',
    getManifestType: () => 'DASH',
    isLive: () => false,
    getVariantTracks: (): VariantTrack[] => [
      { active: false, bandwidth: 800_000, width: 640, height: 360 },
      { active: true, bandwidth: 3_000_000, width: 1920, height: 1080 },
    ],
    getStats: () => ({ estimatedBandwidth: 6_500_000, manifestTimeSeconds: 0.08, licenseTime: 0.12 }),
    drmInfo: (): { keySystem: string } | null => ({ keySystem: 'com.widevine.alpha' }),
    keySystem: () => 'com.widevine.alpha',
    constructor: { version: 'v4.11.0' },
    ...over,
  };
  return shaka;
}

function attach(shaka: ReturnType<typeof fakeShaka>, clock = { t: 1000 }) {
  const emitted: Emitted[] = [];
  const integ = shakaIntegration(shaka);
  const ctx: PlayerIntegrationContext = {
    element: {},
    emit: (type, data, t) => emitted.push(data === undefined ? { type } : t === undefined ? { type, data } : { type, data, t }),
    now: () => clock.t,
  };
  integ.attach(ctx);
  return { integ, emitted, clock };
}

describe('shakaIntegration', () => {
  it('reports library + version', () => {
    const i = shakaIntegration(fakeShaka());
    expect(i.library).toBe('shaka');
    expect(i.version).toBe('v4.11.0');
    expect(shakaIntegration(fakeShaka({ constructor: {} })).version).toBeUndefined();
  });

  it('emits source_change immediately when attached after the manifest already loaded (late attach)', () => {
    const shaka = fakeShaka();
    const { emitted } = attach(shaka);
    expect(emitted[0]).toEqual({
      type: 'source_change',
      data: { src: 'https://cdn.example.com/d/manifest.mpd?sig=1', protocol: 'dash', live: false },
    });
  });

  it('emits source_change on manifestparsed with protocol from getManifestType() and live from isLive()', () => {
    // getAssetUri: () => '' disables the late-attach replay (attach() only
    // fires it for a non-empty URI), so this test isolates the
    // manifestparsed handler's own emit rather than being satisfied by
    // late attach with an identical payload — see task-6-report.md.
    const dash = fakeShaka({ getAssetUri: () => '' });
    const { emitted: dashEmitted } = attach(dash);
    dash.getAssetUri = () => 'https://cdn.example.com/d/manifest.mpd?sig=1';
    dash.fire(SHAKA_EVENTS.MANIFEST_PARSED);
    expect(dashEmitted.filter((e) => e.type === 'source_change')).toEqual([
      { type: 'source_change', data: { src: 'https://cdn.example.com/d/manifest.mpd?sig=1', protocol: 'dash', live: false } },
    ]);

    const hls = fakeShaka({ getAssetUri: () => '', getManifestType: () => 'HLS', isLive: () => true });
    const { emitted: hlsEmitted } = attach(hls);
    hls.getAssetUri = () => 'https://cdn.example.com/d/manifest.mpd?sig=1';
    hls.fire(SHAKA_EVENTS.MANIFEST_PARSED);
    expect(hlsEmitted.filter((e) => e.type === 'source_change')).toEqual([
      { type: 'source_change', data: { src: 'https://cdn.example.com/d/manifest.mpd?sig=1', protocol: 'hls', live: true } },
    ]);

    const other = fakeShaka({ getAssetUri: () => '', getManifestType: () => 'SMOOTH' });
    const { emitted: otherEmitted } = attach(other);
    other.getAssetUri = () => 'https://cdn.example.com/d/manifest.mpd?sig=1';
    other.fire(SHAKA_EVENTS.MANIFEST_PARSED);
    expect(otherEmitted.filter((e) => e.type === 'source_change')).toEqual([
      { type: 'source_change', data: { src: 'https://cdn.example.com/d/manifest.mpd?sig=1', protocol: 'unknown', live: false } },
    ]);
  });

  // Codex round-2 item 8 — an older/minimal duck-typed Shaka 4.x instance
  // with NO `getManifestType` method at all has no way to answer the
  // protocol question — different from a present method answering "I don't
  // know" (`'SMOOTH'` above, still legitimately `'unknown'`). Before this
  // fix, the ABSENT case ALSO asserted the literal string `'unknown'`,
  // which overrode the adapter's own URL-based inference outright even
  // though the asset URI here is perfectly inferable (`.mpd` -> dash).
  // Omitting the field lets that inference through instead.
  it('omits protocol (rather than asserting "unknown") when getManifestType is entirely absent, so URL inference can take over', () => {
    const noManifestType = fakeShaka({ getAssetUri: () => '', getManifestType: undefined });
    const { emitted } = attach(noManifestType);
    noManifestType.getAssetUri = () => 'https://cdn.example.com/d/manifest.mpd?sig=1';
    noManifestType.fire(SHAKA_EVENTS.MANIFEST_PARSED);
    const sourceChanges = emitted.filter((e) => e.type === 'source_change');
    expect(sourceChanges).toEqual([
      { type: 'source_change', data: { src: 'https://cdn.example.com/d/manifest.mpd?sig=1', live: false } },
    ]);
    expect(sourceChanges[0]!.data).not.toHaveProperty('protocol');
  });

  it('measures manifestMs (loading → manifestparsed) and firstFragmentMs (loading → loaded) with ctx.now()', () => {
    const shaka = fakeShaka();
    const { integ, clock } = attach(shaka);
    shaka.fire(SHAKA_EVENTS.LOADING);
    clock.t = 1080;
    shaka.fire(SHAKA_EVENTS.MANIFEST_PARSED);
    clock.t = 1300;
    shaka.fire(SHAKA_EVENTS.LOADED);
    expect(integ.startupTimings?.()).toEqual({ manifestMs: 80, firstFragmentMs: 300, licenseMs: 120 });
  });

  it('falls back to getStats().manifestTimeSeconds*1000 for manifestMs when no loading event was observed', () => {
    const shaka = fakeShaka();
    const { integ } = attach(shaka);
    // No LOADING fired — attach() only saw the late-attach replay, so
    // loadingT is undefined and the handler must fall back to stats().
    shaka.fire(SHAKA_EVENTS.MANIFEST_PARSED);
    expect(integ.startupTimings?.()).toEqual({ manifestMs: 80 });
  });

  it('emits drm once — at drmsessionupdate or loaded, whichever first — with keySystem and licenseMs', () => {
    const shaka = fakeShaka();
    const { emitted } = attach(shaka);
    shaka.fire(SHAKA_EVENTS.DRM_SESSION_UPDATE);
    shaka.fire(SHAKA_EVENTS.LOADED);
    expect(emitted.filter((e) => e.type === 'drm')).toEqual([
      { type: 'drm', data: { keySystem: 'com.widevine.alpha', licenseMs: 120 } },
    ]);
  });

  it('re-emits drm per load, without leaking the previous load\'s licenseMs — a reused instance can switch protection across loads', () => {
    const shaka = fakeShaka();
    const { emitted } = attach(shaka);
    shaka.fire(SHAKA_EVENTS.LOADING);
    shaka.fire(SHAKA_EVENTS.LOADED); // first load: widevine, licenseTime 0.12 → licenseMs 120

    shaka.drmInfo = () => null;
    shaka.keySystem = () => '';
    shaka.getStats = () => ({ estimatedBandwidth: 6_500_000, manifestTimeSeconds: 0.08, licenseTime: 0 });
    shaka.fire(SHAKA_EVENTS.LOADING); // second load: clear content, no license step
    shaka.fire(SHAKA_EVENTS.LOADED);

    expect(emitted.filter((e) => e.type === 'drm')).toEqual([
      { type: 'drm', data: { keySystem: 'com.widevine.alpha', licenseMs: 120 } },
      { type: 'drm', data: { keySystem: 'none' } },
    ]);
  });

  it('emits drm { keySystem: "none" } on loaded for clear content', () => {
    const shaka = fakeShaka({
      drmInfo: () => null,
      keySystem: () => '',
      getStats: () => ({ estimatedBandwidth: 6_500_000, manifestTimeSeconds: 0.08, licenseTime: 0 }),
    });
    const { emitted } = attach(shaka);
    shaka.fire(SHAKA_EVENTS.LOADED);
    expect(emitted.filter((e) => e.type === 'drm')).toEqual([
      { type: 'drm', data: { keySystem: 'none' } },
    ]);
  });

  it('maps adaptation → bitrate_change reason abr and variantchanged → reason manual, from the active variant', () => {
    const shaka = fakeShaka();
    const { emitted } = attach(shaka);
    shaka.fire(SHAKA_EVENTS.ADAPTATION);
    shaka.fire(SHAKA_EVENTS.VARIANT_CHANGED);
    expect(emitted.filter((e) => e.type === 'bitrate_change')).toEqual([
      { type: 'bitrate_change', data: { bitrate: 3_000_000, width: 1920, height: 1080, reason: 'abr' } },
      { type: 'bitrate_change', data: { bitrate: 3_000_000, width: 1920, height: 1080, reason: 'manual' } },
    ]);

    // No active variant (or no bandwidth) → nothing emitted.
    shaka.getVariantTracks = () => [{ active: false, bandwidth: 800_000 }];
    shaka.fire(SHAKA_EVENTS.ADAPTATION);
    expect(emitted.filter((e) => e.type === 'bitrate_change')).toHaveLength(2);
  });

  it('maps error events with code, fatal (severity 2) and category', () => {
    const shaka = fakeShaka();
    const { emitted } = attach(shaka);
    shaka.fire(SHAKA_EVENTS.ERROR, { detail: { code: 1001, category: 1, severity: 2, message: 'HTTP_ERROR' } });
    shaka.fire(SHAKA_EVENTS.ERROR, { detail: { code: 1002, category: 3, severity: 1 } });
    expect(emitted.filter((e) => e.type === 'error')).toEqual([
      { type: 'error', data: { message: 'HTTP_ERROR', code: 1001, fatal: true, detail: 'category 1' } },
      { type: 'error', data: { message: 'shaka error 1002', code: 1002, fatal: false, detail: 'category 3' } },
    ]);
  });

  it('snapshot() reads the active variant and estimatedBandwidth', () => {
    const shaka = fakeShaka();
    const { integ } = attach(shaka);
    expect(integ.snapshot?.()).toEqual({ bitrate: 3_000_000, width: 1920, height: 1080, bandwidthEstimate: 6_500_000 });

    shaka.getVariantTracks = () => [];
    expect(integ.snapshot?.()).toEqual({ bandwidthEstimate: 6_500_000 });
  });

  it('detach() removes every handler', () => {
    const shaka = fakeShaka();
    const { integ } = attach(shaka);
    expect(shaka.handlerCount()).toBeGreaterThan(0);
    integ.detach();
    expect(shaka.handlerCount()).toBe(0);
    expect(() => integ.detach()).not.toThrow();
  });

  it('attach() on an object without addEventListener does nothing and signals failure by returning false', () => {
    let result: boolean | void = undefined;
    expect(() => {
      result = shakaIntegration({}).attach({ element: {}, emit: () => {}, now: () => 0 });
    }).not.toThrow();
    expect(result).toBe(false);
  });

  // codex round 1, item 1 — activeVariant() only try/catches the
  // getVariantTracks() call itself; the subsequent `.find()` predicate and
  // property reads on each returned track run OUTSIDE that try/catch. A
  // duck-typed track whose `active` getter throws must still not be able to
  // throw through Shaka's own dispatch (`shaka.fire` stands in for that).
  it('a handler whose foreign track property getter throws does not escape into Shaka dispatch', () => {
    const shaka = fakeShaka();
    const { emitted } = attach(shaka);
    const poisoned: VariantTrack = {};
    Object.defineProperty(poisoned, 'active', {
      configurable: true,
      get() { throw new Error('duck-typed track is broken'); },
    });
    shaka.getVariantTracks = () => [poisoned];
    expect(() => shaka.fire(SHAKA_EVENTS.ADAPTATION)).not.toThrow();
    expect(emitted.filter((e) => e.type === 'bitrate_change')).toEqual([]);
  });
});
