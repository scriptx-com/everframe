// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeViewportCropRect } from '../../src/capture/screenshot.js';
import { DEGRADED_REASONS } from '../../src/internal/degraded-reasons.js';

// 1x1 transparent PNG bytes for jsdom mocks
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

const WEBOS_UA =
  'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Safari/537.36 WebAppManager';

interface CanvasStubOptions {
  width?: number;
  height?: number;
  /** MIME types toBlob should answer with null for (encoder "unsupported"). */
  refuseTypes?: string[];
}

/**
 * jsdom has no real canvas: getContext returns null (the crop pass then
 * no-ops back to the input canvas) and we supply toBlob ourselves, echoing
 * the requested type so encode-format assertions can see it.
 */
function makeCanvasStub(opts: CanvasStubOptions = {}) {
  const toBlobCalls: string[] = [];
  const stub = {
    width: opts.width ?? 200,
    height: opts.height ?? 100,
    getContext: () => null,
    toBlob(cb: (b: Blob | null) => void, type?: string, _quality?: number) {
      const t = type ?? 'image/png';
      toBlobCalls.push(t);
      if ((opts.refuseTypes ?? []).includes(t)) return cb(null);
      cb(new Blob([PNG_BYTES], { type: t }));
    },
  };
  return { stub: stub as unknown as HTMLCanvasElement, toBlobCalls };
}

function stubUserAgent(ua: string): () => void {
  const original = Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent');
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
  return () => {
    delete (window.navigator as unknown as Record<string, unknown>).userAgent;
    if (original) Object.defineProperty(Navigator.prototype, 'userAgent', original);
  };
}

