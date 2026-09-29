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
    type Plugin = { afterClone(ctx: Ctx): void; beforeRender(): void };
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

    it('folds individual translate/rotate/scale in AFTER the scroll translate and resets them on the clone', async () => {
      const { host, child } = scrolled(100, 0);
      const real = window.getComputedStyle.bind(window);
      vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
        const cs = real(el, pseudo);
        return el === child
          ? ({ position: 'static', transform: 'none', translate: '10px 5px', rotate: '45deg', scale: '2' } as unknown as CSSStyleDeclaration)
          : cs;
      });
      const setProperty = vi.spyOn(CSSStyleDeclaration.prototype, 'setProperty');
      const { clone } = await restore(host);
      const childClone = clone.querySelector('p') as HTMLElement;
      // translate(0,-100) first: the scale/rotate no longer act on the scroll offset.
      expect(childClone.style.transform).toBe('translate(0px, -100px) translate(10px, 5px) rotate(45deg) scale(2)');
      expect(setProperty).toHaveBeenCalledWith('translate', 'none');
      expect(setProperty).toHaveBeenCalledWith('rotate', 'none');
      expect(setProperty).toHaveBeenCalledWith('scale', 'none');
      vi.restoreAllMocks();
      host.remove();
    });

    it('leaves the individual properties alone when the child has none', async () => {
      const { host } = scrolled();
      const setProperty = vi.spyOn(CSSStyleDeclaration.prototype, 'setProperty');
      await restore(host);
      expect(setProperty.mock.calls.some(([p]) => p === 'scale' || p === 'rotate' || p === 'translate')).toBe(false);
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

    it('re-pins restored scrollers\' size and clipping after snapDOM\'s shrink pass (beforeRender)', async () => {
      const { host, scroller } = scrolled(600, 0);
      scroller.style.width = '240px';
      scroller.style.height = '300px';
      const cap = await startCapture(host);
      const ctx = cloneWithMap(host);
      snapdomXo(ctx, host);
      cap.plugin.afterClone(ctx);
      // What snapDOM's shrink pass does to a scroller that lost a (lifted fixed) child.
      const scrollerClone = ctx.clone.firstElementChild as HTMLElement;
      scrollerClone.style.height = 'auto';
      scrollerClone.style.width = 'auto';
      scrollerClone.style.overflow = 'visible';
      cap.plugin.beforeRender();
      cap.release();
      await cap.done;
      expect(scrollerClone.style.height).toBe('300px');
      expect(scrollerClone.style.width).toBe('240px');
      expect(scrollerClone.style.overflow).toBe('hidden');
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

    it('restores a capture root that scrolls on its own (snapDOM\'s clip mode skips the root)', async () => {
      const { scroller: root, child } = scrolled(300, 0);
      const cap = await startCapture(root);
      const ctx = cloneWithMap(root);
      snapdomXo(ctx, root); // skips the root, as snapDOM does in clip mode
      cap.plugin.afterClone(ctx);
      cap.release();
      await cap.done;
      expect(ctx.clone.firstElementChild).toBe(Array.from(ctx.nodeMap.keys()).find((k) => ctx.nodeMap.get(k) === child));
      expect((ctx.clone.firstElementChild as HTMLElement).style.transform).toBe('translate(0px, -300px)');
      root.parentElement!.remove();
    });

    it('restores a scrolled root even when snapDOM did not map the root clone', async () => {
      const { scroller: root } = scrolled(300, 0);
      const cap = await startCapture(root);
      const ctx = cloneWithMap(root);
      ctx.nodeMap.delete(ctx.clone);
      cap.plugin.afterClone(ctx);
      cap.release();
      await cap.done;
      expect((ctx.clone.firstElementChild as HTMLElement).style.transform).toBe('translate(0px, -300px)');
      root.parentElement!.remove();
    });

    it('installs the plugin even when nothing is scrolled at capture start', async () => {
      const snapdom = vi.fn(async (_r: HTMLElement, _o: Record<string, unknown>) => okCanvas());
      vi.doMock('@zumer/snapdom', () => ({ snapdom }));
      const { renderViewportWithSnapdom } = await import('../../src/capture/renderers/snapdom-renderer.js');
      await renderViewportWithSnapdom(document.body, { pixelRatio: 1, filter: () => true });
      const opts = snapdom.mock.calls[0]![1] as { plugins?: unknown[] };
      expect(opts.plugins).toHaveLength(1);
    });

    it('normalizes a snapDOM wrapper on a scroller that only started scrolling mid-capture', async () => {
      const { host, scroller } = scrolled(0, 0); // not scrolled when the capture starts
      scroller.style.display = 'flex';
      scroller.appendChild(document.createElement('p'));
      const cap = await startCapture(host);
      setScroll(scroller, 0, 450); // scrolled while snapDOM yields
      const ctx = cloneWithMap(host);
      snapdomXo(ctx, host);
      cap.plugin.afterClone(ctx);
      cap.release();
      await cap.done;
      const scrollerClone = ctx.clone.firstElementChild as HTMLElement;
      expect(Array.from(scrollerClone.children).map((c) => c.tagName)).toEqual(['P', 'P']);
      for (const c of Array.from(scrollerClone.children) as HTMLElement[]) {
        expect(c.style.transform).toBe('translate(-450px, 0px)');
      }
      host.remove();
    });

    it('re-pins an absolute grandchild anchored to the scroller so the child transform does not re-anchor it', async () => {
      const { host, scroller, child } = scrolled(100, 0);
      scroller.style.position = 'relative';
      const abs = document.createElement('div');
      abs.style.position = 'absolute';
      abs.style.top = '150px';
      child.appendChild(abs);
      const def = (el: HTMLElement, props: Record<string, unknown>): void => {
        for (const [k, v] of Object.entries(props)) Object.defineProperty(el, k, { value: v, configurable: true });
      };
      // Live layout: child has margin-top 50 inside the (positioned) scroller;
      // the grandchild sits at top:150 of the scroller.
      def(child, { offsetParent: scroller, offsetTop: 50, offsetLeft: 0, clientTop: 0, clientLeft: 0 });
      def(abs, { offsetParent: scroller, offsetTop: 150, offsetLeft: 10, offsetWidth: 100, offsetHeight: 40 });
      const { clone } = await restore(host);
      const childClone = clone.querySelector('p') as HTMLElement;
      const absClone = childClone.firstElementChild as HTMLElement;
      expect(childClone.style.transform).toBe('translate(0px, -100px)');
      // Relative to the child's padding box: 150 - 50 = 100, so it renders at
      // 50 + 100 - 100 = 50 - where the user saw it - not 100.
      expect(absClone.style.top).toBe('100px');
      expect(absClone.style.left).toBe('10px');
      expect(absClone.style.width).toBe('100px');
      expect(absClone.style.height).toBe('40px');
      expect(absClone.style.margin).toBe('0px');
      host.remove();
    });

    it('does not re-pin an absolute grandchild whose containing block is the (positioned) child', async () => {
      const { host, scroller, child } = scrolled(100, 0);
      scroller.style.position = 'relative';
      child.style.position = 'relative';
      const abs = document.createElement('div');
      abs.style.position = 'absolute';
      abs.style.top = '150px';
      child.appendChild(abs);
      const { clone } = await restore(host);
      expect((clone.querySelector('p > div') as HTMLElement).style.top).toBe('150px');
      expect((clone.querySelector('p > div') as HTMLElement).style.width).toBe('');
      host.remove();
    });

    it('keeps individual transforms untouched when the folded transform would be invalid', async () => {
      const { host, child } = scrolled(100, 0);
      const real = window.getComputedStyle.bind(window);
      vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
        const cs = real(el, pseudo);
        return el === child
          ? ({ position: 'static', transform: 'none', scale: '2' } as unknown as CSSStyleDeclaration)
          : cs;
      });
      vi.stubGlobal('CSS', { supports: () => false });
      const setProperty = vi.spyOn(CSSStyleDeclaration.prototype, 'setProperty');
      const { clone } = await restore(host);
      expect((clone.querySelector('p') as HTMLElement).style.transform).toBe('translate(0px, -100px)');
      expect(setProperty.mock.calls.some(([p]) => p === 'scale')).toBe(false);
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      host.remove();
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

  describe('individualTransformFunctions', () => {
    it.each([
      [{}, ''],
      [{ translate: 'none', rotate: 'none', scale: 'none' }, ''],
      [{ scale: '2' }, 'scale(2)'],
      [{ scale: '2 3' }, 'scale(2, 3)'],
      [{ scale: '2 3 4' }, 'scale3d(2, 3, 4)'],
      [{ translate: '10px' }, 'translate(10px)'],
      [{ translate: '10px 20%' }, 'translate(10px, 20%)'],
      [{ translate: '1px 2px 3px' }, 'translate3d(1px, 2px, 3px)'],
      [{ rotate: '45deg' }, 'rotate(45deg)'],
      [{ rotate: 'x 45deg' }, 'rotateX(45deg)'],
      [{ rotate: '1 0 0 45deg' }, 'rotate3d(1, 0, 0, 45deg)'],
      [{ scale: '2', rotate: '10deg', translate: '5px' }, 'translate(5px) rotate(10deg) scale(2)'],
      [{ translate: 'calc(50% + 10px) 5px' }, 'translate(calc(50% + 10px), 5px)'],
      [{ translate: 'calc(10px + (2 * 3px))' }, 'translate(calc(10px + (2 * 3px)))'],
      [{ rotate: 'x y 45deg' }, null],
      [{ scale: '1 2 3 4' }, null],
    ])('%o -> %s', async (values, expected) => {
      const { individualTransformFunctions } = await import('../../src/capture/renderers/snapdom-renderer.js');
      expect(individualTransformFunctions(values)).toBe(expected);
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
      [{ scale: '1' }],
      [{ translate: '10px' }],
      [{ rotate: '45deg' }],
    ])('true for %o', async (o) => {
      const { establishesAbsoluteContainingBlock } = await import('../../src/capture/renderers/snapdom-renderer.js');
      expect(establishesAbsoluteContainingBlock(cs(o))).toBe(true);
    });
    it.each([
      [{}],
      [{ contain: 'none' }],
      [{ contain: 'size' }],
      [{ filter: 'none', perspective: 'none', willChange: 'auto', containerType: 'normal' }],
      [{ translate: 'none', rotate: 'none', scale: 'none' }],
    ])('false for %o', async (o) => {
      const { establishesAbsoluteContainingBlock } = await import('../../src/capture/renderers/snapdom-renderer.js');
      expect(establishesAbsoluteContainingBlock(cs(o))).toBe(false);
    });
  });
});
