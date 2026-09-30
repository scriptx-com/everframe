// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
//
// Per-shot state of the in-app reporter and its submit-time assembly, split
// out of ReporterDialog so the redaction gate is testable without rendering.
// A shot's DOM snapshot ships only when that shot carries no redaction: no
// blur annotation and no area selection (the in-app reporter's only crop).
// Snapshot-only shots have no image and cannot be annotated.
import { MAX_REPORT_SHOTS } from '@everframe/protocol';
import type { Annotation } from './annotation-model.js';
import { sha256Hex } from '../capture/sha256.js';
import {
  isShotReason,
  snapshotAllowed,
  type CapturedSnapshot,
  type RenderContext,
  type ShotCapture,
} from '../capture/shot-capture.js';
import {
  shotPartName,
  type BundleDomSnapshot,
  type BundleScreenshot,
} from '../transport/draft-to-envelope.js';

export interface ReportScreenshot {
  id: string;
  /** null for a snapshot-only shot (the server render failed). */
  blob: Blob | null;
  sha256: string;
  width: number;
  height: number;
  pixelRatio: number;
  annotations: Annotation[];
  source: 'auto' | 'manual';
  /** screenshot_* reason reported for THIS shot when it was captured. */
  degradedReason?: string | undefined;
  snapshot?: CapturedSnapshot | undefined;
  render?: RenderContext | undefined;
  /** Captured through the area selector — a crop of the page. */
  areaSelected: boolean;
}

export function reportScreenshotFrom(
  id: string,
  shot: ShotCapture,
  source: 'auto' | 'manual',
  areaSelected: boolean,
  pixelRatio: number,
): ReportScreenshot {
  return {
    id,
    blob: shot.image?.blob ?? null,
    sha256: shot.image?.sha256 ?? '',
    width: shot.image?.width ?? 0,
    height: shot.image?.height ?? 0,
    pixelRatio,
    annotations: [],
    source,
    areaSelected,
    ...(isShotReason(shot.degradedReason) ? { degradedReason: shot.degradedReason } : {}),
    // An area-selected shot never keeps its snapshot: the snapshot is the
    // whole page, i.e. exactly what the selection left out.
    ...(shot.snapshot !== undefined && !areaSelected ? { snapshot: shot.snapshot } : {}),
    ...(shot.render !== undefined ? { render: shot.render } : {}),
  };
}

type Tagged = Record<string, unknown> & { partName: string };

export interface AssembledShots {
  bundleShots: BundleScreenshot[];
  domSnapshots: BundleDomSnapshot[];
  taggedAnnotations: Tagged[];
  taggedRedactions: Tagged[];
  render: RenderContext | undefined;
}

/**
 * Bakes, hashes and numbers the strip's shots for submit. Shot numbers come
 * from each shot's FINAL strip position (after deletes) and are set on every
 * image and snapshot, so a shot's parts always pair up; at most
 * MAX_REPORT_SHOTS shots are assembled (the ingest file-part cap).
 */
export async function assembleDialogShots(
  shots: readonly ReportScreenshot[],
  bake: (blob: Blob, annotations: Annotation[]) => Promise<Blob>,
): Promise<AssembledShots> {
  const out: AssembledShots = {
    bundleShots: [],
    domSnapshots: [],
    taggedAnnotations: [],
    taggedRedactions: [],
    render: undefined,
  };
  const count = Math.min(shots.length, MAX_REPORT_SHOTS);
  for (let i = 0; i < count; i++) {
    const shot = shots[i]!;
    const shotNumber = i + 1;
    const blurred = shot.annotations.some((a) => a.kind === 'blur');
    if (
      shot.snapshot !== undefined &&
      // The in-app reporter's only crop IS the area selection.
      snapshotAllowed({ cropped: shot.areaSelected, blurred, areaSelected: shot.areaSelected })
    ) {
      out.domSnapshots.push({ shotNumber, bytes: shot.snapshot.bytes, sha256: shot.snapshot.sha256 });
    }
    if (out.render === undefined && shot.render !== undefined) out.render = shot.render;
    if (shot.blob === null) continue;
    const annotated = shot.annotations.length > 0;
    const partName = shotPartName(annotated ? 'annotated-screenshot' : 'screenshot', shotNumber);
    let blob = shot.blob;
    let sha = shot.sha256;
    if (annotated) {
      try {
        blob = await bake(shot.blob, shot.annotations);
      } catch {
        // DEFE-02 — never block submit on a bake failure; ship unmodified bytes.
      }
      try {
        sha = await sha256Hex(blob);
      } catch {
        // DEFE-02 — fall back to the pre-bake sha; receiver flags integrity,
        // report still ships.
      }
    }
    out.bundleShots.push({ blob, sha256: sha, width: shot.width, height: shot.height, annotated, shotNumber });
    for (const a of shot.annotations) {
      out.taggedAnnotations.push({ ...(a as unknown as Record<string, unknown>), partName });
      if (a.kind === 'blur') {
        out.taggedRedactions.push({ x: a.x, y: a.y, width: a.width, height: a.height, type: 'blur', partName });
      }
    }
  }
  return out;
}
