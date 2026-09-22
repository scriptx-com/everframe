// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import {
  computeCappedPixelRatio,
  getCaptureProfile,
} from '../../src/capture/capture-profile.js';

const WEBOS_UA =
  'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Safari/537.36 WebAppManager';
const TIZEN_UA =
  'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.5) AppleWebKit/537.36 (KHTML, like Gecko) 85.0.4183.93/6.5 TV Safari/537.36';
const VIDAA_UA =
  'Mozilla/5.0 (Linux; Android 9; VIDAA; U6 Series) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79 Safari/537.36';
const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

describe('getCaptureProfile', () => {
  it('returns the TV profile for a webOS user agent', () => {
    const p = getCaptureProfile(WEBOS_UA);
    // 45s — a real TV home screen measured 19.2s end-to-end on a Samsung
    // UE43TU8502 with every TV optimisation already on, i.e. 800ms under the
    // old 20s ceiling, which made the same capture pass or ship a blank
    // placeholder at random. See TV_PROFILE in capture-profile.ts.
    expect(p.deadlineMs).toBe(45_000);
    expect(p.maxOutputEdgePx).toBe(1920);
    expect(p.fastClone).toBe(true);
  });

  it('disables companion live preview on every profile (product call 2026-08-27)', () => {
    // A preview frame costs a full DOM capture — a continuous CPU tax for a
    // nice-to-have viewfinder. Single-shot captures stay available.
    expect(getCaptureProfile(WEBOS_UA).livePreview).toBe(false);
    expect(getCaptureProfile(DESKTOP_UA).livePreview).toBe(false);
  });

  it('returns the TV profile for a Tizen user agent', () => {
    expect(getCaptureProfile(TIZEN_UA).fastClone).toBe(true);
  });

  it('returns the TV profile for a VIDAA user agent', () => {
    expect(getCaptureProfile(VIDAA_UA).fastClone).toBe(true);
  });

  it('returns the default profile for a desktop browser', () => {
    const p = getCaptureProfile(DESKTOP_UA);
    expect(p.deadlineMs).toBe(10_000);
    // Capped too: a Retina viewport otherwise rasterises + encodes 5-7 MP
    // per capture. Nothing reviews bug screenshots above ~2.5K.
    expect(p.maxOutputEdgePx).toBe(2560);
    expect(p.fastClone).toBe(false);
    expect(p.preferWebP).toBe(true);
  });

  it('prefers WebP on the TV profile as well', () => {
    expect(getCaptureProfile(WEBOS_UA).preferWebP).toBe(true);
  });

  it('clones only the viewport on every tier', () => {
    // Measured on the LG (webOS 6.5): the full-document clone reached 4.7MB of
    // XML at 1344 nodes, which Chrome 79 rasterises as a BLANK foreignObject —
    // a silent white screenshot. Pruning offscreen nodes took the same screen
    // to 0.31MB / 3.7s and rendered correctly. The output is cropped to the
    // viewport anyway, so offscreen nodes were pure cost.
    //
    // Desktop opts in too: measured on a react-native-web app in desktop
    // Chrome, 81% of nodes sat in fully-offscreen out-of-flow subtrees (that
    // framework keeps visited screens mounted), making the clone walk the
    // dominant cost on every screen regardless of how much it actually shows.
    expect(getCaptureProfile(WEBOS_UA).viewportOnlyClone).toBe(true);
    expect(getCaptureProfile(DESKTOP_UA).viewportOnlyClone).toBe(true);
    expect(getCaptureProfile(IPHONE_UA).viewportOnlyClone).toBe(true);
  });

  it('returns the default profile for a phone browser', () => {
    expect(getCaptureProfile(IPHONE_UA).fastClone).toBe(false);
  });

  it('reads navigator.userAgent when no argument is given', () => {
    // jsdom's UA is a desktop-like string — the default profile.
    expect(getCaptureProfile().deadlineMs).toBe(10_000);
  });
});

describe('FAST_CLONE_STYLE_PROPERTIES', () => {
  it('carries CSS Grid definition, placement and gap properties', async () => {
    // Codex round-2 finding 6: an element keeping display:grid but losing its
    // template/placement reflows into implicit tracks in the captured clone.
    const { FAST_CLONE_STYLE_PROPERTIES } = await import('../../src/capture/capture-profile.js');
    for (const p of [
      'grid-template-columns',
      'grid-template-rows',
      'grid-template-areas',
      'grid-auto-flow',
      'grid-auto-columns',
      'grid-auto-rows',
      'grid-column-start',
      'grid-column-end',
      'grid-row-start',
      'grid-row-end',
      'grid-area',
      'row-gap',
      'column-gap',
      'gap',
      'justify-items',
      'justify-self',
      'place-items',
      'place-content',
    ]) {
      expect(FAST_CLONE_STYLE_PROPERTIES).toContain(p);
    }
  });
});

describe('FAST_CLONE_STYLE_PROPERTIES — SVG paint', () => {
  it('carries SVG paint properties so CSS-styled icons survive the clone', async () => {
    // Codex round-3 finding 5: without fill/stroke, CSS-styled SVG icon
    // systems revert to SVG defaults (filled black / invisible) on TV shots.
    const { FAST_CLONE_STYLE_PROPERTIES } = await import('../../src/capture/capture-profile.js');
    for (const p of [
      'fill',
      'fill-opacity',
      'fill-rule',
      'stroke',
      'stroke-width',
      'stroke-opacity',
      'stroke-linecap',
      'stroke-linejoin',
      'stroke-dasharray',
      'stroke-dashoffset',
    ]) {
      expect(FAST_CLONE_STYLE_PROPERTIES).toContain(p);
    }
  });
});

describe('computeCappedPixelRatio', () => {
  it('halves a dpr-2 ratio on a 1920x1080 viewport so output stays at 1920', () => {
    // The measured webOS case: dpr 2 over a 1920x1080 CSS viewport renders
    // 3840x2160 — PNG-encoding that costs 7.4s on the TV chip.
    expect(computeCappedPixelRatio(2, 1920, 1080, 1920)).toBe(1);
  });

  it('leaves the ratio alone when output is already within the cap', () => {
    expect(computeCappedPixelRatio(1, 1920, 1080, 1920)).toBe(1);
    expect(computeCappedPixelRatio(2, 800, 600, 1920)).toBe(2);
  });

  it('never raises the requested ratio', () => {
    expect(computeCappedPixelRatio(0.5, 1920, 1080, 1920)).toBe(0.5);
  });

  it('caps against the longest edge, portrait included', () => {
    expect(computeCappedPixelRatio(2, 1080, 1920, 1920)).toBe(1);
  });

  it('is a passthrough when the cap is null', () => {
    expect(computeCappedPixelRatio(2, 1920, 1080, null)).toBe(2);
  });

  it('is a passthrough for degenerate root sizes', () => {
    expect(computeCappedPixelRatio(2, 0, 0, 1920)).toBe(2);
  });
});