describe('captureScreenshot', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<div data-testid="root" style="width: 200px; height: 100px;">hello</div>';
    if (typeof globalThis.createImageBitmap !== 'function') {
      // jsdom doesn't ship createImageBitmap; stub returns a 1x1 bitmap (matches transparent PNG)
      globalThis.createImageBitmap = (async (_b: Blob) => ({
        width: 1,
        height: 1,
        close: () => undefined,
      })) as typeof createImageBitmap;
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    document.body.innerHTML = '';
  });

  it('uses modern-screenshot domToCanvas and returns ScreenshotResult with sha256 hex', async () => {
    const { stub } = makeCanvasStub();
    vi.doMock('modern-screenshot', () => ({ domToCanvas: vi.fn(async () => stub) }));
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    const r = await cap({ root: document.body });
    expect(r.blob).toBeInstanceOf(Blob);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.width).toBe(200);
    expect(r.height).toBe(100);
    vi.doUnmock('modern-screenshot');
  });

  it('encodes exactly once (no post-capture decode/re-encode pass)', async () => {
    const { stub, toBlobCalls } = makeCanvasStub();
    vi.doMock('modern-screenshot', () => ({ domToCanvas: vi.fn(async () => stub) }));
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    await cap({ root: document.body });
    expect(toBlobCalls).toHaveLength(1);
    vi.doUnmock('modern-screenshot');
  });

  it('passes a filter that excludes nodes tagged data-traceitx-skip-capture', async () => {
    let capturedFilter: ((node: HTMLElement) => boolean) | undefined;
    const { stub } = makeCanvasStub();
    vi.doMock('modern-screenshot', () => ({
      domToCanvas: vi.fn(
        async (_root: HTMLElement, opts: { filter?: (n: HTMLElement) => boolean }) => {
          capturedFilter = opts.filter;
          return stub;
        },
      ),
    }));
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    await cap({ root: document.body });
    expect(typeof capturedFilter).toBe('function');
    // SDK root nodes are filtered out:
    const sdkRoot = document.createElement('div');
    sdkRoot.setAttribute('data-traceitx-skip-capture', 'true');
    expect(capturedFilter!(sdkRoot)).toBe(false);
    // Customer-app nodes pass through:
    const userNode = document.createElement('div');
    expect(capturedFilter!(userNode)).toBe(true);
    const userNodeWithTestId = document.createElement('div');
    userNodeWithTestId.setAttribute('data-testid', 'user-app-root');
    expect(capturedFilter!(userNodeWithTestId)).toBe(true);
    vi.doUnmock('modern-screenshot');
  });

  it('threads cspNonce onto dynamically-inserted <style> elements', async () => {
    const { stub } = makeCanvasStub();
    vi.doMock('modern-screenshot', () => ({
      domToCanvas: vi.fn(async () => {
        const s = document.createElement('style');
        s.textContent = '.x{}';
        document.head.appendChild(s);
        await new Promise((resolve) => setTimeout(resolve, 0));
        return stub;
      }),
    }));
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    await cap({ root: document.body, cspNonce: 'NONCE-X' });
    const stamped = document.head.querySelectorAll('style[nonce="NONCE-X"]');
    expect(stamped.length).toBeGreaterThanOrEqual(1);
    vi.doUnmock('modern-screenshot');
  });

  it('returns a transparent placeholder and screenshot_failed when modern-screenshot throws', async () => {
    vi.doMock('modern-screenshot', () => ({
      domToCanvas: vi.fn(() => {
        throw new Error('capture failed');
      }),
    }));
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    let captured: string | undefined;
    const r = await cap({
      root: document.body,
      __setDegradedReason: (reason) => {
        captured = reason;
      },
    });
    expect(captured).toBe(DEGRADED_REASONS.screenshot_failed);
    expect(r.blob).toBeInstanceOf(Blob);
    expect(new Uint8Array(await r.blob.arrayBuffer())).toEqual(PNG_BYTES);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    vi.doUnmock('modern-screenshot');
  });

  it('never passes a clone-root style/margin override to modern-screenshot', async () => {
    // Regression lock for the clone-drift saga: overriding the clone root's
    // margin (style:{margin:'0'} or any equivalent) makes Chromium's SVG
    // rasterizer DROP absolutely/fixed-positioned elements anchored to the
    // initial containing block (toasts, FABs, portaled modals). The in-flow
    // drift is compensated at crop time instead (computeViewportCropRect).
    let modernOpts: { style?: Record<string, string> } | undefined;
    const { stub } = makeCanvasStub();
    vi.doMock('modern-screenshot', () => ({
      domToCanvas: vi.fn(async (_root: HTMLElement, opts: { style?: Record<string, string> }) => {
        modernOpts = opts;
        return stub;
      }),
    }));
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    await cap({ root: document.body });
    expect(modernOpts).toBeDefined();
    expect(modernOpts?.style).toBeUndefined();
    vi.doUnmock('modern-screenshot');
  });

  it('paints maskPlan rects on the FULL canvas before the viewport crop (root-relative space)', async () => {
    // Codex round-3 finding 1: the old pipeline masked the full-document blob
    // (root-relative device px) and cropped afterwards. Masking after the
    // crop paints at the wrong offset on scrolled pages — sensitive content
    // ships. The rects must land on the un-cropped canvas.
    const fillRects: number[][] = [];
    const ctx = {
      fillStyle: '#000000',
      fillRect: (...args: number[]) => fillRects.push(args),
      drawImage: () => undefined,
    };
    const stub = {
      width: 1280,
      height: 4000,
      getContext: () => ctx,
      toBlob: (cb: (b: Blob | null) => void, type?: string) =>
        cb(new Blob([PNG_BYTES], { type: type ?? 'image/png' })),
    } as unknown as HTMLCanvasElement;
    vi.doMock('modern-screenshot', () => ({ domToCanvas: vi.fn(async () => stub) }));
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    const r = await cap({
      root: document.body,
      // A rect deep in the document — far below any viewport.
      maskPlan: [{ x: 100, y: 2000, width: 50, height: 20 }],
    });
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Painted at the ROOT-relative position (2px safety inflation), on the
    // 4000px-tall canvas — not shifted into viewport space.
    expect(fillRects).toContainEqual([98, 1998, 54, 24]);
    vi.doUnmock('modern-screenshot');
  });

  it('scales maskPlan rects to the CAPPED ratio the canvas actually rendered at', async () => {
    // Codex round-4 finding: rects arrive in requested-DPR device px, but the
    // capture may render at a lower capped ratio — painting them verbatim
    // shifts the mask and exposes excluded pixels.
    const restore = stubUserAgent(WEBOS_UA);
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    Object.defineProperty(window, 'innerWidth', { value: 1920, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 1080, configurable: true });
    try {
      const fillRects: number[][] = [];
      const ctx = {
        fillStyle: '#000000',
        fillRect: (...args: number[]) => fillRects.push(args),
        drawImage: () => undefined,
      };
      const stub = {
        width: 1920,
        height: 1080,
        getContext: () => ctx,
        toBlob: (cb: (b: Blob | null) => void, type?: string) =>
          cb(new Blob([PNG_BYTES], { type: type ?? 'image/png' })),
      } as unknown as HTMLCanvasElement;
      vi.doMock('modern-screenshot', () => ({ domToCanvas: vi.fn(async () => stub) }));
      const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
      // Caller-space rect at dpr 2; the TV cap renders at ratio 1 → halve.
      await cap({ root: document.body, maskPlan: [{ x: 100, y: 2000, width: 50, height: 20 }] });
      expect(fillRects).toContainEqual([48, 998, 29, 14]);
      vi.doUnmock('modern-screenshot');
    } finally {
      restore();
      Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true });
    }
  });

  it('a raster finishing AFTER the deadline cannot relabel the placeholder with its dimensions', async () => {
    // Codex round-3 finding 6: the abandoned capture used to mutate outer
    // width/height when it eventually settled, so a late completion could
    // stamp full-screen dims onto the 1x1 degraded placeholder.
    vi.useFakeTimers();
    const { stub } = makeCanvasStub({ width: 1920, height: 1080 });
    vi.doMock('modern-screenshot', () => ({
      domToCanvas: vi.fn(
        () => new Promise((res) => setTimeout(() => res(stub), 15_000)),
      ),
    }));
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    const pending = cap({ root: document.body });
    await vi.advanceTimersByTimeAsync(11_000); // deadline fires
    await vi.advanceTimersByTimeAsync(5_000); // late raster settles
    const result = await pending;
    expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(PNG_BYTES);
    // Dims come from the placeholder decode (1x1 stub), never the late canvas.
    expect(result.width).toBe(1);
    expect(result.height).toBe(1);
    vi.useRealTimers();
    vi.doUnmock('modern-screenshot');
  });

  describe('computeViewportCropRect (clone-drift compensation math)', () => {
    it('offsets the source crop by the drift and keeps a full-viewport output', () => {
      // Live body margin 0 → clone drift 8 CSS px (measured on all engines).
      // Bitmap: 1280x1876 full-page render; unscrolled 1280x720 viewport.
      const r = computeViewportCropRect({
        bmWidth: 1280,
        bmHeight: 1876,
        scrollX: 0,
        scrollY: 0,
        innerWidth: 1280,
        innerHeight: 720,
        pixelRatio: 1,
        driftX: 8,
        driftY: 8,
      })!;
      expect(r).toMatchObject({ sx: 8, sy: 8, sw: 1272, sh: 720, outW: 1280, outH: 720 });
      expect(r.noop).toBe(false);
    });

    it('scales drift and scroll by pixelRatio', () => {
      const r = computeViewportCropRect({
        bmWidth: 2560,
        bmHeight: 3752,
        scrollX: 0,
        scrollY: 400,
        innerWidth: 1280,
        innerHeight: 720,
        pixelRatio: 2,
        driftX: 8,
        driftY: 8,
      })!;
      expect(r).toMatchObject({ sx: 16, sy: 816, sw: 2544, sh: 1440, outW: 2560, outH: 1440 });
    });

    it('clamps the source to the bitmap at the bottom edge (output stays viewport-sized, padded by caller)', () => {
      // Scrolled fully to the bottom: scrollY + vh + drift overruns the
      // bitmap by the drift — the source loses `drift` rows; outH keeps 720.
      const r = computeViewportCropRect({
        bmWidth: 1280,
        bmHeight: 1876,
        scrollX: 0,
        scrollY: 1156, // 1876 - 720
        innerWidth: 1280,
        innerHeight: 720,
        pixelRatio: 1,
        driftX: 8,
        driftY: 8,
      })!;
      expect(r).toMatchObject({ sx: 8, sy: 1164, sw: 1272, sh: 712, outW: 1280, outH: 720 });
    });

    it('is a noop for an exact-fit bitmap with no drift', () => {
      const r = computeViewportCropRect({
        bmWidth: 1280,
        bmHeight: 720,
        scrollX: 0,
        scrollY: 0,
        innerWidth: 1280,
        innerHeight: 720,
        pixelRatio: 1,
      })!;
      expect(r.noop).toBe(true);
    });

    it('returns null when the crop misses the bitmap entirely (1x1 fallback PNG)', () => {
      expect(
        computeViewportCropRect({
          bmWidth: 1,
          bmHeight: 1,
          scrollX: 500,
          scrollY: 500,
          innerWidth: 1280,
          innerHeight: 720,
          pixelRatio: 1,
        }),
      ).toBeNull();
    });
  });
});

