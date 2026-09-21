// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';

/**
 * Device-tiered capture tuning.
 *
 * Smart-TV webviews (webOS, Tizen, VIDAA, TitanOS) run capture on laptop-class
 * DOM sizes with phone-class CPUs. Measured on an LG 43UP77003LB (webOS 6.5,
 * Chrome 79), a 534-node home screen took 16.9s end-to-end with the desktop
 * defaults — the 10s deadline fired every time and the companion shipped the
 * degraded 1x1 placeholder instead of a screenshot. The dominant costs were
 * the 4K raster + PNG encode (devicePixelRatio 2 over a 1920x1080 viewport)
 * and the all-properties computed-style copy in the clone walk.
 */
export interface CaptureProfile {
  /** Wall-clock ceiling for the whole capture (screenshot.ts withDeadline). */
  deadlineMs: number;
  /**
   * Cap on the longest edge of the OUTPUT bitmap, in device px; null = no cap.
   * A 4K screenshot buys nothing for a bug report, and PNG-encoding one costs
   * 7.4s on a TV chip vs ~1s at 1080p.
   */
  maxOutputEdgePx: number | null;
  /**
   * Trade clone fidelity for speed: skip webfont embedding (text falls back to
   * the system font stack inside the SVG render) and copy only the curated
   * style whitelist below instead of every computed property. Measured
   * together: -3.7s on the LG home screen, pixel-verified against the live
   * page for layout, images, gradients, radii and focus rings.
   */
  fastClone: boolean;
  /**
   * Companion live preview (the phone's add-shot viewfinder). Each frame is a
   * full DOM capture — ~6s on TV silicon, and a continuous CPU tax even on
   * desktops — for a nice-to-have viewfinder. Declined on EVERY profile
   * (product call 2026-08-27); single-shot captures (shot.request) stay
   * available, and the phone shows its standard "live view unavailable"
   * fallback. The flag stays in the profile so re-enabling per tier is a
   * one-line change.
   */
  livePreview: boolean;
  /**
   * Encode the final canvas as WebP (PNG fallback when the encoder declines).
   * On every tier: the relay hop re-encodes PNG→WebP anyway, so source-WebP
   * saves a full decode/encode round per capture.
   */
  preferWebP: boolean;
  /**
   * Clone ONLY what the viewport shows, pruning fully-offscreen nodes.
   *
   * The capture is cropped to the viewport regardless, so offscreen nodes are
   * pure cost — and on TVs that cost is fatal, not merely slow. Measured on
   * the LG (webOS 6.5) at 1344 nodes: the full-document clone serialised to
   * 4.7MB of XML, which Chrome 79 loads as an image but rasterises BLANK —
   * a silent white screenshot with no error anywhere. Pruning took the same
   * screen to 0.31MB and 3.7s (from 28.9s) and rendered correctly.
   *
   * TRADEOFF: modern-screenshot prunes whole subtrees, so an absolutely
   * positioned child that escapes an offscreen ancestor's box is dropped with
   * it. The 100px margin below absorbs the common near-fold cases; a TV
   * screenshot that is present and correct beats a full-document one that is
   * blank.
   */
  viewportOnlyClone: boolean;
}

const DEFAULT_PROFILE: CaptureProfile = {
  deadlineMs: 10_000,
  // A Retina viewport otherwise rasterises + PNG-encodes 5-7 MP per capture;
  // nothing reviews bug screenshots above ~2.5K.
  maxOutputEdgePx: 2560,
  fastClone: false,
  livePreview: false,
  preferWebP: true,
  // ON everywhere, not just TV. The clone walk is `nodes x properties` and the
  // capture is cropped to the viewport regardless, so offscreen nodes are pure
  // cost on every tier — TVs are where it turns fatal, not where it starts.
  //
  // Measured on a react-native-web TV app in desktop Chrome: 3710 of 4583 nodes
  // (81%) sit in fully-offscreen out-of-flow subtrees, because RN-Web keeps
  // previously-visited screens mounted — the home rails are still in the DOM on
  // every later screen, which is why an image-light settings page cost the same
  // 1.6s clone as the image-heavy home page. The pre-pass itself measured 7-9ms
  // there.
  //
  // Unlike `fastClone`, this cannot silently degrade an unfamiliar page: a
  // subtree is dropped only when NOTHING inside it intersects the viewport
  // (computePrunableNodes evaluates visibility across the whole subtree, so a
  // virtualized container parked offscreen with children transformed into view
  // is kept), and only when it is out-of-flow, so no sibling reflows.
  viewportOnlyClone: true,
};

