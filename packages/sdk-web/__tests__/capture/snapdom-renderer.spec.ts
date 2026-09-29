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

  describe('nested scroll restoration', () => {
    const ATTR = 'data-everframe-scroll';
    const SCROLLER = 'data-everframe-scroller';
    const ABS = 'data-everframe-scroll-abs';
    const TAGS = [ATTR, SCROLLER, ABS];
    const scrolled = (): { host: HTMLElement; scroller: HTMLElement; child: HTMLElement } => {
      const host = document.createElement('div');
      const scroller = document.createElement('div');
      const child = document.createElement('p');
      scroller.appendChild(child);
      host.appendChild(scroller);
      document.body.appendChild(host);
      Object.defineProperty(scroller, 'scrollTop', { value: 800, configurable: true });
      Object.defineProperty(scroller, 'scrollLeft', { value: 5, configurable: true });
      return { host, scroller, child };
    };
    const okCanvas = async (): Promise<{ toCanvas: () => Promise<HTMLCanvasElement> }> => ({
      toCanvas: async () => document.createElement('canvas'),
    });
    const hasAnyTag = (el: Element): boolean => TAGS.some((t) => el.hasAttribute(t));

    type Plugin = { afterClone(ctx: { clone: Element }): void };
    /**
     * Runs a capture of `host` whose snapdom mock clones it DURING the call
     * (as snapDOM does - live tags are copied onto the clone) and hands back
     * that clone plus the plugin, so tests can simulate snapDOM's own clone
     * work before running afterClone.
     */
    const captureClone = async (host: HTMLElement): Promise<{ plugin: Plugin; clone: HTMLElement }> => {
      let plugins: Plugin[] | undefined;
      let clone!: HTMLElement;
      vi.doMock('@zumer/snapdom', () => ({
        snapdom: vi.fn(async (_r: HTMLElement, opts: { plugins?: Plugin[] }) => {
          plugins = opts.plugins;
          clone = host.cloneNode(true) as HTMLElement;
          return okCanvas();
        }),
      }));
      const { renderViewportWithSnapdom } = await import('../../src/capture/renderers/snapdom-renderer.js');
      await renderViewportWithSnapdom(host, { pixelRatio: 1, filter: () => true });
      expect(plugins).toHaveLength(1);
      return { plugin: plugins![0]!, clone };
    };
    /** What snapDOM 3.2.0's own scroll pass (`xo`) does to a scrolled element's clone. */
    const snapdomWrap = (scrollerClone: HTMLElement, left: number, top: number): HTMLElement => {
      for (const el of Array.from(scrollerClone.querySelectorAll<HTMLElement>('*'))) {
        const pos = el.style.position;
        if (pos === 'absolute' || pos === 'fixed') {
          el.style.top = `${(parseFloat(el.style.top) || 0) + top}px`;
          el.style.left = `${(parseFloat(el.style.left) || 0) + left}px`;
        }
      }
      const wrap = document.createElement('div');
      wrap.style.all = 'unset';
      wrap.style.transform = `translate(${-left}px, ${-top}px)`;
      wrap.style.willChange = 'transform';
      wrap.style.display = 'inline-block';
      wrap.style.width = '100%';
      while (scrollerClone.firstChild) wrap.appendChild(scrollerClone.firstChild);
      scrollerClone.appendChild(wrap);
      return wrap;
    };

    it('tags scrolled elements and their children during the call and untags afterwards', async () => {
      const { host, scroller, child } = scrolled();
      let during: string | null = null;
      let scrollerDuring: string | null = null;
      vi.doMock('@zumer/snapdom', () => ({
        snapdom: vi.fn(async () => {
          during = child.getAttribute(ATTR);
          scrollerDuring = scroller.getAttribute(SCROLLER);
          return okCanvas();
        }),
      }));
      const { renderViewportWithSnapdom } = await import('../../src/capture/renderers/snapdom-renderer.js');
      await renderViewportWithSnapdom(host, { pixelRatio: 1, filter: () => true });
      expect(during).toMatch(/^[^|]+\|0\|translate\(-5px, -800px\)$/);
      expect(scrollerDuring).toMatch(/^[^|]+\|0\|5\|800$/);
      expect(hasAnyTag(scroller)).toBe(false);
      expect(hasAnyTag(child)).toBe(false);
      host.remove();
    });

    it('untags even when snapdom rejects', async () => {
      const { host, scroller, child } = scrolled();
      vi.doMock('@zumer/snapdom', () => ({
        snapdom: vi.fn(async () => {
          throw new Error('boom');
        }),
      }));
      const { renderViewportWithSnapdom } = await import('../../src/capture/renderers/snapdom-renderer.js');
      await expect(renderViewportWithSnapdom(host, { pixelRatio: 1, filter: () => true })).rejects.toThrow('boom');
      expect(hasAnyTag(child)).toBe(false);
      expect(hasAnyTag(scroller)).toBe(false);
      host.remove();
    });

    it('keeps snapDOM\'s own wrapper shift and does NOT shift the children again (one restoration)', async () => {
      const { host } = scrolled();
      const { plugin, clone } = await captureClone(host);
      const scrollerClone = clone.firstElementChild as HTMLElement;
      const wrap = snapdomWrap(scrollerClone, 5, 800);
      plugin.afterClone({ clone });
      const childClone = wrap.firstElementChild as HTMLElement;
      expect(childClone.style.transform).toBe('');
      expect(wrap.style.transform).toBe('translate(-5px, -800px)');
      expect(Array.from(clone.querySelectorAll('*')).some(hasAnyTag)).toBe(false);
      host.remove();
    });

    it('falls back to its own per-child translate when snapDOM did not wrap the scroller', async () => {
      const { host } = scrolled();
      const { plugin, clone } = await captureClone(host);
      plugin.afterClone({ clone });
      const childClone = clone.querySelector('p') as HTMLElement;
      expect(childClone.style.transform).toBe('translate(-5px, -800px)');
      expect(Array.from(clone.querySelectorAll('*')).some(hasAnyTag)).toBe(false);
      host.remove();
    });

    it('fallback composes a class-applied transform after the scroll translate', async () => {
      const { host, child } = scrolled();
      const real = window.getComputedStyle.bind(window);
      vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
        const cs = real(el, pseudo);
        return el === child ? ({ transform: 'matrix(2, 0, 0, 2, 0, 0)' } as CSSStyleDeclaration) : cs;
      });
      const { plugin, clone } = await captureClone(host);
      plugin.afterClone({ clone });
      expect((clone.querySelector('p') as HTMLElement).style.transform).toBe(
        'translate(-5px, -800px) matrix(2, 0, 0, 2, 0, 0)',
      );
      vi.restoreAllMocks();
      host.remove();
    });

    it('reverts snapDOM\'s counter-offset on an inline-absolute element whose containing block scrolls', async () => {
      const { host, child } = scrolled();
      child.style.position = 'relative';
      const abs = document.createElement('div');
      abs.style.position = 'absolute';
      abs.style.top = '900px';
      child.appendChild(abs);
      const { plugin, clone } = await captureClone(host);
      snapdomWrap(clone.firstElementChild as HTMLElement, 5, 800);
      const absClone = clone.querySelector('p > div') as HTMLElement;
      expect(absClone.style.top).toBe('1700px'); // what snapDOM leaves: unscrolled
      plugin.afterClone({ clone });
      expect(absClone.style.top).toBe('900px'); // scrolls with its containing block via the wrapper
      expect(absClone.style.left).toBe('');
      expect(absClone.hasAttribute(ABS)).toBe(false);
      host.remove();
    });

    it('leaves snapDOM\'s counter-offset on an inline-absolute element anchored outside the scroller', async () => {
      const { host, scroller } = scrolled();
      host.style.position = 'relative';
      const abs = document.createElement('div');
      abs.style.position = 'absolute';
      abs.style.top = '10px';
      scroller.appendChild(abs);
      let absTag: string | null = 'unset';
      vi.doMock('@zumer/snapdom', () => ({
        snapdom: vi.fn(async () => {
          absTag = abs.getAttribute(ABS);
          return okCanvas();
        }),
      }));
      const { renderViewportWithSnapdom } = await import('../../src/capture/renderers/snapdom-renderer.js');
      await renderViewportWithSnapdom(host, { pixelRatio: 1, filter: () => true });
      expect(absTag).toBeNull();
      host.remove();
    });

    it('ignores and strips (in the clone only) tags left by an abandoned capture with another token', async () => {
      const { host } = scrolled();
      // A sibling whose container is no longer scrolled still carries a stale
      // tag from a capture that never settled.
      const stale = document.createElement('div');
      const staleChild = document.createElement('span');
      staleChild.setAttribute(ATTR, 'stale-token|0|translate(0px, -999px)');
      stale.setAttribute(SCROLLER, 'stale-token|0|0|999');
      stale.appendChild(staleChild);
      host.appendChild(stale);
      const { plugin, clone } = await captureClone(host);
      plugin.afterClone({ clone });
      const staleChildClone = clone.querySelector('span') as HTMLElement;
      expect(staleChildClone.style.transform).toBe('');
      expect(staleChildClone.hasAttribute(ATTR)).toBe(false);
      expect((clone.lastElementChild as HTMLElement).hasAttribute(SCROLLER)).toBe(false);
      // The live DOM's foreign tags are not ours to touch.
      expect(staleChild.getAttribute(ATTR)).toBe('stale-token|0|translate(0px, -999px)');
      expect(stale.getAttribute(SCROLLER)).toBe('stale-token|0|0|999');
      host.remove();
    });

    it('a late-settling older capture does not strip a newer capture tags', async () => {
      const { host, child } = scrolled();
      const releases: Array<() => void> = [];
      vi.doMock('@zumer/snapdom', () => ({
        snapdom: vi.fn(
          () =>
            new Promise((resolve) => {
              releases.push(() => resolve(okCanvas()));
            }),
        ),
      }));
      const { renderViewportWithSnapdom } = await import('../../src/capture/renderers/snapdom-renderer.js');
      const a = renderViewportWithSnapdom(host, { pixelRatio: 1, filter: () => true });
      await vi.waitFor(() => expect(releases).toHaveLength(1));
      const b = renderViewportWithSnapdom(host, { pixelRatio: 1, filter: () => true });
      await vi.waitFor(() => expect(releases).toHaveLength(2));
      releases[0]!();
      await a;
      expect(child.hasAttribute(ATTR)).toBe(true);
      releases[1]!();
      await b;
      expect(child.hasAttribute(ATTR)).toBe(false);
      host.remove();
    });

    it('passes no plugins when nothing is scrolled', async () => {
      const snapdom = vi.fn(async (_r: HTMLElement, _o: Record<string, unknown>) => okCanvas());
      vi.doMock('@zumer/snapdom', () => ({ snapdom }));
      const { renderViewportWithSnapdom } = await import('../../src/capture/renderers/snapdom-renderer.js');
      await renderViewportWithSnapdom(document.body, { pixelRatio: 1, filter: () => true });
      const opts = snapdom.mock.calls[0]![1];
      expect('plugins' in opts).toBe(false);
    });

    it('reports the window scroll read right before snapdom started, not after it settled', async () => {
      Object.defineProperty(window, 'scrollY', { value: 300, configurable: true });
      vi.doMock('@zumer/snapdom', () => ({
        snapdom: vi.fn(async () => {
          Object.defineProperty(window, 'scrollY', { value: 900, configurable: true });
          return okCanvas();
        }),
      }));
      try {
        const { renderViewportWithSnapdom } = await import('../../src/capture/renderers/snapdom-renderer.js');
        const out = await renderViewportWithSnapdom(document.body, { pixelRatio: 1, filter: () => true });
        expect(out.scrollY).toBe(300);
      } finally {
        Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
      }
    });
  });
});