describe('captureScreenshot — TV capture profile', () => {
  let restoreUa: (() => void) | null = null;

  beforeEach(() => {
    document.body.innerHTML = '<div style="width: 200px; height: 100px;">hello</div>';
    if (typeof globalThis.createImageBitmap !== 'function') {
      globalThis.createImageBitmap = (async () => ({
        width: 1,
        height: 1,
        close: () => undefined,
      })) as typeof createImageBitmap;
    }
  });
  afterEach(() => {
    restoreUa?.();
    restoreUa = null;
    vi.restoreAllMocks();
    vi.resetModules();
    document.body.innerHTML = '';
  });

  function sizeRoot(width: number, height: number): void {
    Object.defineProperty(document.body, 'clientWidth', { value: width, configurable: true });
    Object.defineProperty(document.body, 'clientHeight', { value: height, configurable: true });
  }

  it('caps the render scale so output stays at 1920 on a dpr-2 TV', async () => {
    restoreUa = stubUserAgent(WEBOS_UA);
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    Object.defineProperty(window, 'innerWidth', { value: 1920, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 1080, configurable: true });
    sizeRoot(1920, 1080);
    let capturedScale: number | undefined;
    const { stub } = makeCanvasStub();
    vi.doMock('modern-screenshot', () => ({
      domToCanvas: vi.fn(async (_root: HTMLElement, opts: { scale?: number }) => {
        capturedScale = opts.scale;
        return stub;
      }),
    }));
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    await cap({ root: document.body });
    expect(capturedScale).toBe(1);
    vi.doUnmock('modern-screenshot');
  });

  it('caps against the VIEWPORT, not the document — a long page keeps full viewport resolution', async () => {
    // Codex round-2 finding 5: the output bitmap is cropped to the viewport,
    // so the cap must measure the viewport. Computing it from the document
    // (body.clientHeight = 10,000px here) shrank the ratio to ~0.19 and made
    // long-page reports unreadable.
    restoreUa = stubUserAgent(WEBOS_UA);
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    Object.defineProperty(window, 'innerWidth', { value: 1920, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 1080, configurable: true });
    sizeRoot(1920, 10_000);
    let capturedScale: number | undefined;
    const { stub } = makeCanvasStub();
    vi.doMock('modern-screenshot', () => ({
      domToCanvas: vi.fn(async (_root: HTMLElement, opts: { scale?: number }) => {
        capturedScale = opts.scale;
        return stub;
      }),
    }));
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    await cap({ root: document.body });
    expect(capturedScale).toBe(1);
    vi.doUnmock('modern-screenshot');
  });

  it('prunes only OUT-OF-FLOW offscreen subtrees on TV — in-flow nodes would reflow the clone', async () => {
    // Field bug (rep111/rep1111): pruning any offscreen node removed content
    // from the screenshot, because deleting an in-flow node reflows its
    // siblings and shifts the rest of the page out of the cropped region.
    // Only absolutely/fixed positioned subtrees can be dropped safely — and
    // only when nothing inside them is visible, since virtualized lists park
    // a container far offscreen while its children are transformed into view
    // (measured on the LG: a div at y=-4252 holding 1091 visible descendants).
    restoreUa = stubUserAgent(WEBOS_UA);
    Object.defineProperty(window, 'innerWidth', { value: 1920, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 1080, configurable: true });

    const make = (position: string, top: number, height: number) => {
      const el = document.createElement('div');
      el.style.position = position;
      el.getBoundingClientRect = () =>
        ({ top, bottom: top + height, left: 0, right: 100, width: 100, height }) as DOMRect;
      return el;
    };
    const offscreenAbs = make('absolute', 5000, 100);
    const offscreenInFlow = make('relative', 5000, 100);
    const onscreenAbs = make('absolute', 100, 100);
    // Virtualized container: parked far offscreen, holds a visible child.
    const parkedContainer = make('absolute', -4252, 1080);
    parkedContainer.appendChild(make('absolute', 200, 100));
    document.body.append(offscreenAbs, offscreenInFlow, onscreenAbs, parkedContainer);

    let filter: ((n: Node) => boolean) | undefined;
    const { stub } = makeCanvasStub();
    vi.doMock('modern-screenshot', () => ({
      domToCanvas: vi.fn(async (_r: HTMLElement, opts: { filter?: (n: Node) => boolean }) => {
        filter = opts.filter;
        return stub;
      }),
    }));
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    await cap({ root: document.body });

    expect(filter!(offscreenAbs)).toBe(false);
    expect(filter!(offscreenInFlow)).toBe(true);
    expect(filter!(onscreenAbs)).toBe(true);
    expect(filter!(parkedContainer)).toBe(true);
    expect(filter!(document.createTextNode('x'))).toBe(true);
    vi.doUnmock('modern-screenshot');
  });

  it('prunes offscreen out-of-flow subtrees off TV too', async () => {
    // Desktop used to clone the whole document. It no longer does: the clone
    // walk is `nodes x properties` and the result is cropped to the viewport on
    // every tier, so offscreen nodes were always pure cost. Measured on a
    // react-native-web app in desktop Chrome, 81% of nodes sat in fully-
    // offscreen out-of-flow subtrees, because that framework keeps visited
    // screens mounted — an image-light settings page paid the same 1.6s clone
    // as the image-heavy home page whose rails were still in the DOM.
    //
    // The safety rules are identical to the TV case above and are what make
    // this safe to widen: out-of-flow only (no sibling reflow), and visibility
    // judged across the WHOLE subtree (a parked virtualized container whose
    // children are transformed into view is kept).
    Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });

    const make = (position: string, top: number, height: number) => {
      const el = document.createElement('div');
      el.style.position = position;
      el.getBoundingClientRect = () =>
        ({ top, bottom: top + height, left: 0, right: 100, width: 100, height }) as DOMRect;
      return el;
    };
    const offscreenAbs = make('absolute', 5000, 100);
    const offscreenInFlow = make('relative', 5000, 100);
    const onscreenAbs = make('absolute', 100, 100);
    const parkedContainer = make('absolute', -4252, 800);
    parkedContainer.appendChild(make('absolute', 200, 100));
    document.body.append(offscreenAbs, offscreenInFlow, onscreenAbs, parkedContainer);

    let filter: ((n: Node) => boolean) | undefined;
    const { stub } = makeCanvasStub();
    vi.doMock('modern-screenshot', () => ({
      domToCanvas: vi.fn(async (_r: HTMLElement, opts: { filter?: (n: Node) => boolean }) => {
        filter = opts.filter;
        return stub;
      }),
    }));
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    await cap({ root: document.body });

    expect(filter!(offscreenAbs)).toBe(false);
    expect(filter!(offscreenInFlow)).toBe(true);
    expect(filter!(onscreenAbs)).toBe(true);
    expect(filter!(parkedContainer)).toBe(true);
    vi.doUnmock('modern-screenshot');
  });

  it('passes fast-clone options (font off + style whitelist) on TV', async () => {
    restoreUa = stubUserAgent(WEBOS_UA);
    let capturedOpts: { font?: unknown; includeStyleProperties?: unknown } | undefined;
    const { stub } = makeCanvasStub();
    vi.doMock('modern-screenshot', () => ({
      domToCanvas: vi.fn(async (_root: HTMLElement, opts: Record<string, unknown>) => {
        capturedOpts = opts;
        return stub;
      }),
    }));
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    await cap({ root: document.body });
    expect(capturedOpts?.font).toBe(false);
    expect(Array.isArray(capturedOpts?.includeStyleProperties)).toBe(true);
    vi.doUnmock('modern-screenshot');
  });

  it('keeps full-fidelity clone options off TV', async () => {
    let capturedOpts: { font?: unknown; includeStyleProperties?: unknown; scale?: number } | undefined;
    const { stub } = makeCanvasStub();
    vi.doMock('modern-screenshot', () => ({
      domToCanvas: vi.fn(async (_root: HTMLElement, opts: Record<string, unknown>) => {
        capturedOpts = opts;
        return stub;
      }),
    }));
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    await cap({ root: document.body });
    expect(capturedOpts?.font).toBeUndefined();
    expect(capturedOpts?.includeStyleProperties).toBeUndefined();
    vi.doUnmock('modern-screenshot');
  });

  it('encodes WebP-first on TV and reports the webp blob', async () => {
    restoreUa = stubUserAgent(WEBOS_UA);
    const { stub, toBlobCalls } = makeCanvasStub();
    vi.doMock('modern-screenshot', () => ({ domToCanvas: vi.fn(async () => stub) }));
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    const r = await cap({ root: document.body });
    expect(toBlobCalls[0]).toBe('image/webp');
    expect(r.blob.type).toBe('image/webp');
    vi.doUnmock('modern-screenshot');
  });

  it('falls back to PNG when the WebP encoder is unavailable', async () => {
    restoreUa = stubUserAgent(WEBOS_UA);
    const { stub, toBlobCalls } = makeCanvasStub({ refuseTypes: ['image/webp'] });
    vi.doMock('modern-screenshot', () => ({ domToCanvas: vi.fn(async () => stub) }));
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    const r = await cap({ root: document.body });
    expect(toBlobCalls).toEqual(['image/webp', 'image/png']);
    expect(r.blob.type).toBe('image/png');
    vi.doUnmock('modern-screenshot');
  });

  it('encodes WebP-first off TV as well (default profile)', async () => {
    // The relay hop re-encodes PNG→WebP anyway; encoding WebP at the source
    // saves that decode/encode round on every platform, not just TV.
    const { stub, toBlobCalls } = makeCanvasStub();
    vi.doMock('modern-screenshot', () => ({ domToCanvas: vi.fn(async () => stub) }));
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    const r = await cap({ root: document.body });
    expect(toBlobCalls[0]).toBe('image/webp');
    expect(r.blob.type).toBe('image/webp');
    vi.doUnmock('modern-screenshot');
  });

  it('caps the render scale on a dpr-2 desktop so output stays at 2560', async () => {
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    Object.defineProperty(window, 'innerWidth', { value: 2560, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 1440, configurable: true });
    let capturedScale: number | undefined;
    const { stub } = makeCanvasStub();
    vi.doMock('modern-screenshot', () => ({
      domToCanvas: vi.fn(async (_root: HTMLElement, opts: { scale?: number }) => {
        capturedScale = opts.scale;
        return stub;
      }),
    }));
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    await cap({ root: document.body });
    expect(capturedScale).toBe(1);
    vi.doUnmock('modern-screenshot');
  });
});

