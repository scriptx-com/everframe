// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeViewportCropRect } from '../../src/capture/screenshot.js';
import { DEGRADED_REASONS } from '../../src/internal/degraded-reasons.js';

/** Existing modern-screenshot assertions now describe the FALLBACK renderer. */
function mockSnapdomUnavailable(): void {
  vi.doMock('@zumer/snapdom', () => ({
    snapdom: vi.fn(async () => {
      throw new Error('snapdom unavailable (test)');
    }),
  }));
}

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
    mockSnapdomUnavailable();
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
    vi.doUnmock('@zumer/snapdom');
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

  it('passes a filter that excludes nodes tagged data-everframe-skip-capture', async () => {
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
    sdkRoot.setAttribute('data-everframe-skip-capture', 'true');
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

  describe('fails closed when a mask has no finite position (Chrome < 61 ClientRect)', () => {
    function fillCanvas(fills: number[][]): HTMLCanvasElement {
      const ctx = { fillStyle: '#000000', fillRect: (...a: number[]) => fills.push(a), drawImage: () => undefined, save: () => undefined, restore: () => undefined, setTransform: () => undefined };
      return {
        width: 800, height: 600,
        getContext: () => ctx,
        toBlob: (cb: (b: Blob | null) => void, type?: string) => cb(new Blob([PNG_BYTES], { type: type ?? 'image/png' })),
      } as unknown as HTMLCanvasElement;
    }

    it('a non-finite maskPlan rect degrades to the placeholder (screenshot_failed), never paints nothing and ships', async () => {
      const fills: number[][] = [];
      vi.doMock('modern-screenshot', () => ({ domToCanvas: vi.fn(async () => fillCanvas(fills)) }));
      const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
      let degraded: string | undefined;
      const r = await cap({
        root: document.body,
        maskPlan: [{ x: Number.NaN, y: Number.NaN, width: 50, height: 20 }],
        __setDegradedReason: (d) => { degraded = d; },
      });
      expect(degraded).toBe(DEGRADED_REASONS.screenshot_failed);
      expect(new Uint8Array(await r.blob.arrayBuffer())).toEqual(PNG_BYTES);
      expect(fills.some((f) => f.some((n) => !Number.isFinite(n)))).toBe(false);
      vi.doUnmock('modern-screenshot');
    });

    it('a sensitive element whose client rect has no finite position fails the shot (screenshot_failed)', async () => {
      const fills: number[][] = [];
      vi.doMock('modern-screenshot', () => ({ domToCanvas: vi.fn(async () => fillCanvas(fills)) }));
      const secret = document.createElement('div');
      secret.setAttribute('data-everframe-sensitive', '');
      secret.textContent = 'SECRET';
      document.body.appendChild(secret);
      const broken = { width: 120, height: 30 } as DOMRect; // no left/top/x/y at all
      secret.getClientRects = () => [broken] as unknown as DOMRectList;
      secret.getBoundingClientRect = () => broken;
      try {
        const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
        let degraded: string | undefined;
        const r = await cap({
          root: document.body,
          isSensitive: (el) => el.hasAttribute('data-everframe-sensitive'),
          __setDegradedReason: (d) => { degraded = d; },
        });
        expect(degraded).toBe(DEGRADED_REASONS.screenshot_failed);
        expect(new Uint8Array(await r.blob.arrayBuffer())).toEqual(PNG_BYTES);
      } finally {
        secret.remove();
        vi.doUnmock('modern-screenshot');
      }
    });

    it('a Chrome 53 ClientRect (left/top, no x/y) on a sensitive element is masked where it is', async () => {
      const fills: number[][] = [];
      vi.doMock('modern-screenshot', () => ({ domToCanvas: vi.fn(async () => fillCanvas(fills)) }));
      const secret = document.createElement('div');
      secret.setAttribute('data-everframe-sensitive', '');
      document.body.appendChild(secret);
      const clientRect = { left: 40, top: 30, right: 160, bottom: 60, width: 120, height: 30 } as DOMRect;
      secret.getClientRects = () => [clientRect] as unknown as DOMRectList;
      secret.getBoundingClientRect = () => clientRect;
      try {
        const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
        let degraded: string | undefined;
        await cap({
          root: document.body,
          pixelRatio: 1,
          isSensitive: (el) => el.hasAttribute('data-everframe-sensitive'),
          __setDegradedReason: (d) => { degraded = d; },
        });
        expect(degraded).toBeUndefined();
        expect(fills).toContainEqual([38, 28, 124, 34]);
      } finally {
        secret.remove();
        vi.doUnmock('modern-screenshot');
      }
    });
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
    mockSnapdomUnavailable();
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
    vi.doUnmock('@zumer/snapdom');
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
    mockSnapdomUnavailable();
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
    vi.doUnmock('@zumer/snapdom');
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
    mockSnapdomUnavailable();
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
    vi.doUnmock('@zumer/snapdom');
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

describe('captureScreenshot — snapdom primary with fallback', () => {
  const blankState = { value: false as boolean | null };

  beforeEach(() => {
    document.body.innerHTML = '<div style="width:200px;height:100px">hello</div>';
    blankState.value = false;
    vi.doMock('../../src/capture/blank-check.js', () => ({
      isCanvasBlank: vi.fn(() => blankState.value),
    }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('@zumer/snapdom');
    vi.doUnmock('modern-screenshot');
    vi.doUnmock('../../src/capture/blank-check.js');
    document.body.innerHTML = '';
  });

  function mockSnapdom(canvas: HTMLCanvasElement) {
    const snapdom = vi.fn(async () => ({ toCanvas: async () => canvas }));
    vi.doMock('@zumer/snapdom', () => ({ snapdom }));
    return snapdom;
  }
  function mockModern(canvas: HTMLCanvasElement) {
    const domToCanvas = vi.fn(async () => canvas);
    vi.doMock('modern-screenshot', () => ({ domToCanvas }));
    return domToCanvas;
  }

  it('uses snapdom and never loads modern-screenshot when snapdom succeeds', async () => {
    const { stub } = makeCanvasStub({ width: 300, height: 150 });
    mockSnapdom(stub);
    const domToCanvas = mockModern(makeCanvasStub().stub);
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    let renderer: string | undefined;
    const r = await cap({ root: document.body, __setRenderer: (x) => { renderer = x; } });
    expect(renderer).toBe('snapdom');
    expect(domToCanvas).not.toHaveBeenCalled();
    expect(r.width).toBe(300);
    expect(r.height).toBe(150);
  });

  it('puts the videos back when resolving mask targets throws after the stand-ins went in', async () => {
    document.body.innerHTML = '<video id="v"></video>';
    const video = document.getElementById('v') as HTMLVideoElement;
    let installed = 0;
    vi.resetModules();
    vi.doMock('../../src/capture/video-frames.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../../src/capture/video-frames.js')>();
      return {
        ...real,
        // What the real installer does to a visible video: hide it, stand-in after it.
        installVideoStandIns: vi.fn(async () => {
          installed += 1;
          const prev = video.getAttribute('style');
          video.style.setProperty('display', 'none', 'important');
          const standIn = document.createElement('div');
          standIn.setAttribute(real.STAND_IN_ATTR, '');
          video.after(standIn);
          return () => {
            standIn.remove();
            if (prev === null) video.removeAttribute('style');
            else video.setAttribute('style', prev);
          };
        }),
      };
    });
    mockSnapdom(makeCanvasStub().stub);
    mockModern(makeCanvasStub().stub);
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    let calls = 0;
    const maskTargets = (): Element[] => {
      calls += 1;
      if (calls >= 2) throw new Error('registry exploded');
      return [];
    };
    let err: string | undefined;
    let reason: string | undefined;
    await cap({ root: document.body, maskTargets, __setDegradedReason: (x) => { reason = x; } }).catch((e) => { err = String(e); });
    vi.doUnmock('../../src/capture/video-frames.js');
    expect(installed).toBe(1);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(video.getAttribute('style')).toBeNull();
    expect(document.querySelectorAll('[data-everframe-video-stand-in], video + *').length).toBe(0);
    expect(err).toBeUndefined(); // the placeholder ships instead of a rejection
    expect(reason).toBe(DEGRADED_REASONS.screenshot_failed);
  });

  it('falls back to modern-screenshot when snapdom throws, without a degraded reason', async () => {
    vi.doMock('@zumer/snapdom', () => ({ snapdom: vi.fn(async () => { throw new Error('nope'); }) }));
    const domToCanvas = mockModern(makeCanvasStub().stub);
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    let renderer: string | undefined;
    let reason: string | undefined;
    await cap({ root: document.body, __setRenderer: (x) => { renderer = x; }, __setDegradedReason: (x) => { reason = x; } });
    expect(domToCanvas).toHaveBeenCalledTimes(1);
    expect(renderer).toBe('modern-screenshot');
    expect(reason).toBeUndefined();
  });

  it('falls back when snapdom returns a blank canvas', async () => {
    mockSnapdom(makeCanvasStub().stub);
    const domToCanvas = mockModern(makeCanvasStub().stub);
    const blank = await import('../../src/capture/blank-check.js');
    (blank.isCanvasBlank as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(true)   // snapdom canvas
      .mockReturnValueOnce(false); // fallback canvas
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    let renderer: string | undefined;
    await cap({ root: document.body, __setRenderer: (x) => { renderer = x; } });
    expect(domToCanvas).toHaveBeenCalledTimes(1);
    expect(renderer).toBe('modern-screenshot');
  });

  it('ships the image but flags screenshot_blank when both renderers are blank', async () => {
    mockSnapdom(makeCanvasStub({ width: 320, height: 200 }).stub);
    mockModern(makeCanvasStub({ width: 10, height: 10 }).stub);
    blankState.value = true;
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    let reason: string | undefined;
    let renderer: string | undefined;
    const r = await cap({ root: document.body, __setDegradedReason: (x) => { reason = x; }, __setRenderer: (x) => { renderer = x; } });
    expect(reason).toBe(DEGRADED_REASONS.screenshot_blank);
    // The first (primary) blank attempt is the one shipped — a truly empty page is not data loss.
    expect(renderer).toBe('snapdom');
    expect(r.width).toBe(320);
  });

  it('overlapping captures each return their OWN degraded reason on the result', async () => {
    const canvasA = makeCanvasStub({ width: 300, height: 150 }).stub;
    const canvasB = makeCanvasStub({ width: 300, height: 150 }).stub;
    const modernA = makeCanvasStub({ width: 300, height: 150 }).stub;
    const releases: Array<() => void> = [];
    const canvases = [canvasA, canvasB];
    vi.doMock('@zumer/snapdom', () => ({
      snapdom: vi.fn(() => {
        const canvas = canvases[releases.length]!;
        return new Promise((resolve) => releases.push(() => resolve({ toCanvas: async () => canvas })));
      }),
    }));
    mockModern(modernA);
    const blank = await import('../../src/capture/blank-check.js');
    // A: both renderers blank. B: clean.
    (blank.isCanvasBlank as ReturnType<typeof vi.fn>).mockImplementation((c: unknown) => c === canvasA || c === modernA);
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    const shared: Array<string | undefined> = [];
    const setShared = (r: string): void => { shared.push(r); };
    const a = cap({ root: document.body, __setDegradedReason: setShared });
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const b = cap({ root: document.body, __setDegradedReason: setShared });
    // snapDOM runs are serialized: B's snapDOM starts only once A's settles,
    // while the two captures themselves still overlap.
    releases[0]!();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]!();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.degradedReason).toBe(DEGRADED_REASONS.screenshot_blank);
    expect(rb.degradedReason).toBeUndefined();
    expect('degradedReason' in rb).toBe(false);
  });

  it('puts screenshot_failed on the placeholder result', async () => {
    vi.doMock('@zumer/snapdom', () => ({ snapdom: vi.fn(async () => { throw new Error('a'); }) }));
    vi.doMock('modern-screenshot', () => ({ domToCanvas: vi.fn(async () => { throw new Error('b'); }) }));
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    const r = await cap({ root: document.body });
    expect(r.degradedReason).toBe(DEGRADED_REASONS.screenshot_failed);
  });

  it('treats an unavailable blank check (null) as not blank', async () => {
    const { stub } = makeCanvasStub();
    mockSnapdom(stub);
    const domToCanvas = mockModern(makeCanvasStub().stub);
    blankState.value = null;
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    await cap({ root: document.body });
    expect(domToCanvas).not.toHaveBeenCalled();
  });

  it('degrades to the placeholder with screenshot_failed when both renderers throw', async () => {
    vi.doMock('@zumer/snapdom', () => ({ snapdom: vi.fn(async () => { throw new Error('a'); }) }));
    vi.doMock('modern-screenshot', () => ({ domToCanvas: vi.fn(async () => { throw new Error('b'); }) }));
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    let reason: string | undefined;
    let renderer: string | undefined;
    const r = await cap({ root: document.body, __setDegradedReason: (x) => { reason = x; }, __setRenderer: (x) => { renderer = x; } });
    expect(reason).toBe(DEGRADED_REASONS.screenshot_failed);
    expect(renderer).toBe('none');
    expect(new Uint8Array(await r.blob.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it('still runs the fallback when snapdom never settles, within deadline + encode floor', async () => {
    vi.useFakeTimers();
    try {
      vi.doMock('@zumer/snapdom', () => ({ snapdom: vi.fn(() => new Promise(() => undefined)) }));
      const domToCanvas = mockModern(makeCanvasStub().stub);
      const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
      let renderer: string | undefined;
      const p = cap({ root: document.body, __setRenderer: (x) => { renderer = x; } });
      await vi.advanceTimersByTimeAsync(10_000 * 0.6 + 1);
      await vi.advanceTimersByTimeAsync(10_000);
      await p;
      expect(domToCanvas).toHaveBeenCalledTimes(1);
      expect(renderer).toBe('modern-screenshot');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a capture that finds a never-settling snapDOM run skips snapDOM and falls back (off TV)', async () => {
    vi.useFakeTimers();
    try {
      const snapdom = vi.fn(() => new Promise(() => undefined));
      vi.doMock('@zumer/snapdom', () => ({ snapdom }));
      const domToCanvas = mockModern(makeCanvasStub().stub);
      const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
      // screenshot.ts loads the snapDOM renderer lazily: have it loaded, so
      // A reaches snapDOM within the zero-time advance below.
      await import('../../src/capture/renderers/snapdom-renderer.js');
      const renderers: string[] = [];
      const a = cap({ root: document.body, __setRenderer: (x) => { renderers.push(`a:${x}`); } });
      await vi.advanceTimersByTimeAsync(0);
      expect(snapdom).toHaveBeenCalledTimes(1);
      const b = cap({ root: document.body, __setRenderer: (x) => { renderers.push(`b:${x}`); } });
      await vi.advanceTimersByTimeAsync(10_000 * 0.6 + 1);
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.all([a, b]);
      expect(snapdom).toHaveBeenCalledTimes(1); // B never started a second snapDOM run
      expect(domToCanvas).toHaveBeenCalledTimes(2);
      expect(renderers.sort()).toEqual(['a:modern-screenshot', 'b:modern-screenshot']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('paints legacy maskPlan rects offset by scroll on the viewport-cropped snapdom canvas', async () => {
    const fills: Array<[number, number, number, number]> = [];
    const canvas = {
      width: 200, height: 100,
      getContext: () => ({ fillStyle: '', fillRect: (x: number, y: number, w: number, h: number) => fills.push([x, y, w, h]) }),
      toBlob: (cb: (b: Blob | null) => void, type?: string) => cb(new Blob([PNG_BYTES], { type: type ?? 'image/png' })),
    } as unknown as HTMLCanvasElement;
    mockSnapdom(canvas);
    // A margin-0 <body> scrolled by 300 sits at viewport top -300 (jsdom has no layout).
    vi.spyOn(document.body, 'getBoundingClientRect').mockReturnValue({ left: 0, top: -300 } as DOMRect);
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    await cap({ root: document.body, pixelRatio: 1, maskPlan: [{ x: 10, y: 320, width: 50, height: 20 }] });
    // Root-relative y=320 at scrollY=300 lands at viewport y=20 (minus the 2px inflation).
    expect(fills).toContainEqual([8, 18, 54, 24]);
  });

  it('maps maskPlan through a custom root\'s viewport position (not just the window scroll)', async () => {
    const fills: Array<[number, number, number, number]> = [];
    mockSnapdom(makeFillRecordingCanvas(fills, 800, 600));
    const root = document.createElement('div');
    document.body.appendChild(root);
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ left: 200, top: 100, width: 300, height: 200 } as DOMRect);
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    // Sensitive box at root-relative (0,0), 40x20; ratio 2 on both sides.
    await cap({ root, pixelRatio: 2, maskPlan: [{ x: 0, y: 0, width: 80, height: 40 }] });
    // snapDOM draws the root at viewport (200,100) => device (400,200); minus the 2px inflation.
    expect(fills).toEqual([[398, 198, 84, 44]]);
  });

  /** Canvas stub whose 2d context records mask fills, so tests can see paint order. */
  function makeFillRecordingCanvas(fills: Array<[number, number, number, number]>, width = 200, height = 100) {
    return {
      width, height,
      getContext: () => ({ fillStyle: '', fillRect: (x: number, y: number, w: number, h: number) => fills.push([x, y, w, h]) }),
      toBlob: (cb: (b: Blob | null) => void, type?: string) => cb(new Blob([PNG_BYTES], { type: type ?? 'image/png' })),
    } as unknown as HTMLCanvasElement;
  }

  it('blank-checks the snapdom canvas BEFORE painting maskPlan, so a masked flat canvas still falls back', async () => {
    const fills: Array<[number, number, number, number]> = [];
    mockSnapdom(makeFillRecordingCanvas(fills));
    const domToCanvas = mockModern(makeCanvasStub().stub);
    const fillsAtCheck: number[] = [];
    const blank = await import('../../src/capture/blank-check.js');
    (blank.isCanvasBlank as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => { fillsAtCheck.push(fills.length); return true; }) // snapdom canvas
      .mockImplementationOnce(() => false); // fallback canvas
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    let renderer: string | undefined;
    let reason: string | undefined;
    await cap({
      root: document.body,
      pixelRatio: 1,
      maskPlan: [{ x: 10, y: 20, width: 50, height: 20 }],
      __setRenderer: (x) => { renderer = x; },
      __setDegradedReason: (x) => { reason = x; },
    });
    expect(fillsAtCheck).toEqual([0]);
    expect(fills.length).toBeGreaterThan(0); // the mask was still painted on the snapdom canvas
    expect(domToCanvas).toHaveBeenCalledTimes(1);
    expect(renderer).toBe('modern-screenshot');
    expect(reason).toBeUndefined();
  });

  it('fails closed when the root moves during the render: the masked snapDOM canvas is not shipped (off TV -> fallback)', async () => {
    const fills: Array<[number, number, number, number]> = [];
    const canvas = makeFillRecordingCanvas(fills);
    let bodyTop = -300; // margin-0 <body> at scrollY 300
    vi.spyOn(document.body, 'getBoundingClientRect').mockImplementation(() => ({ left: 0, top: bodyTop }) as DOMRect);
    vi.doMock('@zumer/snapdom', () => ({
      snapdom: vi.fn(async () => {
        // The user scrolls while snapDOM (fast:false) yields mid-render; snapDOM
        // may have re-cloned at the new position, so the origin is unknowable.
        bodyTop = -700;
        return { toCanvas: async () => canvas };
      }),
    }));
    const domToCanvas = mockModern(makeCanvasStub().stub);
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    let renderer: string | undefined;
    await cap({
      root: document.body,
      pixelRatio: 1,
      maskPlan: [{ x: 10, y: 320, width: 50, height: 20 }],
      __setRenderer: (x) => { renderer = x; },
    });
    expect(fills).toEqual([]); // no mask painted at a guessed origin
    expect(domToCanvas).toHaveBeenCalledTimes(1);
    expect(renderer).toBe('modern-screenshot');
  });

  it('keeps the snapDOM canvas when the root did not move (no maskPlan-driven fallback)', async () => {
    const fills: Array<[number, number, number, number]> = [];
    mockSnapdom(makeFillRecordingCanvas(fills));
    vi.spyOn(document.body, 'getBoundingClientRect').mockReturnValue({ left: 0, top: -300 } as DOMRect);
    const domToCanvas = mockModern(makeCanvasStub().stub);
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    await cap({ root: document.body, pixelRatio: 1, maskPlan: [{ x: 10, y: 320, width: 50, height: 20 }] });
    expect(fills).toEqual([[8, 18, 54, 24]]);
    expect(domToCanvas).not.toHaveBeenCalled();
  });

  it('blank-checks the fallback on the viewport region it ships, not the whole document canvas', async () => {
    vi.doMock('@zumer/snapdom', () => ({ snapdom: vi.fn(async () => { throw new Error('nope'); }) }));
    const doc = makeCanvasStub({ width: 1024, height: 3000 }).stub;
    mockModern(doc);
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1024);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(768);
    Object.defineProperty(window, 'scrollY', { value: 500, configurable: true });
    const root = document.createElement('div'); // not <body>: no clone-drift term
    document.body.appendChild(root);
    try {
      const blank = await import('../../src/capture/blank-check.js');
      const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
      await cap({ root, pixelRatio: 1 });
      expect(blank.isCanvasBlank).toHaveBeenCalledWith(doc, { sx: 0, sy: 500, sw: 1024, sh: 768 });
      expect(blank.isCanvasBlank).not.toHaveBeenCalledWith(doc);
    } finally {
      Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
    }
  });

  it('flags screenshot_blank when both renderers are blank even with maskPlan painted', async () => {
    const snapFills: Array<[number, number, number, number]> = [];
    const modernFills: Array<[number, number, number, number]> = [];
    mockSnapdom(makeFillRecordingCanvas(snapFills, 320, 200));
    const domToCanvas = mockModern(makeFillRecordingCanvas(modernFills));
    const fillsAtCheck: number[] = [];
    const blank = await import('../../src/capture/blank-check.js');
    (blank.isCanvasBlank as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => { fillsAtCheck.push(snapFills.length); return true; })
      .mockImplementationOnce(() => { fillsAtCheck.push(modernFills.length); return true; });
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    let renderer: string | undefined;
    let reason: string | undefined;
    const r = await cap({
      root: document.body,
      pixelRatio: 1,
      maskPlan: [{ x: 10, y: 20, width: 50, height: 20 }],
      __setRenderer: (x) => { renderer = x; },
      __setDegradedReason: (x) => { reason = x; },
    });
    expect(domToCanvas).toHaveBeenCalledTimes(1);
    // Both verdicts were taken on the raw, un-masked renders.
    expect(fillsAtCheck).toEqual([0, 0]);
    expect(modernFills.length).toBeGreaterThan(0);
    expect(reason).toBe(DEGRADED_REASONS.screenshot_blank);
    expect(renderer).toBe('snapdom');
    expect(r.width).toBe(320);
  });

  describe('TV profile: fallback only on a real snapDOM error', () => {
    let restoreUa: (() => void) | null = null;
    beforeEach(() => {
      restoreUa = stubUserAgent(WEBOS_UA);
    });
    afterEach(() => {
      restoreUa?.();
      restoreUa = null;
      vi.useRealTimers();
    });

    it('ships a blank snapdom canvas flagged screenshot_blank without running the fallback', async () => {
      mockSnapdom(makeCanvasStub({ width: 320, height: 200 }).stub);
      const domToCanvas = mockModern(makeCanvasStub().stub);
      blankState.value = true;
      const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
      let reason: string | undefined;
      let renderer: string | undefined;
      const r = await cap({ root: document.body, __setDegradedReason: (x) => { reason = x; }, __setRenderer: (x) => { renderer = x; } });
      expect(domToCanvas).not.toHaveBeenCalled();
      expect(reason).toBe(DEGRADED_REASONS.screenshot_blank);
      expect(renderer).toBe('snapdom');
      expect(r.width).toBe(320);
    });

    it('still falls back when snapdom throws a real error (Chrome-53-era TVs)', async () => {
      vi.doMock('@zumer/snapdom', () => ({
        snapdom: vi.fn(async () => {
          throw new TypeError('s.append is not a function');
        }),
      }));
      const domToCanvas = mockModern(makeCanvasStub().stub);
      const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
      let reason: string | undefined;
      let renderer: string | undefined;
      await cap({ root: document.body, __setDegradedReason: (x) => { reason = x; }, __setRenderer: (x) => { renderer = x; } });
      expect(domToCanvas).toHaveBeenCalledTimes(1);
      expect(renderer).toBe('modern-screenshot');
      expect(reason).toBeUndefined();
    });

    it('a root that moved during the render ships the placeholder with legacy masks (no fallback on TV)', async () => {
      let bodyTop = -300;
      vi.spyOn(document.body, 'getBoundingClientRect').mockImplementation(() => ({ left: 0, top: bodyTop }) as DOMRect);
      vi.doMock('@zumer/snapdom', () => ({
        snapdom: vi.fn(async () => {
          bodyTop = -700;
          return { toCanvas: async () => makeCanvasStub().stub };
        }),
      }));
      const domToCanvas = mockModern(makeCanvasStub().stub);
      const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
      const r = await cap({ root: document.body, maskPlan: [{ x: 10, y: 320, width: 50, height: 20 }] });
      expect(domToCanvas).not.toHaveBeenCalled();
      expect(r.degradedReason).toBe(DEGRADED_REASONS.screenshot_failed);
    });

    it('a capture that finds snapDOM still busy ships the placeholder without the fallback', async () => {
      vi.useFakeTimers();
      const snapdom = vi.fn(() => new Promise(() => undefined));
      vi.doMock('@zumer/snapdom', () => ({ snapdom }));
      const domToCanvas = mockModern(makeCanvasStub().stub);
      const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
      const reasons: string[] = [];
      const a = cap({ root: document.body });
      await vi.advanceTimersByTimeAsync(0);
      const b = cap({ root: document.body, __setDegradedReason: (x) => { reasons.push(x); } });
      // A times out and restores the page; B (queued behind it) then finds
      // A's abandoned snapDOM run still going for its whole primary budget.
      await vi.advanceTimersByTimeAsync(45_000 * 0.6 + 1);
      await vi.advanceTimersByTimeAsync(45_000 * 0.6 + 1);
      const [, rb] = await Promise.all([a, b]);
      expect(snapdom).toHaveBeenCalledTimes(1);
      expect(domToCanvas).not.toHaveBeenCalled(); // no second renderer on a TV CPU
      expect(reasons).toEqual([DEGRADED_REASONS.screenshot_failed]);
      expect(rb.degradedReason).toBe(DEGRADED_REASONS.screenshot_failed);
      expect(new Uint8Array(await rb.blob.arrayBuffer())).toEqual(PNG_BYTES);
    });

    it('degrades to the placeholder without the fallback when snapdom blows its deadline share', async () => {
      vi.useFakeTimers();
      vi.doMock('@zumer/snapdom', () => ({ snapdom: vi.fn(() => new Promise(() => undefined)) }));
      const domToCanvas = mockModern(makeCanvasStub().stub);
      const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
      let reason: string | undefined;
      let renderer: string | undefined;
      const p = cap({ root: document.body, __setDegradedReason: (x) => { reason = x; }, __setRenderer: (x) => { renderer = x; } });
      await vi.advanceTimersByTimeAsync(45_000 * 0.6 + 1);
      const r = await p;
      expect(domToCanvas).not.toHaveBeenCalled();
      expect(reason).toBe(DEGRADED_REASONS.screenshot_failed);
      expect(renderer).toBe('none');
      expect(new Uint8Array(await r.blob.arrayBuffer())).toEqual(PNG_BYTES);
    });
  });

  type MaskPlugin = { name: string; afterClone(ctx: { clone: Element; nodeMap: Map<Node, Node> }): void };
  /** Runs a mask plugin over a one-level clone of `host` built with a snapDOM-style nodeMap. */
  function cloneThroughPlugin(host: Element, plugin: MaskPlugin): Element {
    const nodeMap = new Map<Node, Node>();
    const clone = host.cloneNode(false) as Element;
    nodeMap.set(clone, host);
    for (const child of Array.from(host.children)) {
      const c = child.cloneNode(true) as Element;
      nodeMap.set(c, child);
      clone.appendChild(c);
    }
    plugin.afterClone({ clone, nodeMap });
    return clone;
  }

  it('snapDOM captures never touch the live element: masks are applied on the clone', async () => {
    const secret = document.createElement('div');
    secret.setAttribute('style', 'color: red');
    document.body.appendChild(secret);
    const stylesAtClone: Array<string | null> = [];
    const plugins: MaskPlugin[] = [];
    vi.doMock('@zumer/snapdom', () => ({
      snapdom: vi.fn(async (_r: HTMLElement, opts: { plugins?: MaskPlugin[] }) => {
        stylesAtClone.push(secret.getAttribute('style'));
        plugins.push(...(opts.plugins ?? []));
        return { toCanvas: async () => makeCanvasStub().stub };
      }),
    }));
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    await Promise.all([
      cap({ root: document.body, maskTargets: [secret] }),
      cap({ root: document.body, maskTargets: [secret] }),
    ]);
    expect(stylesAtClone).toEqual(['color: red', 'color: red']);
    expect(secret.getAttribute('style')).toBe('color: red');
    expect(plugins.map((p) => p.name)).toEqual(['everframe-clone-mask', 'everframe-clone-mask']);
    const clone = cloneThroughPlugin(document.body, plugins[0]!);
    expect(clone.querySelector('[style="color: red"]')).toBeNull(); // the sensitive clone was replaced
    secret.remove();
  });

  it('resolves function mask targets after the snapDOM admission wait: a replaced element is masked', async () => {
    const holder = document.createElement('div');
    let secret = document.createElement('div');
    secret.className = 'secret';
    holder.appendChild(secret);
    document.body.appendChild(holder);
    const releases: Array<() => void> = [];
    const plugins: MaskPlugin[] = [];
    vi.doMock('@zumer/snapdom', () => ({
      snapdom: vi.fn((_r: HTMLElement, opts: { plugins?: MaskPlugin[] }) => {
        plugins.push(...(opts.plugins ?? []));
        return new Promise((resolve) =>
          releases.push(() => resolve({ toCanvas: async () => makeCanvasStub().stub })),
        );
      }),
    }));
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    const resolver = vi.fn(() => Array.from(holder.querySelectorAll('.secret')));
    const a = cap({ root: document.body, maskTargets: resolver });
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const b = cap({ root: document.body, maskTargets: resolver });
    await new Promise((r) => setTimeout(r, 20));
    // The app replaces the sensitive element while B waits.
    const original = secret;
    secret = document.createElement('div');
    secret.className = 'secret';
    holder.replaceChild(secret, original);
    releases[0]!();
    await a;
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]!();
    await b;
    // B's plugin masks the replacement, not the detached original.
    const clone = cloneThroughPlugin(holder, plugins[1]!);
    expect(clone.querySelector('.secret')).toBeNull();
    expect(clone.firstElementChild!.getAttribute('style')).toContain('background: rgb(0, 0, 0)');
    expect(original.getAttribute('style')).toBeNull();
    expect(secret.getAttribute('style')).toBeNull(); // the live page is never touched
    holder.remove();
  });

  it('the modern-screenshot fallback masks the LIVE element only while it renders', async () => {
    const secret = document.createElement('div');
    secret.setAttribute('style', 'color: red');
    document.body.appendChild(secret);
    vi.doMock('@zumer/snapdom', () => ({ snapdom: vi.fn(async () => { throw new Error('nope'); }) }));
    let styleWhileRendering: string | null = null;
    vi.doMock('modern-screenshot', () => ({
      domToCanvas: vi.fn(async () => {
        styleWhileRendering = secret.getAttribute('style');
        return makeCanvasStub().stub;
      }),
    }));
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    await cap({ root: document.body, maskTargets: () => [secret] });
    expect(styleWhileRendering).toContain('background-color: #000 !important');
    expect(secret.getAttribute('style')).toBe('color: red');
    secret.remove();
  });

  it('a capture that out-waits a stuck earlier one ships the placeholder without touching the page', async () => {
    vi.useFakeTimers();
    try {
      // The earlier capture hangs inside its page-mutating section.
      vi.doMock('../../src/capture/video-frames.js', async (orig) => ({
        ...(await orig<typeof import('../../src/capture/video-frames.js')>()),
        installVideoStandIns: vi.fn(() => new Promise(() => undefined)),
      }));
      const snapdom = vi.fn(async () => ({ toCanvas: async () => makeCanvasStub().stub }));
      vi.doMock('@zumer/snapdom', () => ({ snapdom }));
      const secret = document.createElement('div');
      document.body.appendChild(secret);
      const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
      void cap({ root: document.body, maskTargets: [secret] });
      await vi.advanceTimersByTimeAsync(0);
      const maskedByStuck = secret.getAttribute('style');
      let reason: string | undefined;
      const b = cap({ root: document.body, maskTargets: [secret], __setDegradedReason: (x) => { reason = x; } });
      await vi.advanceTimersByTimeAsync(10_000 + 2_000 + 600 + 5_000 + 1);
      const rb = await b;
      expect(reason).toBe(DEGRADED_REASONS.screenshot_failed);
      expect(rb.degradedReason).toBe(DEGRADED_REASONS.screenshot_failed);
      expect(new Uint8Array(await rb.blob.arrayBuffer())).toEqual(PNG_BYTES);
      expect(snapdom).not.toHaveBeenCalled();
      expect(secret.getAttribute('style')).toBe(maskedByStuck); // B never masked or restored it
      secret.remove();
    } finally {
      vi.doUnmock('../../src/capture/video-frames.js');
      vi.useRealTimers();
    }
  });

  it('restores DOM masks and video stand-ins after a snapdom capture', async () => {
    mockSnapdom(makeCanvasStub().stub);
    const secret = document.createElement('div');
    secret.textContent = 'secret';
    document.body.appendChild(secret);
    const before = secret.getAttribute('style');
    const { captureScreenshot: cap } = await import('../../src/capture/screenshot.js');
    await cap({ root: document.body, maskTargets: [secret] });
    expect(secret.getAttribute('style')).toBe(before);
  });
});
