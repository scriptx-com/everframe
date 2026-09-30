// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it, vi } from 'vitest';
import {
  captureShotVia,
  domSnapshotPartName,
  imageShot,
  isShotReason,
  snapshotAllowed,
  strongestShotReason,
  DOM_SNAPSHOT_CONTENT_TYPE,
} from '../../src/capture/shot-capture.js';
import { DEGRADED_REASONS } from '../../src/internal/degraded-reasons.js';

const image = { blob: new Blob(['x'], { type: 'image/webp' }), width: 2, height: 2, sha256: 'a'.repeat(64) };

describe('shot-capture contract', () => {
  it('re-exports the protocol part naming and content type', () => {
    expect(domSnapshotPartName(1)).toBe('dom-snapshot');
    expect(domSnapshotPartName(2)).toBe('dom-snapshot-2');
    expect(DOM_SNAPSHOT_CONTENT_TYPE).toBe('application/gzip');
  });

  it('wraps a plain screenshot, carrying its own degraded reason', () => {
    expect(imageShot(image)).toEqual({ image });
    const blank = { ...image, degradedReason: 'screenshot_blank' };
    expect(imageShot(blank)).toEqual({ image: blank, degradedReason: 'screenshot_blank' });
  });

  it('prefers __captureShot and falls back to captureScreenshot for older adapters', async () => {
    const shot = { snapshot: { bytes: new Uint8Array([1]), sha256: 'b'.repeat(64), byteLength: 1 } };
    const modern = { captureScreenshot: vi.fn(), __captureShot: vi.fn(async () => shot) };
    await expect(captureShotVia(modern)).resolves.toBe(shot);
    expect(modern.captureScreenshot).not.toHaveBeenCalled();
    const legacy = { captureScreenshot: vi.fn(async () => image) };
    await expect(captureShotVia(legacy)).resolves.toEqual({ image });
  });

  it('ranks reasons failed > unavailable > render_failed > blank and ignores others', () => {
    expect(strongestShotReason(['screenshot_blank', 'screenshot_render_failed'])).toBe('screenshot_render_failed');
    expect(strongestShotReason(['screenshot_render_failed', 'screenshot_unavailable'])).toBe('screenshot_unavailable');
    expect(strongestShotReason(['screenshot_unavailable', 'screenshot_failed'])).toBe('screenshot_failed');
    expect(strongestShotReason(['ui_tree_unavailable', undefined])).toBeUndefined();
    expect(isShotReason(DEGRADED_REASONS.screenshot_render_failed)).toBe(true);
    expect(isShotReason('csp_blocked')).toBe(false);
  });

  it('allows a snapshot only for a known, clean redaction state', () => {
    expect(snapshotAllowed(undefined)).toBe(false);
    expect(snapshotAllowed({ cropped: false, blurred: false, areaSelected: false })).toBe(true);
    expect(snapshotAllowed({ cropped: true, blurred: false, areaSelected: false })).toBe(false);
    expect(snapshotAllowed({ cropped: false, blurred: true, areaSelected: false })).toBe(false);
    expect(snapshotAllowed({ cropped: false, blurred: false, areaSelected: true })).toBe(false);
  });
});