describe('captureScreenshot — deadline handling', () => {
  let restoreUa: (() => void) | null = null;

  beforeEach(() => {
    document.body.innerHTML = '<div style="width: 200px; height: 100px;">hello</div>';
    if (typeof globalThis.createImageBitmap !== 'function') {
      globalThis.createImageBitmap = (async () => ({
        width: 1,
        height: 1,
        close: () => undefined,
      })) as typeof createImageBitmap;
    }
  });
  afterEach(() => {
    restoreUa?.();
    restoreUa = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
    document.body.innerHTML = '';
  });

  it('degrades when the canvas encoder never calls back (encode is inside the deadline)', async () => {
    // Codex round-1 finding 1: a degraded engine's canvas.toBlob can simply
    // never invoke its callback. The deadline must cover the encode too, or
    // capture hangs forever and the reporter's Promise.all never settles.
    vi.useFakeTimers();
    const hungCanvas = {
      width: 200,
      height: 100,
      getContext: () => null,
      toBlob: (_cb: (b: Blob | null) => void) => undefined, // never calls back
    } as unknown as HTMLCanvasElement;
    vi.doMock('modern-screenshot', () => ({ domToCanvas: vi.fn(async () => hungCanvas) }));

    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    let degraded: string | undefined;
    const pending = cap({
      root: document.body,
      __setDegradedReason: (r) => {
        degraded = r;
      },
    });
    await vi.advanceTimersByTimeAsync(11_000);
    const result = await pending;

    expect(degraded).toBe(DEGRADED_REASONS.screenshot_failed);
    expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(PNG_BYTES);
    vi.doUnmock('modern-screenshot');
  });

  it('degrades when modern-screenshot blows its deadline', async () => {
    vi.useFakeTimers();
    vi.doMock('modern-screenshot', () => ({
      domToCanvas: vi.fn(() => new Promise(() => undefined)), // never settles
    }));

    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    let degraded: string | undefined;
    const pending = cap({
      root: document.body,
      __setDegradedReason: (r) => {
        degraded = r;
      },
    });
    await vi.advanceTimersByTimeAsync(11_000);
    const result = await pending;

    expect(degraded).toBe(DEGRADED_REASONS.screenshot_failed);
    expect(result.blob).toBeInstanceOf(Blob);
    expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(PNG_BYTES);
    vi.doUnmock('modern-screenshot');
  });

  it('gives TV captures 45s before the deadline fires', async () => {
    restoreUa = stubUserAgent(WEBOS_UA);
    vi.useFakeTimers();
    vi.doMock('modern-screenshot', () => ({
      domToCanvas: vi.fn(() => new Promise(() => undefined)), // never settles
    }));

    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    let degraded: string | undefined;
    const pending = cap({
      root: document.body,
      __setDegradedReason: (r) => {
        degraded = r;
      },
    });
    // The desktop deadline (10s) must NOT fire on a TV...
    await vi.advanceTimersByTimeAsync(11_000);
    expect(degraded).toBeUndefined();
    // ...nor the OLD 20s TV ceiling, which a real 686-node TV home screen
    // measured 19.2s against and tipped over at random (see TV_PROFILE).
    await vi.advanceTimersByTimeAsync(10_000);
    expect(degraded).toBeUndefined();
    // ...but the TV deadline (45s) must.
    await vi.advanceTimersByTimeAsync(25_000);
    const result = await pending;
    expect(degraded).toBe(DEGRADED_REASONS.screenshot_failed);
    expect(result.blob).toBeInstanceOf(Blob);
    vi.doUnmock('modern-screenshot');
  });
});

