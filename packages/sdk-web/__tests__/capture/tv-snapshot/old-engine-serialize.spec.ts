// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// The REAL serializer (bundled rrweb-snapshot, patched) under engine gaps a
// Chrome 53 TV has: selectors and built-ins it does not know must not abort
// the snapshot (codex r11 F1).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureTvShot } from '../../../src/capture/tv-snapshot/tv-snapshot.js';

const WEBOS4 = 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/53.0.2785.34 Safari/537.36 WebAppManager';
const WEBP_1PX = Uint8Array.from(atob('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA='), (c) => c.charCodeAt(0));

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('snapshot on an engine without :modal (Chrome < 105)', () => {
  it('an open dialog still snapshots and renders instead of failing the shot', async () => {
    const native = Element.prototype.matches;
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
      if (selector.indexOf(':modal') !== -1) throw new DOMException(`'${selector}' is not a valid selector`, 'SyntaxError');
      return native.call(this, selector);
    });
    document.body.innerHTML = '<dialog id="dlg" open>Dialog body</dialog><p>page</p>';
    const fetchImpl = vi.fn(async () => new Response(WEBP_1PX, { status: 200, headers: { 'content-type': 'image/webp' } }));
    const fallbackCapture = vi.fn();
    const shot = await captureTvShot({
      snapshot: {
        win: window,
        doc: document,
        sensitiveElements: () => [],
        isSensitive: () => false,
        // jsdom has no layout: every box is on screen here.
        measure: { rectOf: () => ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }), sizeOf: () => ({ width: 100, height: 20 }) },
      },
      render: { url: 'https://api.example.test/api/render', sdkKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch },
      fallbackCapture,
      userAgent: WEBOS4,
      gzip: async (b) => b,
    }).shot;
    expect(shot.degradedReason).not.toBe('screenshot_unavailable');
    expect(shot.snapshot).toBeDefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const json = new TextDecoder().decode(shot.snapshot!.bytes);
    expect(json).toContain('"rr_open_mode":"non-modal"');
    expect(json).toMatch(/"open":""/);
  });
});
