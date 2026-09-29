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
    });
    expect(typeof opts.filter).toBe('function');
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
    const scrolled = (): { host: HTMLElement; scroller: HTMLElement } => {
      const host = document.createElement('div');
      const scroller = document.createElement('div');
      scroller.appendChild(document.createElement('p'));
      host.appendChild(scroller);
      document.body.appendChild(host);
      Object.defineProperty(scroller, 'scrollTop', { value: 800, configurable: true });
      Object.defineProperty(scroller, 'scrollLeft', { value: 5, configurable: true });
      return { host, scroller };
    };

    it('tags scrolled descendants during the call and untags afterwards', async () => {
      const { host, scroller } = scrolled();
      let during: string | null = null;
      vi.doMock('@zumer/snapdom', () => ({
        snapdom: vi.fn(async () => {
          during = scroller.getAttribute('data-everframe-scroll');
          return { toCanvas: async () => document.createElement('canvas') };
        }),
      }));
      const { renderViewportWithSnapdom } = await import('../../src/capture/renderers/snapdom-renderer.js');
      await renderViewportWithSnapdom(host, { pixelRatio: 1, filter: () => true });
      expect(during).toBe('5,800');
      expect(scroller.hasAttribute('data-everframe-scroll')).toBe(false);
      host.remove();
    });

    it('untags even when snapdom rejects', async () => {
      const { host, scroller } = scrolled();
      vi.doMock('@zumer/snapdom', () => ({
        snapdom: vi.fn(async () => {
          throw new Error('boom');
        }),
      }));
      const { renderViewportWithSnapdom } = await import('../../src/capture/renderers/snapdom-renderer.js');
      await expect(renderViewportWithSnapdom(host, { pixelRatio: 1, filter: () => true })).rejects.toThrow('boom');
      expect(scroller.hasAttribute('data-everframe-scroll')).toBe(false);
      host.remove();
    });

    it('afterClone shifts element children, composing before existing transforms, and strips the attribute', async () => {
      const { host } = scrolled();
      let plugins: Array<{ afterClone(ctx: { clone: Element }): void }> | undefined;
      vi.doMock('@zumer/snapdom', () => ({
        snapdom: vi.fn(async (_r: HTMLElement, opts: { plugins?: typeof plugins }) => {
          plugins = opts.plugins;
          return { toCanvas: async () => document.createElement('canvas') };
        }),
      }));
      const { renderViewportWithSnapdom } = await import('../../src/capture/renderers/snapdom-renderer.js');
      await renderViewportWithSnapdom(host, { pixelRatio: 1, filter: () => true });
      expect(plugins).toHaveLength(1);

      const clone = document.createElement('div');
      const cs = document.createElement('div');
      cs.setAttribute('data-everframe-scroll', '5,800');
      const a = document.createElement('span');
      const b = document.createElement('span');
      b.style.transform = 'scale(2)';
      cs.append(a, b);
      clone.appendChild(cs);
      plugins![0]!.afterClone({ clone });

      expect(a.style.transform).toBe('translate(-5px, -800px)');
      expect(b.style.transform).toBe('translate(-5px, -800px) scale(2)');
      expect(cs.hasAttribute('data-everframe-scroll')).toBe(false);
      host.remove();
    });

    it('passes no plugins when nothing is scrolled', async () => {
      const snapdom = vi.fn(async (_r: HTMLElement, _o: Record<string, unknown>) => ({
        toCanvas: async () => document.createElement('canvas'),
      }));
      vi.doMock('@zumer/snapdom', () => ({ snapdom }));
      const { renderViewportWithSnapdom } = await import('../../src/capture/renderers/snapdom-renderer.js');
      await renderViewportWithSnapdom(document.body, { pixelRatio: 1, filter: () => true });
      const opts = snapdom.mock.calls[0]![1];
      expect('plugins' in opts).toBe(false);
    });
  });
});
