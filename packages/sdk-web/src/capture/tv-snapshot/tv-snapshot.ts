// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// LAZY ENTRY of the smart-TV capture path (chunk `tv-snapshot-*.js`). The
// adapter reaches it only through `import('./capture/tv-snapshot/tv-snapshot.js')`,
// and only when the UA is a TV AND /api/config says the server renders.
//
// Fallback order (spec §"Smart-TV web", step 4):
//   snapshot + render OK        → image (+ snapshot, attached later only if unredacted)
//   snapshot OK, render fails   → snapshot alone, screenshot_render_failed
//   snapshot fails              → bounded on-device snapDOM — skipped on weak
//                                 profiles (Chrome < 60) and above 3000 elements
//
// A weak profile does not even take the snapshot above
// WEAK_TV_SNAPSHOT_MAX_ELEMENTS: it is synchronous, and measured on webOS 4
// (Chrome 53) it blocks the page ~2.2 s at 1,000 elements and ~5.3 s at
// 3,000. Such a shot is screenshot_unavailable, without freezing the app.
//   nothing                     → screenshot_unavailable (never a blank image)
import { gzipBytes } from '@everframe/sdk-core';
import type { ScreenshotResult } from '@everframe/sdk-core';
import {
  countDomSnapshotNodes,
  domSnapshotDepth,
  MAX_DOM_SNAPSHOT_COMPRESSED_BYTES,
  MAX_DOM_SNAPSHOT_DECOMPRESSED_BYTES,
  MAX_DOM_SNAPSHOT_DEPTH,
  MAX_DOM_SNAPSHOT_NODES,
  type DomSnapshotV1,
} from '@everframe/protocol';
import { DEGRADED_REASONS } from '../../internal/degraded-reasons.js';
import { sha256Hex } from '../sha256.js';
import {
  boundedTvFallbackShot,
  isWeakTvProfile,
  MIN_FALLBACK_CHROME_MAJOR,
  SNAPDOM_FALLBACK_MAX_ELEMENTS,
  type CapturedSnapshot,
  type ShotCapture,
} from '../shot-capture.js';
import { takeDomSnapshot, type SnapshotDeps, type TakenSnapshot } from './serialize.js';
import { renderSnapshot, type RenderDeps } from './render-client.js';

export { SNAPDOM_FALLBACK_MAX_ELEMENTS, MIN_FALLBACK_CHROME_MAJOR, isWeakTvProfile };

/** Above this many elements a weak TV profile skips the (synchronous) snapshot. */
export const WEAK_TV_SNAPSHOT_MAX_ELEMENTS = 1000;

/** Weak profile and a page big enough to freeze it for seconds. One cheap live count. */
function snapshotTooCostly(deps: TvShotDeps): boolean {
  return (
    isWeakTvProfile(deps.userAgent) &&
    deps.snapshot.doc.getElementsByTagName('*').length > WEAK_TV_SNAPSHOT_MAX_ELEMENTS
  );
}

export interface TvShotDeps {
  snapshot: SnapshotDeps;
  render: Omit<RenderDeps, 'fallbackSize'>;
  fallbackCapture: () => Promise<ScreenshotResult>;
  userAgent: string;
  gzip?: (bytes: Uint8Array) => Promise<Uint8Array>;
  /**
   * Whether the reporting owner that started this shot still owns the client
   * (false after kill(), and after a revive — a new owner). Checked before
   * serialization, before the render POST, after it and before any fallback:
   * a stale shot captures and uploads nothing.
   */
  isCurrent?: () => boolean;
}

const unavailable = (): ShotCapture => ({ degradedReason: DEGRADED_REASONS.screenshot_unavailable });

const stale = (deps: TvShotDeps): boolean => deps.isCurrent !== undefined && !deps.isCurrent();

/**
 * Serialize + gzip + hash the FINAL (pruned + scrubbed) tree, enforcing every
 * protocol cap the server enforces — node count, element depth, JSON bytes,
 * gzip bytes. Throws past any of them; the caller treats that as a snapshot
 * failure. Node and depth walks are iterative and stop at their limit.
 */
export async function packSnapshot(
  doc: DomSnapshotV1,
  gzip: (bytes: Uint8Array) => Promise<Uint8Array>,
): Promise<CapturedSnapshot> {
  if (countDomSnapshotNodes(doc, MAX_DOM_SNAPSHOT_NODES) > MAX_DOM_SNAPSHOT_NODES) throw new Error('snapshot_too_large');
  if (domSnapshotDepth(doc, MAX_DOM_SNAPSHOT_DEPTH) > MAX_DOM_SNAPSHOT_DEPTH) throw new Error('snapshot_too_deep');
  const json = new TextEncoder().encode(JSON.stringify(doc));
  if (json.byteLength > MAX_DOM_SNAPSHOT_DECOMPRESSED_BYTES) throw new Error('snapshot_too_large');
  const bytes = await gzip(json);
  if (bytes.byteLength > MAX_DOM_SNAPSHOT_COMPRESSED_BYTES) throw new Error('snapshot_too_large');
  return { bytes, byteLength: bytes.byteLength, sha256: await sha256Hex(new Blob([bytes as BlobPart])) };
}

function fallbackShot(deps: TvShotDeps): Promise<ShotCapture> {
  if (stale(deps)) return Promise.resolve(unavailable());
  return boundedTvFallbackShot(deps.fallbackCapture, deps.snapshot.doc, deps.userAgent);
}

async function finishTvShot(taken: TakenSnapshot | null, deps: TvShotDeps): Promise<ShotCapture> {
  if (taken !== null) {
    let packed: CapturedSnapshot | null = null;
    try {
      packed = await packSnapshot(taken.doc, deps.gzip ?? gzipBytes);
    } catch {
      packed = null;
    }
    if (stale(deps)) return unavailable();
    if (packed !== null) {
      const { viewport } = taken.render;
      const dpr = Math.min(taken.render.dpr || 1, 2);
      const rendered = await renderSnapshot(packed.bytes, {
        ...deps.render,
        fallbackSize: { width: Math.round(viewport.width * dpr), height: Math.round(viewport.height * dpr) },
      });
      if (stale(deps)) return unavailable();
      if (rendered.ok) {
        const blank = rendered.meta.blank ? DEGRADED_REASONS.screenshot_blank : undefined;
        const image: ScreenshotResult = {
          blob: rendered.blob,
          width: rendered.width,
          height: rendered.height,
          sha256: await sha256Hex(rendered.blob),
          ...(blank !== undefined ? { degradedReason: blank } : {}),
        };
        return { image, snapshot: packed, render: taken.render, ...(blank !== undefined ? { degradedReason: blank } : {}) };
      }
      return { snapshot: packed, render: taken.render, degradedReason: DEGRADED_REASONS.screenshot_render_failed };
    }
  }
  return fallbackShot(deps);
}

export function captureTvShot(deps: TvShotDeps): { snapshotted: Promise<void>; shot: Promise<ShotCapture> } {
  if (stale(deps)) return { snapshotted: Promise.resolve(), shot: Promise.resolve(unavailable()) };
  let taken: TakenSnapshot | null = null;
  try {
    // Synchronous, so the page cannot change between the reporter's trigger
    // and serialization. Any throw — including a RangeError from rrweb-snapshot
    // recursing through an extremely deep live DOM (serialize restores the
    // live DOM in its own finally) — is a snapshot failure.
    if (!snapshotTooCostly(deps)) taken = takeDomSnapshot(deps.snapshot);
  } catch {
    taken = null;
  }
  return {
    snapshotted: Promise.resolve(),
    shot: finishTvShot(taken, deps).catch(unavailable),
  };
}
