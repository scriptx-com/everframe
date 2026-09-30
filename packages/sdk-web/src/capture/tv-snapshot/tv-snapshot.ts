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
import { imageShot, type CapturedSnapshot, type ShotCapture } from '../shot-capture.js';
import { takeDomSnapshot, type SnapshotDeps, type TakenSnapshot } from './serialize.js';
import { renderSnapshot, type RenderDeps } from './render-client.js';

export const SNAPDOM_FALLBACK_MAX_ELEMENTS = 3000;
export const MIN_FALLBACK_CHROME_MAJOR = 60;

export interface TvShotDeps {
  snapshot: SnapshotDeps;
  render: Omit<RenderDeps, 'fallbackSize'>;
  fallbackCapture: () => Promise<ScreenshotResult>;
  userAgent: string;
  gzip?: (bytes: Uint8Array) => Promise<Uint8Array>;
}

export function isWeakTvProfile(ua: string): boolean {
  const m = /Chrome\/(\d+)/.exec(ua);
  return m === null || Number(m[1]) < MIN_FALLBACK_CHROME_MAJOR;
}

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

async function fallbackShot(deps: TvShotDeps): Promise<ShotCapture> {
  const unavailable: ShotCapture = { degradedReason: DEGRADED_REASONS.screenshot_unavailable };
  if (isWeakTvProfile(deps.userAgent)) return unavailable;
  if (deps.snapshot.doc.getElementsByTagName('*').length > SNAPDOM_FALLBACK_MAX_ELEMENTS) return unavailable;
  try {
    const image = await deps.fallbackCapture();
    return image.degradedReason === DEGRADED_REASONS.screenshot_failed ? unavailable : imageShot(image);
  } catch {
    return unavailable;
  }
}

async function finishTvShot(taken: TakenSnapshot | null, deps: TvShotDeps): Promise<ShotCapture> {
  if (taken !== null) {
    let packed: CapturedSnapshot | null = null;
    try {
      packed = await packSnapshot(taken.doc, deps.gzip ?? gzipBytes);
    } catch {
      packed = null;
    }
    if (packed !== null) {
      const { viewport } = taken.render;
      const dpr = Math.min(taken.render.dpr || 1, 2);
      const rendered = await renderSnapshot(packed.bytes, {
        ...deps.render,
        fallbackSize: { width: Math.round(viewport.width * dpr), height: Math.round(viewport.height * dpr) },
      });
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
  let taken: TakenSnapshot | null = null;
  try {
    // Synchronous, so the page cannot change between the reporter's trigger
    // and serialization. Any throw — including a RangeError from rrweb-snapshot
    // recursing through an extremely deep live DOM (serialize restores the
    // live DOM in its own finally) — is a snapshot failure.
    taken = takeDomSnapshot(deps.snapshot);
  } catch {
    taken = null;
  }
  return {
    snapshotted: Promise.resolve(),
    shot: finishTvShot(taken, deps).catch((): ShotCapture => ({ degradedReason: DEGRADED_REASONS.screenshot_unavailable })),
  };
}
