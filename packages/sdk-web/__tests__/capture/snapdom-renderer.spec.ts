// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('@zumer/snapdom');
});

describe('renderViewportWithSnapdom', () => {
  it('captures the viewport with the fixed option set and returns its canvas', async () => {
    const canvas = document.createElement('canvas');
    const toCanvas = vi.fn(async () => canvas);
    const snapdom = vi.fn(async () => ({ toCanvas }));
    vi.doMock('@zumer/snapdom', () => ({ snapdom }));
    const { renderViewportWithSnapdom } = await import('../../src/capture/renderers/snapdom-renderer.js');
    const filter = (): boolean => true;

    const out = await renderViewportWithSnapdom(document.body, { pixelRatio: 1.5, filter });

    expect(out.canvas).toBe(canvas);
    expect(snapdom).toHaveBeenCalledTimes(1);
    const [root, opts] = snapdom.mock.calls[0] as unknown as [HTMLElement, Record<string, unknown>];
    expect(root).toBe(document.body);
    expect(opts).toMatchObject({
      clip: 'viewport',
      fast: false,
      scale: 1,
      dpr: 1.5,
      backgroundColor: '#ffffff',
      filterMode: 'remove',
      embedFonts: 'auto',
      invalidate: true,
    });
    expect(typeof opts.filter).toBe('function');
  });

  describe('viewport padding (classic scrollbars)', () => {
    const withViewport = (w: number, h: number): void => {
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(w);
      vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(h);
    };
    const snapCanvas = (w: number, h: number): HTMLCanvasElement =>
      Object.assign(document.createElement('canvas'), { width: w, height: h });
    const mockSnapdom = (canvas: HTMLCanvasElement): void => {
      vi.doMock('@zumer/snapdom', () => ({
        snapdom: vi.fn(async () => ({ toCanvas: async () => canvas })),
      }));
    };
    // The blank check draws onto its own sample canvas; keep it out of the
    // padding assertions (its own behaviour is covered below and in blank-check.spec).
    beforeEach(() => {
      vi.doMock('../../src/capture/blank-check.js', () => ({ isCanvasBlank: vi.fn(() => false) }));
    });
    afterEach(() => {
      vi.doUnmock('../../src/capture/blank-check.js');
      vi.restoreAllMocks();
    });

    it('pads a scrollbar-narrowed canvas to innerWidth x innerHeight x ratio on white', async () => {
      withViewport(800, 600);
      const src = snapCanvas(1185, 900); // (800 - 10px scrollbar) * 1.5
      const calls: string[] = [];
      const drawImage = vi.fn();
      const ctx = {
        set fillStyle(v: string) {
          calls.push(`fillStyle=${v}`);
        },
        fillRect: vi.fn((...a: number[]) => calls.push(`fillRect(${a.join(',')})`)),
        drawImage,
      };
      const getContext = vi
        .spyOn(HTMLCanvasElement.prototype, 'getContext')
        .mockImplementation(() => ctx as unknown as CanvasRenderingContext2D);
      mockSnapdom(src);
      const { renderViewportWithSnapdom } = await import('../../src/capture/renderers/snapdom-renderer.js');

      const { canvas: out } = await renderViewportWithSnapdom(document.body, { pixelRatio: 1.5, filter: () => true });

      expect(out).not.toBe(src);
      expect(out.width).toBe(1200);
      expect(out.height).toBe(900);
      expect(getContext).toHaveBeenCalledWith('2d');
      expect(calls).toEqual(['fillStyle=#ffffff', 'fillRect(0,0,1200,900)']);
      expect(drawImage).toHaveBeenCalledTimes(1);
      expect(drawImage).toHaveBeenCalledWith(src, 0, 0);
    });

    it('returns an exactly viewport-sized canvas unchanged', async () => {
      withViewport(800, 600);
      const src = snapCanvas(1600, 1200);
      const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
      mockSnapdom(src);
      const { renderViewportWithSnapdom } = await import('../../src/capture/renderers/snapdom-renderer.js');
      const { canvas: out } = await renderViewportWithSnapdom(document.body, { pixelRatio: 2, filter: () => true });
      expect(out).toBe(src);
      expect(getContext).not.toHaveBeenCalled();
    });

    it('returns a larger canvas unchanged', async () => {
      withViewport(800, 600);
      const src = snapCanvas(900, 700);
      mockSnapdom(src);
      const { renderViewportWithSnapdom } = await import('../../src/capture/renderers/snapdom-renderer.js');
      const { canvas: out } = await renderViewportWithSnapdom(document.body, { pixelRatio: 1, filter: () => true });
      expect(out).toBe(src);
    });

    it('returns the snapDOM canvas unchanged when no 2d context is available', async () => {
      withViewport(800, 600);
      const src = snapCanvas(790, 600);
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
      mockSnapdom(src);
      const { renderViewportWithSnapdom } = await import('../../src/capture/renderers/snapdom-renderer.js');
      const { canvas: out } = await renderViewportWithSnapdom(document.body, { pixelRatio: 1, filter: () => true });
      expect(out).toBe(src);
    });

    it('measures blankness on the UNPADDED raster: a flat dark narrow canvas stays blank once padded', async () => {
      withViewport(800, 600);
      const src = snapCanvas(790, 600); // narrowed by a 10px classic scrollbar
      const checked: HTMLCanvasElement[] = [];
      vi.doMock('../../src/capture/blank-check.js', () => ({
        // The raw raster is flat dark; the padded one (dark + white strip) would read as not blank.
        isCanvasBlank: vi.fn((c: HTMLCanvasElement) => {
          checked.push(c);
          return c === src;
        }),
      }));
      const ctx = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() };
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
        () => ctx as unknown as CanvasRenderingContext2D,
      );
      mockSnapdom(src);
      const { renderViewportWithSnapdom } = await import('../../src/capture/renderers/snapdom-renderer.js');
      const out = await renderViewportWithSnapdom(document.body, { pixelRatio: 1, filter: () => true });
      expect(out.canvas).not.toBe(src); // it was padded
      expect(out.canvas.width).toBe(800);
      expect(checked).toEqual([src]);
      expect(out.blank).toBe(true);
    });
  });

  it('routes the SDK filter through unchanged', async () => {
    let passed: ((el: Element) => boolean) | undefined;
    vi.doMock('@zumer/snapdom', () => ({
      snapdom: vi.fn(async (_root: HTMLElement, opts: { filter: (el: Element) => boolean }) => {
        passed = opts.filter;
        return { toCanvas: async () => document.createElement('canvas') };
      }),
    }));
    const { renderViewportWithSnapdom } = await import('../../src/capture/renderers/snapdom-renderer.js');
    await renderViewportWithSnapdom(document.body, {
      pixelRatio: 1,
      filter: (n) => (n as Element).id !== 'skip',
    });
    const skip = document.createElement('div');
    skip.id = 'skip';
    expect(passed!(skip)).toBe(false);
    expect(passed!(document.createElement('div'))).toBe(true);
  });

  it('propagates a snapdom failure so the orchestrator can fall back', async () => {
    vi.doMock('@zumer/snapdom', () => ({
      snapdom: vi.fn(async () => {
        throw new TypeError('s.append is not a function');
      }),
    }));
    const { renderViewportWithSnapdom } = await import('../../src/capture/renderers/snapdom-renderer.js');
    await expect(
      renderViewportWithSnapdom(document.body, { pixelRatio: 1, filter: () => true }),
    ).rejects.toThrow('s.append is not a function');
  });

  it('reports the root rect read right before snapdom started, not after it settled', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    let rect = { left: 200, top: 100 };
    vi.spyOn(root, 'getBoundingClientRect').mockImplementation(() => rect as DOMRect);
    vi.doMock('@zumer/snapdom', () => ({
      snapdom: vi.fn(async () => {
        rect = { left: 200, top: -500 }; // page scrolled mid-render
        return ({ toCanvas: async () => document.createElement('canvas') });
      }),
    }));
    const { renderViewportWithSnapdom } = await import('../../src/capture/renderers/snapdom-renderer.js');
    const out = await renderViewportWithSnapdom(root, { pixelRatio: 1, filter: () => true });
    expect(out.rootLeft).toBe(200);
    expect(out.rootTop).toBe(100);
    vi.restoreAllMocks();
    root.remove();
  });

  describe('serialization (snapDOM captures never overlap)', () => {
    const pending = (): { snapdom: ReturnType<typeof vi.fn>; releases: Array<() => void> } => {
      const releases: Array<() => void> = [];
      const snapdom = vi.fn(
        () =>
          new Promise((resolve) => {
            releases.push(() => resolve({ toCanvas: async () => document.createElement('canvas') }));
          }),
      );
      vi.doMock('@zumer/snapdom', () => ({ snapdom }));
      return { snapdom, releases };
    };

    it('a second capture waits for the running one, then proceeds', async () => {
      const { snapdom, releases } = pending();
      const { renderViewportWithSnapdom } = await import('../../src/capture/renderers/snapdom-renderer.js');
      const a = renderViewportWithSnapdom(document.body, { pixelRatio: 1, filter: () => true, busyWaitMs: 5_000 });
      await vi.waitFor(() => expect(snapdom).toHaveBeenCalledTimes(1));
      const b = renderViewportWithSnapdom(document.body, { pixelRatio: 1, filter: () => true, busyWaitMs: 5_000 });
      await new Promise((r) => setTimeout(r, 30));
      expect(snapdom).toHaveBeenCalledTimes(1); // never concurrently
      releases[0]!();
      await a;
      await vi.waitFor(() => expect(snapdom).toHaveBeenCalledTimes(2));
      releases[1]!();
      await expect(b).resolves.toMatchObject({ blank: false });
    });

    it('a never-settling run makes the next capture fail with SnapdomBusyError without starting snapDOM', async () => {
      const { snapdom } = pending();
      const mod = await import('../../src/capture/renderers/snapdom-renderer.js');
      void mod.renderViewportWithSnapdom(document.body, { pixelRatio: 1, filter: () => true });
      await vi.waitFor(() => expect(snapdom).toHaveBeenCalledTimes(1));
      const started = Date.now();
      await expect(
        mod.renderViewportWithSnapdom(document.body, { pixelRatio: 1, filter: () => true, busyWaitMs: 50 }),
      ).rejects.toBeInstanceOf(mod.SnapdomBusyError);
      expect(Date.now() - started).toBeGreaterThanOrEqual(45);
      expect(snapdom).toHaveBeenCalledTimes(1);
    });

    it('a failed run frees the slot', async () => {
      let calls = 0;
      vi.doMock('@zumer/snapdom', () => ({
        snapdom: vi.fn(async () => {
          calls++;
          if (calls === 1) throw new Error('boom');
          return { toCanvas: async () => document.createElement('canvas') };
        }),
      }));
      const { renderViewportWithSnapdom } = await import('../../src/capture/renderers/snapdom-renderer.js');
      await expect(renderViewportWithSnapdom(document.body, { pixelRatio: 1, filter: () => true })).rejects.toThrow('boom');
      await expect(renderViewportWithSnapdom(document.body, { pixelRatio: 1, filter: () => true })).resolves.toBeDefined();
    });
  });
});