const TV_PROFILE: CaptureProfile = {
  // 45s, not 20s. Measured 2026-09-17 on a Samsung UE43TU8502 (Tizen 5.5,
  // Chrome 69) against a representative TV home screen — 686 nodes, 35 images, all
  // TV-profile optimisations already active (fastClone, viewportOnlyClone,
  // dpr 1, maxOutputEdgePx 1920):
  //
  //   domToCanvas 17887ms | crop 187ms | encode 1120ms | total 19194ms
  //
  // That is 800ms under the old 20s ceiling, so the SAME screen on the SAME
  // device passed one attempt and blew the deadline on the next. The failure
  // mode is the worst possible: `withDeadline` rejects, the catch below swaps
  // in a 67-byte transparent pixel, and the companion ships a BLANK
  // screenshot that looks like a successful capture. Intermittent, silent,
  // and indistinguishable from "the feature doesn't work on TV".
  //
  // The cost is not fixable by pruning harder. `computePrunableNodes` only
  // drops fully-offscreen OUT-OF-FLOW subtrees (screenshot.ts) because
  // removing an in-flow node reflows the clone and corrupts the visible
  // region — on this screen that is 44 of 344 offscreen nodes, and the
  // remaining 300 are in-flow rails that MUST stay for layout. The 81%
  // prune rate quoted on DEFAULT_PROFILE came from a settings screen, whose
  // offscreen content is out-of-flow; it does not generalise to a home rail
  // layout.
  //
  // So the ceiling has to cover the real cost of a real TV home screen with
  // roughly 2x headroom. A generous deadline costs nothing when captures
  // succeed — it is a ceiling, not a delay — and the alternative is shipping
  // blank screenshots at random.
  deadlineMs: 45_000,
  maxOutputEdgePx: 1920,
  fastClone: true,
  livePreview: false,
  preferWebP: true,
  viewportOnlyClone: true,
};

/**
 * Smart-TV webview markers. `Web0S` (zero, LG's spelling) + `WebAppManager`
 * cover webOS; `SMART-TV` appears in Tizen UAs alongside `Tizen`; VIDAA
 * (Hisense) and TitanOS (Philips) ship their brand name.
 */
const TV_WEBVIEW_RE = /Web0S|WebAppManager|Tizen|VIDAA|TitanOS|SmartTV|SMART-TV/i;

/** Resolve the capture profile for a user agent (defaults to the live one). */
export function getCaptureProfile(userAgent?: string): CaptureProfile {
  const ua =
    userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  return TV_WEBVIEW_RE.test(ua) ? TV_PROFILE : DEFAULT_PROFILE;
}

/**
 * Cap the effective pixel ratio so the output's longest edge stays within
 * `maxOutputEdgePx`. Never raises the requested ratio; passthrough when the
 * cap is null or the root has no size to measure against.
 */
export function computeCappedPixelRatio(
  requested: number,
  rootWidthCssPx: number,
  rootHeightCssPx: number,
  maxOutputEdgePx: number | null,
): number {
  if (maxOutputEdgePx === null || maxOutputEdgePx <= 0) return requested;
  const longestEdge = Math.max(rootWidthCssPx, rootHeightCssPx);
  if (!Number.isFinite(longestEdge) || longestEdge <= 0) return requested;
  return Math.min(requested, maxOutputEdgePx / longestEdge);
}

/**
 * Style properties copied per node when `fastClone` is on. Chrome 79 exposes
 * ~300 computed properties; reading and re-serialising all of them is the
 * single biggest clone cost on TV CPUs. This list carries layout, box, flex,
 * background, border, transform, text and image-fit properties — the set that
 * survived pixel-comparison against a full-property clone on the LG device.
 */
export const FAST_CLONE_STYLE_PROPERTIES: string[] = [
  'display', 'position', 'top', 'left', 'right', 'bottom', 'z-index',
  'flex', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items',
  'align-self', 'flex-grow', 'flex-shrink', 'flex-basis', 'order',
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'box-sizing',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'overflow', 'overflow-x', 'overflow-y', 'opacity', 'visibility',
  // Preserve standard scrollbar hiding as well as WebKit pseudo-element rules.
  'scrollbar-width',
  'transform', 'transform-origin',
  'background-color', 'background-image', 'background-size',
  'background-position', 'background-repeat',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-left-radius', 'border-top-right-radius',
  'border-bottom-left-radius', 'border-bottom-right-radius',
  'color', 'font-family', 'font-size', 'font-weight', 'font-style',
  'line-height', 'letter-spacing',
  'text-align', 'text-overflow', 'text-transform', 'text-decoration',
  'white-space', 'word-break', 'text-shadow', 'box-shadow',
  'object-fit', 'object-position', 'filter', 'clip-path',
  'pointer-events', 'direction',
  // CSS Grid (codex round-2 finding 6): display:grid survives the whitelist,
  // so its definition/placement/gap properties must too — without them grid
  // children reflow into implicit tracks in the captured clone.
  'grid-template-columns', 'grid-template-rows', 'grid-template-areas',
  'grid-auto-flow', 'grid-auto-columns', 'grid-auto-rows',
  'grid-column-start', 'grid-column-end', 'grid-row-start', 'grid-row-end',
  'grid-area', 'row-gap', 'column-gap', 'gap',
  'justify-items', 'justify-self', 'place-items', 'place-content',
  // SVG paint (codex round-3 finding 5): CSS-styled icon systems otherwise
  // revert to SVG defaults — filled-black or invisible icons — in the clone.
  'fill', 'fill-opacity', 'fill-rule',
  'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
];
