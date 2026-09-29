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
    type Ctx = { clone: Element; nodeMap: Map<Node, Node> };
    type Plugin = { afterClone(ctx: Ctx): void };
    const scrolled = (top = 800, left = 5): { host: HTMLElement; scroller: HTMLElement; child: HTMLElement } => {
      const host = document.createElement('div');
      const scroller = document.createElement('div');
      const child = document.createElement('p');
      scroller.appendChild(child);
      host.appendChild(scroller);
      document.body.appendChild(host);
      setScroll(scroller, top, left);
      return { host, scroller, child };
    };
    const setScroll = (el: HTMLElement, top: number, left: number): void => {
      Object.defineProperty(el, 'scrollTop', { value: top, configurable: true });
      Object.defineProperty(el, 'scrollLeft', { value: left, configurable: true });
    };
    const okCanvas = async (): Promise<{ toCanvas: () => Promise<HTMLCanvasElement> }> => ({
      toCanvas: async () => document.createElement('canvas'),
    });
    /** snapDOM-style deep clone with its clone -> source nodeMap. */
    const cloneWithMap = (src: Element): Ctx => {
      const nodeMap = new Map<Node, Node>();
      const walk = (s: Element): Element => {
        const c = s.cloneNode(false) as Element;
        nodeMap.set(c, s);
        for (const k of Array.from(s.childNodes)) c.appendChild(k.nodeType === 1 ? walk(k as Element) : k.cloneNode(true));
        return c;
      };
      return { clone: walk(src), nodeMap };
    };
    /** What snapDOM 3.2.0's own scroll pass (`xo`) does to every scrolled clone (non-root). */
    const snapdomXo = (ctx: Ctx, root: Element): void => {
      for (const [c, s] of ctx.nodeMap) {
        const src = s as HTMLElement;
        const left = src.scrollLeft;
        const top = src.scrollTop;
        if (src === root || !(left || top)) continue;
        const clone = c as HTMLElement;
        clone.style.overflow = 'hidden';
        for (const el of Array.from(clone.querySelectorAll<HTMLElement>('*'))) {
          const pos = el.style.position;
          if (pos === 'absolute' || pos === 'fixed') {
            el.style.top = `${(parseFloat(el.style.top) || 0) + top}px`;
            el.style.left = `${(parseFloat(el.style.left) || 0) + left}px`;
            if (pos === 'fixed') el.style.position = 'absolute';
          }
        }
        const wrap = document.createElement('div');
        wrap.style.all = 'unset';
        wrap.style.transform = `translate(${-left}px, ${-top}px)`;
        wrap.style.willChange = 'transform';
        wrap.style.display = 'inline-block';
        wrap.style.width = '100%';
        while (clone.firstChild) wrap.appendChild(clone.firstChild);
        clone.appendChild(wrap);
      }
    };
    /** Starts a capture whose snapdom call stays pending; returns its plugin and a release. */
    const startCapture = async (host: HTMLElement): Promise<{ plugin: Plugin; release: () => void; done: Promise<unknown> }> => {
      let plugin: Plugin | undefined;
      let release!: () => void;
      vi.doMock('@zumer/snapdom', () => ({
        snapdom: vi.fn(
          (_r: HTMLElement, opts: { plugins?: Plugin[] }) =>
            new Promise((resolve) => {
              plugin = opts.plugins?.[0];
              release = () => resolve(okCanvas());
            }),
        ),
      }));
      const { renderViewportWithSnapdom } = await import('../../src/capture/renderers/snapdom-renderer.js');
      const done = renderViewportWithSnapdom(host, { pixelRatio: 1, filter: () => true });
      await vi.waitFor(() => expect(plugin).toBeDefined());
      vi.resetModules();
      return { plugin: plugin!, release, done };
    };
    /** Full round: capture, snapDOM-style clone (+ its xo pass unless disabled), our afterClone. */
    const restore = async (host: HTMLElement, xo = true): Promise<Ctx> => {
      const cap = await startCapture(host);
      const ctx = cloneWithMap(host);
      if (xo) snapdomXo(ctx, host);
      cap.plugin.afterClone(ctx);
      cap.release();
      await cap.done;
      return ctx;
    };

    it('never writes to the live DOM', async () => {
      const { host } = scrolled();
      const before = host.outerHTML;
      let during = '';
      vi.doMock('@zumer/snapdom', () => ({
        snapdom: vi.fn(async () => {
          during = host.outerHTML;
          return okCanvas();
        }),
      }));
      const { renderViewportWithSnapdom } = await import('../../src/capture/renderers/snapdom-renderer.js');
      await renderViewportWithSnapdom(host, { pixelRatio: 1, filter: () => true });
      expect(during).toBe(before);
      expect(host.outerHTML).toBe(before);
      host.remove();
    });

    it('unwraps snapDOM\'s wrapper and shifts each child exactly once', async () => {
      const { host, scroller } = scrolled();
      scroller.appendChild(document.createElement('p'));
      const { clone } = await restore(host);
      const scrollerClone = clone.firstElementChild as HTMLElement;
      // Child count restored (snapDOM's shrink pass compares it with the source).
      expect(scrollerClone.childElementCount).toBe(2);
      for (const c of Array.from(scrollerClone.children) as HTMLElement[]) {
        expect(c.tagName).toBe('P');
        expect(c.style.transform).toBe('translate(-5px, -800px)');
      }
      expect(scrollerClone.style.overflow).toBe('hidden'); // snapDOM's clipping kept
      host.remove();
    });

    it('unwraps a flex scroller too, so its children stay flex items', async () => {
      const { host, scroller } = scrolled(0, 450);
      scroller.style.display = 'flex';
      scroller.appendChild(document.createElement('p'));
      const { clone } = await restore(host);
      const scrollerClone = clone.firstElementChild as HTMLElement;
      expect(Array.from(scrollerClone.children).map((c) => c.tagName)).toEqual(['P', 'P']);
      expect((scrollerClone.firstElementChild as HTMLElement).style.transform).toBe('translate(-450px, 0px)');
      host.remove();
    });

    it('restores by itself when snapDOM did not wrap the scroller', async () => {
      const { host } = scrolled();
      const { clone } = await restore(host, false);
      expect((clone.querySelector('p') as HTMLElement).style.transform).toBe('translate(-5px, -800px)');
      host.remove();
    });

    it('composes a class-applied transform after the scroll translate', async () => {
      const { host, child } = scrolled();
      const real = window.getComputedStyle.bind(window);
      vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
        const cs = real(el, pseudo);
        return el === child ? ({ position: 'static', transform: 'matrix(2, 0, 0, 2, 0, 0)' } as CSSStyleDeclaration) : cs;
      });
      const { clone } = await restore(host);
      expect((clone.querySelector('p') as HTMLElement).style.transform).toBe(
        'translate(-5px, -800px) matrix(2, 0, 0, 2, 0, 0)',
      );
      vi.restoreAllMocks();
      host.remove();
    });

    it('reverts snapDOM\'s counter-offset on inline-absolute descendants (keeping `auto`)', async () => {
      const { host, child } = scrolled();
      child.style.position = 'relative';
      const abs = document.createElement('div');
      abs.style.position = 'absolute';
      abs.style.top = '900px';
      const autoAbs = document.createElement('div');
      autoAbs.style.position = 'absolute';
      child.append(abs, autoAbs);
      const { clone } = await restore(host);
      const [absClone, autoClone] = Array.from(clone.querySelectorAll('p > div')) as HTMLElement[];
      expect(absClone!.style.top).toBe('900px'); // not snapDOM's unscrolled 1700px
      expect(absClone!.style.left).toBe('');
      expect(autoClone!.style.top).toBe('');
      expect((clone.querySelector('p') as HTMLElement).style.transform).toBe('translate(-5px, -800px)');
      host.remove();
    });

    it('does not shift an absolute child anchored outside a static scroller', async () => {
      const { host, scroller } = scrolled();
      const abs = document.createElement('div');
      abs.style.position = 'absolute';
      abs.style.top = '10px';
      scroller.appendChild(abs);
      const { clone } = await restore(host);
      const absClone = clone.firstElementChild!.lastElementChild as HTMLElement;
      expect(absClone.style.transform).toBe('');
      expect(absClone.style.top).toBe('10px');
      host.remove();
    });

    it('shifts an absolute child when the scroller is its containing block via contain: layout', async () => {
      const { host, scroller } = scrolled();
      const abs = document.createElement('div');
      abs.style.position = 'absolute';
      abs.style.top = '10px';
      scroller.appendChild(abs);
      const real = window.getComputedStyle.bind(window);
      vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
        const cs = real(el, pseudo);
        if (el !== scroller) return cs;
        return { position: 'static', transform: 'none', contain: 'layout' } as unknown as CSSStyleDeclaration;
      });
      const { clone } = await restore(host);
      vi.restoreAllMocks();
      const absClone = clone.firstElementChild!.lastElementChild as HTMLElement;
      expect(absClone.style.transform).toBe('translate(-5px, -800px)');
      expect(absClone.style.top).toBe('10px');
      host.remove();
    });

    it('leaves fixed and sticky children to snapDOM (placed from their live rects)', async () => {
      const { host, scroller } = scrolled();
      const sticky = document.createElement('div');
      sticky.style.position = 'sticky';
      scroller.appendChild(sticky);
      const { clone } = await restore(host);
      expect((clone.firstElementChild!.lastElementChild as HTMLElement).style.transform).toBe('');
      host.remove();
    });

    it('shifts snapDOM-inserted (unmapped) in-flow children with the content', async () => {
      const { host } = scrolled();
      const cap = await startCapture(host);
      const ctx = cloneWithMap(host);
      const placeholder = document.createElement('div');
      ctx.clone.firstElementChild!.appendChild(placeholder);
      snapdomXo(ctx, host);
      cap.plugin.afterClone(ctx);
      cap.release();
      await cap.done;
      expect(placeholder.style.transform).toBe('translate(-5px, -800px)');
      host.remove();
    });

    it('overlapping captures each restore their own offsets', async () => {
      const { host, scroller, child } = scrolled(800, 0);
      child.style.position = 'relative';
      const abs = document.createElement('div');
      abs.style.position = 'absolute';
      abs.style.top = '900px';
      child.appendChild(abs);
      const a = await startCapture(host); // A records scrollTop 800 ...
      setScroll(scroller, 300, 0);
      const b = await startCapture(host); // ... B records 300 before A has cloned
      const ctxB = cloneWithMap(host);
      snapdomXo(ctxB, host);
      b.plugin.afterClone(ctxB);
      setScroll(scroller, 800, 0);
      const ctxA = cloneWithMap(host);
      snapdomXo(ctxA, host);
      a.plugin.afterClone(ctxA);
      a.release();
      b.release();
      await Promise.all([a.done, b.done]);
      expect((ctxA.clone.querySelector('p') as HTMLElement).style.transform).toBe('translate(0px, -800px)');
      expect((ctxB.clone.querySelector('p') as HTMLElement).style.transform).toBe('translate(0px, -300px)');
      expect((ctxA.clone.querySelector('p > div') as HTMLElement).style.top).toBe('900px');
      expect((ctxB.clone.querySelector('p > div') as HTMLElement).style.top).toBe('900px');
      host.remove();
    });

    it('is inert without a snapDOM nodeMap', async () => {
      const { host } = scrolled();
      const cap = await startCapture(host);
      const ctx = cloneWithMap(host);
      cap.plugin.afterClone({ clone: ctx.clone } as unknown as Ctx);
      cap.release();
      await cap.done;
      expect((ctx.clone.querySelector('p') as HTMLElement).style.transform).toBe('');
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

    it('reports the root rect read right before snapdom started, not after it settled', async () => {
      const root = document.createElement('div');
      document.body.appendChild(root);
      let rect = { left: 200, top: 100 };
      vi.spyOn(root, 'getBoundingClientRect').mockImplementation(() => rect as DOMRect);
      vi.doMock('@zumer/snapdom', () => ({
        snapdom: vi.fn(async () => {
          rect = { left: 200, top: -500 }; // page scrolled mid-render
          return okCanvas();
        }),
      }));
      const { renderViewportWithSnapdom } = await import('../../src/capture/renderers/snapdom-renderer.js');
      const out = await renderViewportWithSnapdom(root, { pixelRatio: 1, filter: () => true });
      expect(out.rootLeft).toBe(200);
      expect(out.rootTop).toBe(100);
      vi.restoreAllMocks();
      root.remove();
    });
  });

  describe('establishesAbsoluteContainingBlock', () => {
    const cs = (o: Record<string, string>): CSSStyleDeclaration =>
      ({ position: 'static', transform: 'none', ...o }) as unknown as CSSStyleDeclaration;
    it.each([
      [{ position: 'relative' }],
      [{ transform: 'matrix(1, 0, 0, 1, 0, 0)' }],
      [{ perspective: '500px' }],
      [{ filter: 'blur(1px)' }],
      [{ backdropFilter: 'blur(2px)' }],
      [{ contain: 'layout' }],
      [{ contain: 'paint' }],
      [{ contain: 'strict' }],
      [{ contain: 'content' }],
      [{ containerType: 'inline-size' }],
      [{ willChange: 'transform' }],
      [{ willChange: 'filter' }],
    ])('true for %o', async (o) => {
      const { establishesAbsoluteContainingBlock } = await import('../../src/capture/renderers/snapdom-renderer.js');
      expect(establishesAbsoluteContainingBlock(cs(o))).toBe(true);
    });
    it.each([
      [{}],
      [{ contain: 'none' }],
      [{ contain: 'size' }],
      [{ filter: 'none', perspective: 'none', willChange: 'auto', containerType: 'normal' }],
    ])('false for %o', async (o) => {
      const { establishesAbsoluteContainingBlock } = await import('../../src/capture/renderers/snapdom-renderer.js');
      expect(establishesAbsoluteContainingBlock(cs(o))).toBe(false);
    });
  });
});
