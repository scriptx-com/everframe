// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { MAX_REPORT_SHOTS } from '@everframe/protocol';
import { assembleDialogShots, reportScreenshotFrom, type ReportScreenshot } from '../../src/reporter-ui/dialog-shots.js';

const SNAP = { bytes: new Uint8Array([1, 2]), sha256: 'e'.repeat(64), byteLength: 2 };
const RENDER = { platform: 'webos', viewport: { width: 1280, height: 720 }, dpr: 1, fontStatus: 'loaded' } as ReportScreenshot['render'];
const shot = (id: string, extra: Partial<ReportScreenshot> = {}): ReportScreenshot => ({
  id, blob: new Blob([id], { type: 'image/webp' }), sha256: 'a'.repeat(64), width: 10, height: 10, pixelRatio: 1,
  annotations: [], source: 'auto', areaSelected: false, ...extra,
});
const bake = vi.fn(async (b: Blob) => b);
const blur = { id: 'a1', kind: 'blur' as const, x: 1, y: 2, width: 3, height: 4 };
const arrow = { id: 'a2', kind: 'arrow' as const, from: [0, 0] as [number, number], to: [5, 5] as [number, number], color: '#f00', thickness: 2 };

describe('assembleDialogShots', () => {
  it("attaches a clean image shot's snapshot under the same shot number", async () => {
    const out = await assembleDialogShots([shot('s1', { snapshot: SNAP, render: RENDER })], bake);
    expect(out.bundleShots.map((s) => s.shotNumber)).toEqual([1]);
    expect(out.domSnapshots).toEqual([{ shotNumber: 1, bytes: SNAP.bytes, sha256: SNAP.sha256 }]);
    expect(out.render).toEqual(RENDER);
  });

  it('drops the snapshot of a blurred shot and of an area-selected shot', async () => {
    const out = await assembleDialogShots([
      shot('s1', { snapshot: SNAP, annotations: [blur] }),
      shot('s2', { snapshot: SNAP, areaSelected: true }),
    ], bake);
    expect(out.domSnapshots).toEqual([]);
    expect(out.bundleShots.map((s) => [s.shotNumber, s.annotated])).toEqual([[1, true], [2, false]]);
  });

  it('keeps the snapshot of a shot annotated without a blur', async () => {
    const out = await assembleDialogShots([shot('s1', { snapshot: SNAP, annotations: [arrow] })], bake);
    expect(out.domSnapshots.map((d) => d.shotNumber)).toEqual([1]);
    expect(out.bundleShots[0]!.annotated).toBe(true);
  });

  it('keeps numbering aligned when shot 1 is snapshot-only', async () => {
    const out = await assembleDialogShots([shot('s1', { blob: null, snapshot: SNAP }), shot('s2')], bake);
    expect(out.bundleShots.map((s) => s.shotNumber)).toEqual([2]);
    expect(out.domSnapshots.map((d) => d.shotNumber)).toEqual([1]);
  });

  it('numbers from the final position, so a delete ahead of a shot renumbers it', async () => {
    // The strip after deleting the original shot 1: what was shot 2 is now first.
    const out = await assembleDialogShots([shot('was-2', { snapshot: SNAP }), shot('was-3', { snapshot: SNAP })], bake);
    expect(out.bundleShots.map((s) => s.shotNumber)).toEqual([1, 2]);
    expect(out.domSnapshots.map((d) => d.shotNumber)).toEqual([1, 2]);
  });

  it('tags annotations and blur redactions with the numbered part name', async () => {
    const out = await assembleDialogShots([shot('s1'), shot('s2', { annotations: [blur] })], bake);
    expect(out.taggedRedactions).toEqual([{ x: 1, y: 2, width: 3, height: 4, type: 'blur', partName: 'annotated-screenshot-2' }]);
    expect(out.taggedAnnotations.map((a) => a.partName)).toEqual(['annotated-screenshot-2']);
  });

  it(`never assembles more than MAX_REPORT_SHOTS (${MAX_REPORT_SHOTS}) shots`, async () => {
    const many = Array.from({ length: MAX_REPORT_SHOTS + 2 }, (_, i) => shot(`s${i + 1}`, { snapshot: SNAP }));
    const out = await assembleDialogShots(many, bake);
    expect(out.bundleShots).toHaveLength(MAX_REPORT_SHOTS);
    expect(out.domSnapshots).toHaveLength(MAX_REPORT_SHOTS);
    expect(Math.max(...out.domSnapshots.map((d) => d.shotNumber))).toBe(MAX_REPORT_SHOTS);
  });
});

describe('reportScreenshotFrom', () => {
  it('maps a snapshot-only capture to an image-less, non-annotatable strip entry', () => {
    const entry = reportScreenshotFrom('shot-1', { snapshot: SNAP, render: RENDER, degradedReason: 'screenshot_render_failed' }, 'auto', false, 1);
    expect(entry).toMatchObject({ id: 'shot-1', blob: null, width: 0, height: 0, snapshot: SNAP, render: RENDER, degradedReason: 'screenshot_render_failed', areaSelected: false });
  });

  it('never keeps the snapshot of an area-selected capture', () => {
    const image = { blob: new Blob(['x']), sha256: 'a'.repeat(64), width: 4, height: 4 };
    const entry = reportScreenshotFrom('shot-2', { image, snapshot: SNAP }, 'manual', true, 1);
    expect(entry.snapshot).toBeUndefined();
    expect(entry.areaSelected).toBe(true);
  });

  it('carries only screenshot reasons onto the shot', () => {
    const entry = reportScreenshotFrom('shot-1', { snapshot: SNAP, degradedReason: 'csp_blocked' }, 'auto', false, 1);
    expect('degradedReason' in entry).toBe(false);
  });
});
