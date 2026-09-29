// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';

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

    expect(out).toBe(canvas);
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
    afterEach(() => vi.restoreAllMocks());

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

      const out = await renderViewportWithSnapdom(document.body, { pixelRatio: 1.5, filter: () => true });

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
      const out = await renderViewportWithSnapdom(document.body, { pixelRatio: 2, filter: () => true });
      expect(out).toBe(src);
      expect(getContext).not.toHaveBeenCalled();
    });

    it('returns a larger canvas unchanged', async () => {
      withViewport(800, 600);
      const src = snapCanvas(900, 700);
      mockSnapdom(src);
      const { renderViewportWithSnapdom } = await import('../../src/capture/renderers/snapdom-renderer.js');
      const out = await renderViewportWithSnapdom(document.body, { pixelRatio: 1, filter: () => true });
      expect(out).toBe(src);
    });

    it('returns the snapDOM canvas unchanged when no 2d context is available', async () => {
      withViewport(800, 600);
      const src = snapCanvas(790, 600);
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
      mockSnapdom(src);
      const { renderViewportWithSnapdom } = await import('../../src/capture/renderers/snapdom-renderer.js');
      const out = await renderViewportWithSnapdom(document.body, { pixelRatio: 1, filter: () => true });
      expect(out).toBe(src);
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

    it('tags children of scrolled elements during the call and untags afterwards', async () => {
      const { host, scroller, child } = scrolled();
      let during: string | null = null;
      vi.doMock('@zumer/snapdom', () => ({
        snapdom: vi.fn(async () => {
          during = child.getAttribute(ATTR);
          return okCanvas();
        }),
      }));
      const { renderViewportWithSnapdom } = await import('../../src/capture/renderers/snapdom-renderer.js');
      await renderViewportWithSnapdom(host, { pixelRatio: 1, filter: () => true });
      expect(during).toMatch(/^[^|]+\|translate\(-5px, -800px\)$/);
      expect(scroller.hasAttribute(ATTR)).toBe(false);
      expect(child.hasAttribute(ATTR)).toBe(false);
      host.remove();
    });

    it('untags even when snapdom rejects', async () => {
      const { host, child } = scrolled();
      vi.doMock('@zumer/snapdom', () => ({
        snapdom: vi.fn(async () => {
          throw new Error('boom');
        }),
      }));
      const { renderViewportWithSnapdom } = await import('../../src/capture/renderers/snapdom-renderer.js');
      await expect(renderViewportWithSnapdom(host, { pixelRatio: 1, filter: () => true })).rejects.toThrow('boom');
      expect(child.hasAttribute(ATTR)).toBe(false);
      host.remove();
    });

    type Plugin = { afterClone(ctx: { clone: Element }): void };
    const runPlugin = async (host: HTMLElement): Promise<Plugin> => {
      let plugins: Plugin[] | undefined;
      vi.doMock('@zumer/snapdom', () => ({
        snapdom: vi.fn(async (_r: HTMLElement, opts: { plugins?: Plugin[] }) => {
          plugins = opts.plugins;
          return okCanvas();
        }),
      }));
      const { renderViewportWithSnapdom } = await import('../../src/capture/renderers/snapdom-renderer.js');
      await renderViewportWithSnapdom(host, { pixelRatio: 1, filter: () => true });
      expect(plugins).toHaveLength(1);
      return plugins![0]!;
    };

    it('composes a class-applied transform after the scroll translate on the clone child', async () => {
      const { host, child } = scrolled();
      const real = window.getComputedStyle.bind(window);
      vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
        const cs = real(el, pseudo);
        return el === child ? ({ transform: 'matrix(2, 0, 0, 2, 0, 0)' } as CSSStyleDeclaration) : cs;
      });
      let tag = '';
      let plugin!: Plugin;
      vi.doMock('@zumer/snapdom', () => ({
        snapdom: vi.fn(async (_r: HTMLElement, opts: { plugins?: Plugin[] }) => {
          tag = child.getAttribute(ATTR)!;
          plugin = opts.plugins![0]!;
          return okCanvas();
        }),
      }));
      const { renderViewportWithSnapdom } = await import('../../src/capture/renderers/snapdom-renderer.js');
      await renderViewportWithSnapdom(host, { pixelRatio: 1, filter: () => true });

      const clone = document.createElement('div');
      const cs = document.createElement('div');
      const cc = document.createElement('p');
      cc.setAttribute(ATTR, tag);
      cs.appendChild(cc);
      clone.appendChild(cs);
      plugin.afterClone({ clone });
      expect(cc.style.transform).toBe('translate(-5px, -800px) matrix(2, 0, 0, 2, 0, 0)');
      expect(cc.hasAttribute(ATTR)).toBe(false);
      vi.restoreAllMocks();
      host.remove();
    });

    it('a child with computed transform none gets just the translate', async () => {
      const { host } = scrolled();
      const plugin = await runPlugin(host);
      const clone = document.createElement('div');
      const cc = document.createElement('p');
      cc.setAttribute(ATTR, 'tok|translate(-5px, -800px)');
      clone.appendChild(cc);
      plugin.afterClone({ clone });
      expect(cc.style.transform).toBe('translate(-5px, -800px)');
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
  });
});