/**
 * Off-screen image skipping.
 *
 * modern-screenshot inlines every image in the clone as a data URI, which
 * means RE-REQUESTING it — the SVG it rasterises has no network access, so
 * embedding is the only way. On an image-heavy page that is the dominant
 * capture cost: measured on a TV app's home screen, 433 refetches against an
 * uncached image host took ~5s of an 8.4s capture, and every one of those
 * images was cropped away microseconds later.
 *
 * `fetchFn` receives only the URL, never the element, so visibility is
 * resolved in a pre-pass that maps URLs to the elements referencing them.
 * A URL is skipped ONLY when every element referencing it is outside the
 * viewport; anything unseen (stylesheet backgrounds, fonts) falls through to
 * the normal fetch, so an unrecognised resource can never be dropped.
 */
describe('captureScreenshot — off-screen image skipping', () => {
  const ON = 'https://cdn.example.com/on-screen.jpg';
  const OFF = 'https://cdn.example.com/off-screen.jpg';
  const SHARED = 'https://cdn.example.com/shared.jpg';

  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    document.body.innerHTML = '';
    if (typeof globalThis.createImageBitmap !== 'function') {
      globalThis.createImageBitmap = (async () => ({
        width: 1,
        height: 1,
        close: () => undefined,
      })) as typeof createImageBitmap;
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    document.body.innerHTML = '';
  });

  /** An <img> whose rect places it inside or far below the viewport. */
  function addImage(src: string, top: number): HTMLImageElement {
    const img = document.createElement('img');
    img.src = src;
    img.getBoundingClientRect = () =>
      ({ top, bottom: top + 100, left: 0, right: 100, width: 100, height: 100 }) as DOMRect;
    document.body.appendChild(img);
    return img;
  }

  async function captureAndGetFetchFn(): Promise<(url: string) => Promise<string | false>> {
    let fetchFn: ((url: string) => Promise<string | false>) | undefined;
    const { stub } = makeCanvasStub();
    vi.doMock('modern-screenshot', () => ({
      domToCanvas: vi.fn(
        async (_r: HTMLElement, opts: { fetchFn?: (url: string) => Promise<string | false> }) => {
          fetchFn = opts.fetchFn;
          return stub;
        },
      ),
    }));
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    await cap({ root: document.body });
    vi.doUnmock('modern-screenshot');
    expect(fetchFn).toBeTypeOf('function');
    return fetchFn!;
  }

  it('short-circuits an image referenced only by an off-screen element', async () => {
    addImage(ON, 100);
    addImage(OFF, 5000);
    const fetchFn = await captureAndGetFetchFn();
    await expect(fetchFn(OFF)).resolves.toMatch(/^data:image\//);
  });

  it('still fetches an image that is on screen', async () => {
    addImage(ON, 100);
    addImage(OFF, 5000);
    const fetchFn = await captureAndGetFetchFn();
    await expect(fetchFn(ON)).resolves.toBe(false);
  });

  it('does NOT skip a URL shared by an on-screen and an off-screen element', async () => {
    addImage(SHARED, 5000);
    addImage(SHARED, 100);
    addImage(OFF, 5000);
    const fetchFn = await captureAndGetFetchFn();
    await expect(fetchFn(SHARED)).resolves.toBe(false);
    await expect(fetchFn(OFF)).resolves.toMatch(/^data:image\//);
  });

  it('never skips a URL it did not see — fonts and stylesheet backgrounds fall through', async () => {
    addImage(OFF, 5000);
    const fetchFn = await captureAndGetFetchFn();
    await expect(fetchFn('https://cdn.example.com/fonts/inter.woff2')).resolves.toBe(false);
  });

  it('installs no fetchFn when nothing is skippable, leaving default fetching untouched', async () => {
    addImage(ON, 100);
    let opts: Record<string, unknown> | undefined;
    const { stub } = makeCanvasStub();
    vi.doMock('modern-screenshot', () => ({
      domToCanvas: vi.fn(async (_r: HTMLElement, o: Record<string, unknown>) => {
        opts = o;
        return stub;
      }),
    }));
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    await cap({ root: document.body });
    expect(opts).not.toHaveProperty('fetchFn');
    vi.doUnmock('modern-screenshot');
  });
});
