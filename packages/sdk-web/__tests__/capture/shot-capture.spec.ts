// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import {
  boundedTvFallbackShot,
  captureShotVia,
  countElementsUpTo,
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
    await captureShotVia(modern, { consumePreCapture: true });
    expect(modern.__captureShot.mock.calls).toEqual([[], [{ consumePreCapture: true }]]);
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

describe('bounded element count, shadow roots included (codex r6 F3)', () => {
  const CAPABLE = 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Safari/537.36';

  it('counts light DOM and open shadow descendants, stopping just past the limit', () => {
    document.body.innerHTML = '<div id="host"><b></b></div><p></p>';
    const inner = document.getElementById('host')!.attachShadow({ mode: 'open' });
    inner.innerHTML = '<i></i><span id="nested"></span>';
    inner.getElementById('nested')!.attachShadow({ mode: 'open' }).innerHTML = '<u></u><u></u>';
    // html head body div b p + i span + u u
    expect(countElementsUpTo(document, 100)).toBe(10);
    expect(countElementsUpTo(document, 4)).toBe(5);
  });

  it('visits at most limit + 1 elements on a huge page', () => {
    document.body.innerHTML = '<i></i>'.repeat(20_000);
    let reads = 0;
    const spy = vi.spyOn(Element.prototype, 'nextElementSibling', 'get');
    spy.mockImplementation(function (this: Element) {
      reads++;
      let n = this.nextSibling;
      while (n !== null && n.nodeType !== 1) n = n.nextSibling;
      return n as Element | null;
    });
    expect(countElementsUpTo(document, 3000)).toBe(3001);
    spy.mockRestore();
    expect(reads).toBeLessThan(3100);
  });

  it('3,000 shadow elements skip the on-device fallback', async () => {
    document.body.innerHTML = '<div id="host"></div>';
    document.getElementById('host')!.attachShadow({ mode: 'open' }).innerHTML = '<i></i>'.repeat(3000);
    const capture = vi.fn(async () => image);
    await expect(boundedTvFallbackShot(capture, document, CAPABLE)).resolves.toEqual({ degradedReason: 'screenshot_unavailable' });
    expect(capture).not.toHaveBeenCalled();
  });
});
