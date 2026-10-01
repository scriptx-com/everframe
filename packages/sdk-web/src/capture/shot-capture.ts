// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The SDK-internal capture result (spec 2026-09-29 §"Capture contract for the
// snapshot path"). `ScreenshotResult` requires image bytes; a smart-TV shot may
// carry an image rendered server-side from a DOM snapshot, the snapshot alone
// (render failed), both, or neither (unavailable). Keep this module tiny —
// everything that builds snapshots lives in the lazy capture/tv-snapshot chunk.
import type { CaptureControlRender } from '@everframe/protocol';
import { DOM_SNAPSHOT_CONTENT_TYPE, domSnapshotPartName } from '@everframe/protocol';
import type { ScreenshotResult } from '@everframe/sdk-core';
import { DEGRADED_REASONS } from '../internal/degraded-reasons.js';

export { DOM_SNAPSHOT_CONTENT_TYPE, domSnapshotPartName };

/** Envelope `captureControl.render` (protocol `CaptureControlRender`, a passthrough field). */
export type RenderContext = CaptureControlRender;

/** A gzip-JSON DomSnapshotV1, hashed exactly as it will ship. */
export interface CapturedSnapshot {
  bytes: Uint8Array;
  sha256: string;
  byteLength: number;
}

export interface ShotCapture {
  image?: ScreenshotResult;
  snapshot?: CapturedSnapshot;
  /** How a snapshot-path shot was rendered; absent on the on-device path. */
  render?: RenderContext;
  degradedReason?: string;
}

export function imageShot(image: ScreenshotResult): ShotCapture {
  return image.degradedReason !== undefined ? { image, degradedReason: image.degradedReason } : { image };
}

/** Above this many elements the on-device snapDOM fallback is too slow for a TV. */
export const SNAPDOM_FALLBACK_MAX_ELEMENTS = 3000;
/** Chromium majors below this are weak TV profiles: no on-device fallback. */
export const MIN_FALLBACK_CHROME_MAJOR = 60;

/**
 * Elements rrweb would serialize — the light DOM plus every open shadow root,
 * nested — counted until one past `limit` (then that is returned). Every
 * capture-cost guard uses this: `getElementsByTagName('*')` never sees shadow
 * descendants. Iterative and bounded: at most `limit + 1` elements visited,
 * at most two resume points held per visited element (Chrome 53: no
 * generators, no TreeWalker over shadow roots).
 */
export function countElementsUpTo(doc: Document, limit: number): number {
  let count = 0;
  const resume: Element[] = [];
  let el: Element | null = doc.documentElement;
  while (el !== null) {
    if (++count > limit) return count;
    const shadow: ShadowRoot | null | undefined = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    const shadowFirst: Element | null = shadow !== null && shadow !== undefined ? shadow.firstElementChild : null;
    const lightFirst: Element | null = el.firstElementChild;
    const next: Element | null = el.nextElementSibling;
    if (next !== null) resume.push(next);
    if (shadowFirst !== null && lightFirst !== null) resume.push(lightFirst);
    el = shadowFirst !== null ? shadowFirst : lightFirst !== null ? lightFirst : resume.length > 0 ? (resume.pop() as Element) : null;
  }
  return count;
}

export function isWeakTvProfile(ua: string): boolean {
  const m = /Chrome\/(\d+)/.exec(ua);
  return m === null || Number(m[1]) < MIN_FALLBACK_CHROME_MAJOR;
}

/**
 * The smart-TV path's bounded on-device fallback: skipped (unavailable) on a
 * weak profile or above SNAPDOM_FALLBACK_MAX_ELEMENTS, and a failed capture
 * is unavailable too. Here (eager) rather than in the lazy tv-snapshot chunk
 * because it is also what runs when that chunk fails to load.
 */
export async function boundedTvFallbackShot(
  capture: () => Promise<ScreenshotResult>,
  doc: Document,
  userAgent: string,
): Promise<ShotCapture> {
  const unavailable: ShotCapture = { degradedReason: DEGRADED_REASONS.screenshot_unavailable };
  if (isWeakTvProfile(userAgent)) return unavailable;
  if (countElementsUpTo(doc, SNAPDOM_FALLBACK_MAX_ELEMENTS) > SNAPDOM_FALLBACK_MAX_ELEMENTS) return unavailable;
  try {
    const image = await capture();
    return image.degradedReason === DEGRADED_REASONS.screenshot_failed ? unavailable : imageShot(image);
  } catch {
    return unavailable;
  }
}

export interface ShotCaptureOptions {
  /**
   * Hand out the smart-TV pre-capture taken as the reporter opened. ONLY the
   * in-app dialog's open-time capture sets this; every other capture (an
   * added shot, the companion) must be fresh, never a shot of an earlier open.
   */
  consumePreCapture?: boolean;
}

interface ShotCapableAdapter {
  captureScreenshot(): Promise<ScreenshotResult>;
  __captureShot?: (options?: ShotCaptureOptions) => Promise<ShotCapture>;
}

/**
 * The adapter's shot capture, or its plain screenshot for adapters that
 * predate `__captureShot` — `ReporterDialog` is public and hand-wired hosts
 * implement the companion seam themselves.
 */
export function captureShotVia(
  adapter: ShotCapableAdapter,
  options?: ShotCaptureOptions,
): Promise<ShotCapture> {
  if (typeof adapter.__captureShot !== 'function') return adapter.captureScreenshot().then(imageShot);
  return options === undefined ? adapter.__captureShot() : adapter.__captureShot(options);
}

/** Strongest first: failed > unavailable > render_failed > blank. */
const SHOT_REASON_ORDER: readonly string[] = [
  DEGRADED_REASONS.screenshot_failed,
  DEGRADED_REASONS.screenshot_unavailable,
  DEGRADED_REASONS.screenshot_render_failed,
  DEGRADED_REASONS.screenshot_blank,
];

export function isShotReason(reason: string | undefined): boolean {
  return reason !== undefined && SHOT_REASON_ORDER.indexOf(reason) !== -1;
}

export function strongestShotReason(reasons: Iterable<string | undefined>): string | undefined {
  let best = -1;
  for (const reason of reasons) {
    const rank = reason === undefined ? -1 : SHOT_REASON_ORDER.indexOf(reason);
    if (rank !== -1 && (best === -1 || rank < best)) best = rank;
  }
  return best === -1 ? undefined : SHOT_REASON_ORDER[best];
}

export interface ShotRedactionState {
  cropped: boolean;
  blurred: boolean;
  areaSelected: boolean;
}

/**
 * A shot's DOM snapshot may ship only when its redaction state is KNOWN and
 * clean — otherwise it would expose exactly what the user blurred, cropped
 * away or excluded by area selection (spec §Capture contract).
 */
export function snapshotAllowed(state: ShotRedactionState | undefined): boolean {
  return state !== undefined && !state.cropped && !state.blurred && !state.areaSelected;
}
