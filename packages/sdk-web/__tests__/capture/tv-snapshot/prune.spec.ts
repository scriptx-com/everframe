// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest';
import { pruneSnapshot, type PruneDeps, type PruneRect } from '../../../src/capture/tv-snapshot/prune.js';
import type { SnElement, SnNode } from '../../../src/capture/tv-snapshot/sn-types.js';
import { doc, el, find, resetIds, text } from './sn-builders.js';
import { findLeaks } from './leak-assert.js';

const VIEWPORT = { width: 1280, height: 720 };
const rect = (left: number, top: number, width: number, height: number): PruneRect => ({
  left, top, width, height, right: left + width, bottom: top + height,
});
/** Placeholder declarations are all !important (author resets cannot resize them). */
const imp = (css: string): string => css.split(';').map((d) => `${d}!important`).join(';');
const ON = rect(0, 0, 100, 20);
const ABOVE = rect(0, -1300, 1280, 1200);

const BLOCK: Partial<CSSStyleDeclaration> = {
  display: 'block', position: 'static', marginTop: '10px', marginRight: '0px', marginBottom: '20px', marginLeft: '0px',
  alignSelf: 'auto', order: '0', gridRowStart: 'auto', gridRowEnd: 'auto', gridColumnStart: 'auto', gridColumnEnd: 'auto',
  cssFloat: 'none', clear: 'none', verticalAlign: 'baseline', top: 'auto', right: 'auto', bottom: 'auto', left: 'auto', zIndex: 'auto',
};

interface Live { rect?: PruneRect; style?: Partial<CSSStyleDeclaration>; size?: { width: number; height: number }; attrs?: Record<string, string> }

function harness() {
  const byId = new Map<number, Element>();
  const meta = new WeakMap<Element, Live>();
  const bind = (sn: SnElement, live: Live = {}): SnElement => {
    const node = document.createElement(sn.tagName);
    for (const [k, v] of Object.entries(live.attrs ?? {})) node.setAttribute(k, v);
    byId.set(sn.id, node);
    meta.set(node, live);
    return sn;
  };
  const deps: PruneDeps = {
    nodeFor: (id) => byId.get(id) ?? null,
    rectOf: (e) => meta.get(e)?.rect ?? ON,
    styleOf: (e) => ({ ...BLOCK, ...(meta.get(e)?.style ?? {}) }) as CSSStyleDeclaration,
    sizeOf: (e, r) => meta.get(e)?.size ?? { width: r.width, height: r.height },
    isSensitive: (e) => e.hasAttribute('data-everframe-sensitive'),
    viewport: VIEWPORT,
  };
  return { bind, deps };
}

beforeEach(() => resetIds());

describe('pruneSnapshot', () => {
  it('replaces an in-flow off-screen previous screen with a same-box hidden placeholder', () => {
    const { bind, deps } = harness();
    const previous = bind(el('section', { id: 'previous', class: 'screen' }, [text('PREVIOUSSCREEN')]), { rect: ABOVE, size: { width: 1280, height: 1200 } });
    const current = bind(el('main', { id: 'current' }, [text('visible')]));
    const root = doc(el('html', {}, [el('head'), el('body', {}, [previous, current])]));
    const result = pruneSnapshot(root, deps);
    expect(previous.childNodes).toEqual([]);
    expect(previous.attributes).toEqual({
      style: expect.stringContaining(imp('display:block;position:static;box-sizing:border-box;width:1280px;height:1200px')),
    });
    expect(String(previous.attributes.style)).toContain(imp('margin:10px 0px 20px 0px'));
    expect(String(previous.attributes.style)).toContain('visibility:hidden');
    expect(findLeaks(JSON.stringify(root), ['PREVIOUSSCREEN'])).toEqual([]);
    expect(current.childNodes).toHaveLength(1);
    expect(result.pruned).toBe(1);
    expect(result.masked).toBe(false);
  });

  it('keeps an off-screen parent whose fixed child is on screen', () => {
    const { bind, deps } = harness();
    const child = bind(el('div', { id: 'fab' }, [text('FAB')]), { rect: rect(20, 600, 100, 40), style: { position: 'fixed' } });
    const parent = bind(el('div', { id: 'offscreen-parent' }, [child]), { rect: ABOVE });
    pruneSnapshot(doc(el('html', {}, [el('body', {}, [parent])])), deps);
    expect(parent.childNodes).toEqual([child]);
    expect(child.childNodes).toHaveLength(1);
  });

  it('turns out-of-flow and display:none off-screen subtrees into display:none placeholders, never removing them', () => {
    const { bind, deps } = harness();
    const abs = bind(el('div', {}, [text('ABS')]), { rect: ABOVE, style: { position: 'absolute' } });
    const none = bind(el('div', {}, [text('NONE')]), { rect: rect(0, 0, 0, 0), style: { display: 'none' } });
    const body = el('body', {}, [abs, none]);
    pruneSnapshot(doc(el('html', {}, [body])), deps);
    expect(body.childNodes).toEqual([abs, none]);
    expect(abs.attributes).toEqual({ style: imp('display:none') });
    expect(none.attributes).toEqual({ style: imp('display:none') });
    expect(abs.childNodes).toEqual([]);
  });

  it('never prunes inline or display:contents elements themselves', () => {
    const { bind, deps } = harness();
    const inline = bind(el('span', { class: 'x' }, [text('INLINETEXT')]), { rect: ABOVE, style: { display: 'inline' } });
    const contents = bind(el('div', { class: 'y' }, []), { rect: rect(0, 0, 0, 0), style: { display: 'contents' } });
    const p = bind(el('p', {}, [inline, contents]));
    pruneSnapshot(doc(el('html', {}, [el('body', {}, [p])])), deps);
    // Kept (padding and border folded into its fragment placeholders) — its text is not.
    expect(inline.attributes).toEqual({ class: 'x', style: imp('padding:0;border:0') });
    expect(findLeaks(JSON.stringify(inline), ['INLINETEXT'])).toEqual([]);
    expect(contents.attributes).toEqual({ class: 'y' });
  });

  it('never prunes style, link or head content, even when they have no box', () => {
    const { bind, deps } = harness();
    const style = bind(el('style', { _cssText: 'a{color:red}' }), { rect: rect(0, 0, 0, 0), style: { display: 'none' } });
    const link = bind(el('link', { rel: 'stylesheet', href: 'https://x.test/a.css' }), { rect: rect(0, 0, 0, 0), style: { display: 'none' } });
    const title = el('title', {}, [text('Home')]);
    pruneSnapshot(doc(el('html', {}, [el('head', {}, [title]), el('body', {}, [style, link])])), deps);
    expect(style.attributes).toEqual({ _cssText: 'a{color:red}' });
    expect(link.attributes).toMatchObject({ rel: 'stylesheet' });
    expect(title.childNodes).toHaveLength(1);
  });

  it('removes script, noscript, base and SDK chrome', () => {
    const { bind, deps } = harness();
    const chrome = bind(el('div', {}, [text('REPORTERUI')]), { attrs: { 'data-everframe-skip-capture': 'true' } });
    const body = el('body', {}, [el('script'), el('noscript', {}, [text('<img src=x>')]), chrome, bind(el('p', {}, [text('ok')]))]);
    const head = el('head', {}, [el('base', { href: 'https://x.test/' })]);
    const root = doc(el('html', {}, [head, body]));
    pruneSnapshot(root, deps);
    expect(body.childNodes.map((n) => (n as SnElement).tagName)).toEqual(['p']);
    expect(head.childNodes).toEqual([]);
    expect(findLeaks(JSON.stringify(root), ['REPORTERUI', '<img'])).toEqual([]);
  });

  it('turns a blocked sensitive element into a black same-box placeholder and marks the page masked', () => {
    const { bind, deps } = harness();
    const vault = bind(el('section', { class: 'rr-block secret', rr_width: '300px', rr_height: '80px' }), {
      rect: rect(10, 10, 300, 80), size: { width: 300, height: 80 }, style: { position: 'absolute', top: '10px', left: '10px', zIndex: '3' },
    });
    const result = pruneSnapshot(doc(el('html', {}, [el('body', {}, [vault])])), deps);
    expect(result.masked).toBe(true);
    const style = String(vault.attributes.style);
    expect(Object.keys(vault.attributes)).toEqual(['style']);
    expect(style).toContain(imp('width:300px;height:80px'));
    expect(style).toContain('position:absolute');
    expect(style).toContain('top:10px');
    expect(style).toContain('background:#000');
    expect(result.hiddenIds.has(vault.id)).toBe(true);
  });

  it('masks bare text inside a sensitive display:contents wrapper (Review Focus 1)', () => {
    const { bind, deps } = harness();
    const wrap = bind(el('span', { id: 'wrap' }, [text('99887766')]), {
      style: { display: 'contents' }, rect: rect(0, 0, 0, 0), attrs: { 'data-everframe-sensitive': '' },
    });
    const line = bind(el('p', {}, [text('Account: '), wrap]));
    const root = doc(el('html', {}, [el('body', {}, [line])]));
    const result = pruneSnapshot(root, deps);
    expect(result.masked).toBe(true);
    expect(findLeaks(JSON.stringify(root), ['99887766'])).toEqual([]);
    expect(JSON.stringify(root)).toContain('••••••••');
  });

  it('keeps an off-screen svg that defines ids (sprites/gradients) and prunes one that does not', () => {
    const { bind, deps } = harness();
    const sprite = bind(el('svg', {}, [el('symbol', { id: 'play' }, [], { isSVG: true })], { isSVG: true }), { rect: ABOVE });
    const icon = bind(el('svg', {}, [el('text', {}, [text('ICONTEXT')], { isSVG: true })], { isSVG: true }), { rect: ABOVE });
    const visibleUse = bind(el('svg', {}, [el('use', { href: '#play' }, [], { isSVG: true })], { isSVG: true }));
    pruneSnapshot(doc(el('html', {}, [el('body', {}, [sprite, icon, visibleUse])])), deps);
    expect(sprite.childNodes).toHaveLength(1);
    expect(icon.childNodes).toEqual([]);
  });

  it('prunes an off-screen inline svg root (its computed display in browsers) to an inline-block box', () => {
    const { bind, deps } = harness();
    const icon = bind(el('svg', { class: 'i' }, [el('path', { d: 'M0 0' }, [], { isSVG: true })], { isSVG: true }), {
      rect: ABOVE, style: { display: 'inline' }, size: { width: 24, height: 24 },
    });
    const result = pruneSnapshot(doc(el('html', {}, [el('body', {}, [icon])])), deps);
    expect(result.pruned).toBe(1);
    expect(icon.childNodes).toEqual([]);
    expect(String(icon.attributes.style)).toContain(imp('display:inline-block;position:static;box-sizing:border-box;width:24px;height:24px'));
  });

  it('prunes off-screen inline replaced elements inside a visible block to same-box inline-block placeholders with no URL (S20)', () => {
    const { bind, deps } = harness();
    const inlineOff = { display: 'inline', marginTop: '0px', marginRight: '8px', marginBottom: '0px', marginLeft: '0px' };
    const img = bind(el('img', { src: 'https://cdn.test/OFFSCREENIMG.png', srcset: 'https://cdn.test/OFFSCREENIMG@2x.png 2x', alt: 'x' }), {
      rect: rect(1400, 100, 200, 120), size: { width: 200, height: 120 }, style: inlineOff,
    });
    const video = bind(el('video', { poster: 'https://cdn.test/OFFSCREENPOSTER.jpg', src: 'https://cdn.test/OFFSCREENVIDEO.mp4' }), {
      rect: rect(1700, 100, 320, 180), size: { width: 320, height: 180 }, style: inlineOff,
    });
    const imageInput = bind(el('input', { type: 'IMAGE', src: 'https://cdn.test/OFFSCREENINPUT.png' }), {
      rect: rect(2100, 100, 40, 40), size: { width: 40, height: 40 }, style: inlineOff,
    });
    const onImg = bind(el('img', { src: 'https://cdn.test/visible.png' }), { rect: rect(10, 100, 200, 120), style: { display: 'inline' } });
    const row = bind(el('div', { class: 'row' }, [onImg, img, video, imageInput]), { rect: rect(0, 100, 1280, 120) });
    const root = doc(el('html', {}, [el('body', {}, [row])]));
    const result = pruneSnapshot(root, deps);
    expect(row.childNodes).toEqual([onImg, img, video, imageInput]);
    expect(onImg.attributes).toEqual({ src: 'https://cdn.test/visible.png' });
    for (const [node, w, h] of [[img, 200, 120], [video, 320, 180], [imageInput, 40, 40]] as const) {
      expect(Object.keys(node.attributes)).toEqual(['style']);
      const style = String(node.attributes.style);
      expect(style).toContain(imp(`display:inline-block;position:static;box-sizing:border-box;width:${w}px;height:${h}px`));
      expect(style).toContain(imp('margin:0px 8px 0px 0px'));
      expect(style).toContain('visibility:hidden');
      expect(node.childNodes).toEqual([]);
    }
    expect(result.pruned).toBe(3);
    expect(findLeaks(JSON.stringify(root), ['OFFSCREENIMG', 'OFFSCREENPOSTER', 'OFFSCREENVIDEO', 'OFFSCREENINPUT'])).toEqual([]);
  });

  it('still never prunes an off-screen inline non-replaced element or a text input', () => {
    const { bind, deps } = harness();
    const span = bind(el('span', { class: 's' }, [text('t')]), { rect: rect(1400, 0, 50, 20), style: { display: 'inline' } });
    const input = bind(el('input', { type: 'text' }), { rect: rect(1400, 0, 50, 20), style: { display: 'inline' } });
    const p = bind(el('p', {}, [span, input]));
    pruneSnapshot(doc(el('html', {}, [el('body', {}, [p])])), deps);
    expect(span.attributes).toEqual({ class: 's', style: imp('padding:0;border:0') });
    expect(span.childNodes).toEqual([expect.objectContaining({ tagName: 'span', childNodes: [] })]);
    expect(input.attributes).toEqual({ type: 'text' });
  });

  it('prunes an off-screen screen holding an icon that defines a clipPath id, re-homing only the definitions (fix 1)', () => {
    const { bind, deps } = harness();
    const clip = el('clipPath', { id: 'clip0' }, [el('rect', { width: '24', height: '24' }, [], { isSVG: true })], { isSVG: true });
    const defs = el('defs', {}, [clip], { isSVG: true });
    const icon = bind(
      el('svg', { class: 'icon', width: '24', height: '24', 'aria-label': 'ICONLABEL' }, [
        el('title', {}, [text('ICONTITLE')], { isSVG: true }),
        el('g', { 'clip-path': 'url(#clip0)' }, [el('path', { d: 'M0 0L24 24' }, [], { isSVG: true })], { isSVG: true }),
        defs,
      ], { isSVG: true }),
      { rect: ABOVE, style: { display: 'inline' } },
    );
    const link = bind(el('a', { href: 'https://secret.test/account' }, [text('SECRETLINK')]), { rect: ABOVE });
    const section = bind(el('section', {}, [text('SECRETTEXT'), link, icon]), { rect: ABOVE, size: { width: 1280, height: 1200 } });
    // A visible element still clips with it, so the definition must survive.
    const current = bind(el('main', { style: 'clip-path:url(#clip0)' }, [text('visible')]));
    const root = doc(el('html', {}, [el('body', {}, [section, current])]));
    pruneSnapshot(root, deps);
    expect(section.childNodes).toEqual([icon]);
    expect(String(section.attributes.style)).toContain(imp('width:1280px;height:1200px'));
    expect(icon.attributes).toEqual({ width: '0', height: '0', style: imp('position:absolute;width:0;height:0;overflow:hidden;visibility:visible') });
    expect(icon.childNodes).toEqual([defs]);
    expect(defs.childNodes).toEqual([clip]);
    expect(findLeaks(JSON.stringify(root), ['SECRETTEXT', 'SECRETLINK', 'secret.test', 'ICONTITLE', 'ICONLABEL', 'M0 0L24'])).toEqual([]);
  });

  it('carries definitions to the topmost pruned ancestor and keeps them out of display:none (fix 1)', () => {
    const { bind, deps } = harness();
    const sprite = bind(el('svg', {}, [el('symbol', { id: 'play' }, [el('path', { d: 'M1 1' }, [], { isSVG: true })], { isSVG: true })], { isSVG: true }), { rect: ABOVE });
    const inner = bind(el('div', {}, [sprite]), { rect: ABOVE });
    const overlay = bind(el('div', {}, [inner, text('OVERLAYTEXT')]), { rect: ABOVE, style: { position: 'absolute' } });
    const visibleUse = bind(el('svg', {}, [el('use', { 'xlink:href': '#play' }, [], { isSVG: true })], { isSVG: true }));
    const root = doc(el('html', {}, [el('body', {}, [overlay, visibleUse])]));
    pruneSnapshot(root, deps);
    expect(overlay.childNodes).toEqual([sprite]);
    expect(overlay.attributes).toEqual({
      style: imp('display:block;position:absolute;width:0;height:0;overflow:hidden;visibility:hidden'),
    });
    expect(sprite.childNodes).toHaveLength(1);
    expect(findLeaks(JSON.stringify(root), ['OVERLAYTEXT'])).toEqual([]);
  });

  it('drops a carried definition nothing visible references', () => {
    const { bind, deps } = harness();
    const sprite = bind(el('svg', {}, [el('symbol', { id: 'play' }, [el('text', {}, [text('SYMBOLTEXT')], { isSVG: true })], { isSVG: true })], { isSVG: true }), { rect: ABOVE });
    const section = bind(el('section', {}, [sprite]), { rect: ABOVE });
    const root = doc(el('html', {}, [el('body', {}, [section, bind(el('main', {}, [text('visible')]))])]));
    const result = pruneSnapshot(root, deps);
    expect(findLeaks(JSON.stringify(root), ['SYMBOLTEXT'])).toEqual([]);
    expect(result.changed).toBe(true);
  });

  it('prunes an off-screen svg whose only ids are on non-definition elements', () => {
    const { bind, deps } = harness();
    const exported = bind(el('svg', {}, [el('g', { id: 'Layer_1' }, [el('path', { d: 'M0 0' }, [], { isSVG: true })], { isSVG: true })], { isSVG: true }), { rect: ABOVE });
    const result = pruneSnapshot(doc(el('html', {}, [el('body', {}, [exported])])), deps);
    expect(result.pruned).toBe(1);
    expect(exported.childNodes).toEqual([]);
  });

  describe('collapsed child margins on block placeholders (fix 2)', () => {
    const zero = { marginTop: '0px', marginBottom: '0px' };
    const pruneOne = (children: (b: ReturnType<typeof harness>['bind']) => SnNode[], sectionStyle: Partial<CSSStyleDeclaration> = zero, bodyStyle?: Partial<CSSStyleDeclaration>) => {
      const { bind, deps } = harness();
      const section = bind(el('section', {}, children(bind)), { rect: ABOVE, style: sectionStyle });
      const body = el('body', {}, [section]);
      if (bodyStyle) bind(body, { style: bodyStyle });
      pruneSnapshot(doc(el('html', {}, [body])), deps);
      return String(section.attributes.style);
    };
    const h = (b: ReturnType<typeof harness>['bind'], tag: string, style: Partial<CSSStyleDeclaration>, kids: SnNode[] = [text('T')]) =>
      b(el(tag, {}, kids), { rect: ABOVE, style });

    it('adds the first child top margin and the last child bottom margin that collapse through it', () => {
      const style = pruneOne((b) => [h(b, 'h2', { marginTop: '24px', marginBottom: '16px' }), h(b, 'p', { marginTop: '12px', marginBottom: '12px' })]);
      expect(style).toContain(imp('margin:24px 0px 12px 0px'));
    });

    it('combines positive and negative margins (max positive + most negative)', () => {
      const style = pruneOne((b) => [h(b, 'h2', { marginTop: '-5px', marginBottom: '30px' })], { marginTop: '10px', marginBottom: '-8px' });
      expect(style).toContain(imp('margin:5px 0px 22px 0px'));
    });

    it('follows the chain through nested collapsing blocks', () => {
      const style = pruneOne((b) => [h(b, 'div', zero, [h(b, 'div', zero, [h(b, 'h2', { marginTop: '30px', marginBottom: '0px' })])])]);
      expect(style).toContain(imp('margin:30px 0px 0px 0px'));
    });

    it('skips out-of-flow first children and whitespace text', () => {
      const style = pruneOne((b) => [text('\n  '), h(b, 'div', { position: 'absolute', marginTop: '99px' }), h(b, 'h2', { marginTop: '18px', marginBottom: '0px' })]);
      expect(style).toContain(imp('margin:18px 0px 0px 0px'));
    });

    it('stops at leading text, padding/border, BFC roots and flex parents', () => {
      const child = (b: ReturnType<typeof harness>['bind']) => [h(b, 'h2', { marginTop: '24px', marginBottom: '24px' })];
      expect(pruneOne((b) => [text('lead'), ...child(b), text('tail')])).toContain(imp('margin:0px 0px 0px 0px'));
      expect(pruneOne(child, { ...zero, paddingTop: '1px', borderBottomWidth: '2px' })).toContain(imp('margin:0px 0px 0px 0px'));
      expect(pruneOne(child, { ...zero, overflow: 'hidden', overflowX: 'hidden', overflowY: 'hidden' })).toContain(imp('margin:0px 0px 0px 0px'));
      expect(pruneOne(child, { ...zero, display: 'flow-root' })).toContain(imp('margin:0px 0px 0px 0px'));
      expect(pruneOne(child, zero, { display: 'flex' })).toContain(imp('margin:0px 0px 0px 0px'));
    });

    it('bounds the probe depth', () => {
      const style = pruneOne((b) => {
        let node = h(b, 'h2', { marginTop: '40px', marginBottom: '0px' });
        for (let i = 0; i < 20; i++) node = h(b, 'div', zero, [node]);
        return [node];
      });
      expect(style).toContain(imp('margin:40px 0px 0px 0px')); // pruned children carry their collapsed margin up
    });
  });

  it('keeps display:list-item on list placeholders so counters do not restart', () => {
    const { bind, deps } = harness();
    const li = bind(el('li', {}, [text('ITEM')]), { rect: ABOVE, style: { display: 'list-item' } });
    pruneSnapshot(doc(el('html', {}, [el('body', {}, [el('ol', {}, [li])])])), deps);
    expect(String(li.attributes.style)).toContain(imp('display:list-item'));
  });

  it('strips text- and URL-bearing attributes from kept off-screen inline elements', () => {
    const { bind, deps } = harness();
    const link = bind(
      el('a', { class: 'k', href: 'https://secret.test/', title: 'TIP', 'aria-label': 'LABEL', 'data-user': 'alice', alt: 'ALT', placeholder: 'PH' }, [text('x')]),
      { rect: rect(1400, 0, 50, 20), style: { display: 'inline' } },
    );
    pruneSnapshot(doc(el('html', {}, [el('body', {}, [bind(el('p', {}, [link]))])])), deps);
    expect(link.attributes).toEqual({ class: 'k', style: imp('padding:0;border:0') });
  });

  it('clips SVG text to an inline SVG root\'s viewport (an atomic box clips even when inline)', () => {
    const { bind, deps } = harness();
    const inside = bind(el('text', {}, [text('INSIDE')], { isSVG: true }), { rect: rect(10, 0, 50, 20) });
    const outside = bind(el('text', {}, [text('OUTSIDE_SVG_VIEWPORT')], { isSVG: true }), { rect: rect(500, 0, 50, 20) });
    const svg = bind(el('svg', {}, [inside, outside], { isSVG: true }), {
      rect: rect(0, 0, 120, 30),
      style: { display: 'inline', overflowX: 'hidden', overflowY: 'hidden' },
    });
    const root = doc(el('html', {}, [el('body', {}, [svg])]));
    pruneSnapshot(root, deps);
    expect(findLeaks(JSON.stringify(root), ['OUTSIDE_SVG_VIEWPORT'])).toEqual([]);
    expect(JSON.stringify(root)).toContain('INSIDE');
  });

  it('reads no layout for SVG leaves, definitions, or content of an unseen SVG root', () => {
    const { bind, deps } = harness();
    const reads: Element[] = [];
    const styleOf = deps.styleOf;
    deps.styleOf = (e) => {
      reads.push(e);
      return styleOf(e);
    };
    const leaf = bind(el('path', { d: 'M0 0' }, [], { isSVG: true }));
    const defText = bind(el('text', {}, [text('DEF')], { isSVG: true }));
    const defs = bind(el('defs', {}, [bind(el('symbol', { id: 'p' }, [defText], { isSVG: true }))], { isSVG: true }));
    const visible = bind(el('svg', {}, [leaf, defs], { isSVG: true }));
    const offText = bind(el('text', {}, [text('OFF')], { isSVG: true }));
    // Inline, as SVG roots are: a block placeholder's margin-collapse probe would read its first child.
    const unseen = bind(el('svg', {}, [offText], { isSVG: true }), { rect: ABOVE, style: { display: 'inline' } });
    pruneSnapshot(doc(el('html', {}, [el('body', {}, [visible, unseen])])), deps);
    const live = (sn: SnElement) => deps.nodeFor(sn.id);
    for (const [name, sn] of Object.entries({ leaf, defs, defText, offText })) expect(reads.includes(live(sn) as Element), name).toBe(false);
  });

  it('records every pruned or masked node id, descendants included, as hidden', () => {
    const { bind, deps } = harness();
    const inner = el('button', { id: 'b' });
    const offscreen = bind(el('div', {}, [inner]), { rect: ABOVE });
    const result = pruneSnapshot(doc(el('html', {}, [el('body', {}, [offscreen])])), deps);
    expect(result.hiddenIds.has(offscreen.id)).toBe(true);
    expect(result.hiddenIds.has(inner.id)).toBe(true);
    expect(find(doc(offscreen), (e) => e.id === inner.id)).toBeUndefined();
  });

  it('keeps a scrolled container geometry: off-screen siblings before the visible area become same-box placeholders and rr_scroll* survives', () => {
    const { bind, deps } = harness();
    // A rail scrolled down by 600px: rows 0-2 (200px each) are above the viewport, row 3 is visible.
    const rows = [0, 1, 2, 3].map((i) =>
      bind(el('div', { class: 'row' }, [text(`ROW${i}CONTENT`)]), {
        rect: rect(0, i * 200 - 600, 1280, 200), size: { width: 1280, height: 200 }, style: { marginTop: '0px', marginBottom: '0px' },
      }),
    );
    const scroller = bind(el('div', { class: 'scroller', rr_scrollTop: 600, rr_scrollLeft: 0 }, rows), { rect: rect(0, 0, 1280, 720) });
    const root = doc(el('html', {}, [el('body', {}, [scroller])]));
    const result = pruneSnapshot(root, deps);
    expect(scroller.attributes).toEqual({ class: 'scroller', rr_scrollTop: 600, rr_scrollLeft: 0 });
    expect(scroller.childNodes).toEqual(rows);
    for (const row of rows.slice(0, 3)) {
      expect(row.childNodes).toEqual([]);
      expect(String(row.attributes.style)).toContain(imp('width:1280px;height:200px'));
      expect(String(row.attributes.style)).toContain(imp('margin:0px 0px 0px 0px'));
      expect(String(row.attributes.style)).toContain('visibility:hidden');
    }
    expect(rows[3]?.childNodes).toHaveLength(1);
    expect(findLeaks(JSON.stringify(root), ['ROW0CONTENT', 'ROW1CONTENT', 'ROW2CONTENT'])).toEqual([]);
    expect(result.pruned).toBe(3);
  });

  it('keeps a live-less wrapper whose descendant is on screen, so its off-screen ancestor is not pruned', () => {
    const { bind, deps } = harness();
    const leaf = bind(el('p', {}, [text('LEAF')]), { rect: rect(0, 100, 100, 20) });
    const wrapper = el('div', {}, [leaf]); // no live node
    const outer = bind(el('div', {}, [wrapper]), { rect: ABOVE });
    pruneSnapshot(doc(el('html', {}, [el('body', {}, [outer])])), deps);
    expect(outer.childNodes).toEqual([wrapper]);
    expect(wrapper.childNodes).toEqual([leaf]);
  });

  it('removes a script inside an svg and does not read layout for svg content', () => {
    const { bind, deps } = harness();
    const path = bind(el('path', { d: 'M0 0' }, [], { isSVG: true }));
    const svg = bind(el('svg', {}, [el('script', {}, [text('evil()')], { isSVG: true }), path], { isSVG: true }));
    const reads: Element[] = [];
    const rectOf = deps.rectOf;
    deps.rectOf = (e) => {
      reads.push(e);
      return rectOf(e);
    };
    pruneSnapshot(doc(el('html', {}, [el('body', {}, [svg])])), deps);
    expect(svg.childNodes).toEqual([path]);
    expect(reads).not.toContain(deps.nodeFor(path.id));
  });

  it('reads each element rect and computed style at most once (S18)', () => {
    const { bind, deps } = harness();
    const visible = bind(el('p', {}, [text('v')]));
    const off = bind(el('p', {}, [text('o')]), { rect: ABOVE });
    const rects = new Map<Element, number>();
    const styles = new Map<Element, number>();
    const { rectOf, styleOf } = deps;
    deps.rectOf = (e) => {
      rects.set(e, (rects.get(e) ?? 0) + 1);
      return rectOf(e);
    };
    deps.styleOf = (e) => {
      styles.set(e, (styles.get(e) ?? 0) + 1);
      return styleOf(e);
    };
    pruneSnapshot(doc(el('html', {}, [el('body', {}, [visible, off])])), deps);
    expect([...rects.values()].every((n) => n === 1)).toBe(true);
    expect([...styles.values()].every((n) => n === 1)).toBe(true);
    expect(styles.get(deps.nodeFor(visible.id) as Element)).toBe(1);
    expect(styles.get(deps.nodeFor(off.id) as Element)).toBe(1);
  });

  it('never copies page-controlled rr_width/rr_height text into a placeholder style', () => {
    const { deps } = harness();
    const forged = el('div', { rr_width: '1px;background:url(https://evil.test/x)', rr_height: '2px' }, [text('SECRET')]);
    const root = doc(el('html', {}, [el('body', {}, [forged])]));
    const result = pruneSnapshot(root, deps);
    expect(result.masked).toBe(true);
    expect(forged.childNodes).toEqual([]);
    expect(forged.attributes).toEqual({ style: imp('display:inline-block;width:1px;height:2px;background:#000') });
    expect(findLeaks(JSON.stringify(root), ['evil.test', 'SECRET'])).toEqual([]);
  });

  it('removes SDK chrome marked only in the serialized attributes', () => {
    const { deps } = harness();
    const body = el('body', {}, [el('div', { 'data-everframe-skip-capture': 'true' }, [text('REPORTERUI')])]);
    const root = doc(el('html', {}, [body]));
    pruneSnapshot(root, deps);
    expect(body.childNodes).toEqual([]);
  });

  it('walks a 20,000-deep tree without overflowing the stack', () => {
    const { bind, deps } = harness();
    let node = bind(el('div', {}, [text('DEEPLEAF')]), { rect: ABOVE });
    for (let i = 0; i < 20_000; i++) node = bind(el('div', {}, [node]), { rect: ABOVE });
    const root = doc(el('html', {}, [el('body', {}, [node])]));
    const result = pruneSnapshot(root, deps);
    expect(result.pruned).toBeGreaterThan(0);
    expect(node.childNodes).toEqual([]);
    expect(result.hiddenIds.size).toBe(20_002);
  });

  it('masks a 20k-character near-miss text inside a sensitive display:contents wrapper in under a second', () => {
    const { bind, deps } = harness();
    const long = `${'1 '.repeat(10_000)}x`;
    const wrap = bind(el('span', {}, [text(long)]), {
      style: { display: 'contents' }, rect: rect(0, 0, 0, 0), attrs: { 'data-everframe-sensitive': '' },
    });
    const root = doc(el('html', {}, [el('body', {}, [wrap])]));
    const started = performance.now();
    pruneSnapshot(root, deps);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(wrap.childNodes[0]).toMatchObject({ textContent: `${'• '.repeat(10_000)}•` });
  });
});

describe('pruneSnapshot — hidden, transparent and clipped content (final review finding 2)', () => {
  const body = (children: SnNode[]) => doc(el('html', {}, [el('head'), el('body', {}, children)]));

  it('prunes an in-viewport visibility:hidden overlay to a same-box placeholder', () => {
    const { bind, deps } = harness();
    const overlay = bind(el('div', { id: 'overlay' }, [text('HIDDENPIN 4921')]), { rect: rect(100, 100, 400, 200), style: { visibility: 'hidden' } });
    const root = body([overlay]);
    const result = pruneSnapshot(root, deps);
    expect(overlay.childNodes).toEqual([]);
    expect(String(overlay.attributes.style)).toContain(imp('width:400px;height:200px'));
    expect(findLeaks(JSON.stringify(root), ['HIDDENPIN', '4921'])).toEqual([]);
    expect(result.pruned).toBe(1);
  });

  it('treats visibility:collapse like hidden', () => {
    const { bind, deps } = harness();
    const row = bind(el('tr', {}, [text('COLLAPSEDROW')]), { style: { visibility: 'collapse' } });
    const root = body([row]);
    pruneSnapshot(root, deps);
    expect(findLeaks(JSON.stringify(root), ['COLLAPSEDROW'])).toEqual([]);
  });

  it('propagates opacity:0 to descendants (opacity does not inherit)', () => {
    const { bind, deps } = harness();
    const inner = bind(el('p', {}, [text('FADEDTEXT')]), { style: { opacity: '1' } });
    const faded = bind(el('div', {}, [inner]), { rect: rect(0, 0, 600, 300), style: { opacity: '0' } });
    const root = body([faded]);
    pruneSnapshot(root, deps);
    expect(faded.childNodes).toEqual([]);
    expect(findLeaks(JSON.stringify(root), ['FADEDTEXT'])).toEqual([]);
  });

  it('keeps a visibility:visible child of a hidden parent but masks the parent\'s own bare text', () => {
    const { bind, deps } = harness();
    const child = bind(el('span', {}, [text('SHOWN')]), { style: { visibility: 'visible' } });
    const parent = bind(el('div', {}, [text('PARENTSECRET'), child]), { style: { visibility: 'hidden' } });
    const root = body([parent]);
    pruneSnapshot(root, deps);
    expect(parent.childNodes).toHaveLength(2);
    expect(JSON.stringify(root)).toContain('SHOWN');
    expect(findLeaks(JSON.stringify(root), ['PARENTSECRET'])).toEqual([]);
  });

  it('opacity other than 0 and visibility:visible stay seen', () => {
    const { bind, deps } = harness();
    const dim = bind(el('p', {}, [text('DIM')]), { style: { opacity: '0.4', visibility: 'visible' } });
    const root = body([dim]);
    expect(pruneSnapshot(root, deps).pruned).toBe(0);
    expect(JSON.stringify(root)).toContain('DIM');
  });

  it('prunes a rail item scrolled out of an overflow:hidden rail even though it is inside the viewport', () => {
    const { bind, deps } = harness();
    const inRail = bind(el('div', {}, [text('TILEONE')]), { rect: rect(100, 100, 200, 100) });
    const clipped = bind(el('div', {}, [text('TILECLIPPED')]), { rect: rect(620, 100, 200, 100) });
    const rail = bind(el('div', { class: 'rail' }, [inRail, clipped]), {
      rect: rect(100, 100, 500, 100),
      style: { overflowX: 'hidden', overflowY: 'hidden', display: 'flex' },
    });
    const root = body([rail]);
    pruneSnapshot(root, deps);
    expect(JSON.stringify(root)).toContain('TILEONE');
    expect(findLeaks(JSON.stringify(root), ['TILECLIPPED'])).toEqual([]);
    expect(String(clipped.attributes.style)).toContain(imp('width:200px;height:100px'));
  });

  it('clips against a scroll container\'s padding box (borders excluded) and per axis', () => {
    const { bind, deps } = harness();
    // Rail border box 100..600 with 10px borders: padding box 110..590.
    const underBorder = bind(el('div', {}, [text('UNDERBORDER')]), { rect: rect(592, 100, 5, 50) });
    const below = bind(el('div', {}, [text('BELOWRAIL')]), { rect: rect(200, 400, 100, 50) });
    const rail = bind(el('div', {}, [underBorder, below]), {
      rect: rect(100, 100, 500, 100),
      style: { overflowX: 'scroll', overflowY: 'visible', borderLeftWidth: '10px', borderRightWidth: '10px' },
    });
    const root = body([rail]);
    pruneSnapshot(root, deps);
    expect(findLeaks(JSON.stringify(root), ['UNDERBORDER'])).toEqual([]);
    // overflow-y visible: content below the rail is not clipped vertically.
    expect(JSON.stringify(root)).toContain('BELOWRAIL');
  });

  it('nested clips intersect: a child inside the inner clip but outside the outer one is pruned', () => {
    const { bind, deps } = harness();
    const leaf = bind(el('p', {}, [text('OUTSIDEOUTER')]), { rect: rect(350, 50, 40, 20) });
    const inner = bind(el('div', {}, [leaf]), { rect: rect(0, 0, 400, 100), style: { overflowX: 'hidden', overflowY: 'hidden' } });
    const outer = bind(el('div', {}, [inner]), { rect: rect(0, 0, 300, 100), style: { overflowX: 'auto', overflowY: 'auto' } });
    const root = body([outer]);
    pruneSnapshot(root, deps);
    expect(findLeaks(JSON.stringify(root), ['OUTSIDEOUTER'])).toEqual([]);
  });

  it('an absolutely positioned child escapes the clip of a non-positioned ancestor below its containing block', () => {
    const { bind, deps } = harness();
    const popup = bind(el('div', {}, [text('POPUP')]), { rect: rect(500, 300, 100, 50), style: { position: 'absolute' } });
    const clipper = bind(el('div', {}, [popup]), { rect: rect(0, 0, 200, 100), style: { overflowX: 'hidden', overflowY: 'hidden' } });
    const root = body([clipper]);
    pruneSnapshot(root, deps);
    expect(JSON.stringify(root)).toContain('POPUP');
  });

  it('an absolutely positioned child IS clipped by a positioned overflow:hidden ancestor', () => {
    const { bind, deps } = harness();
    const popup = bind(el('div', {}, [text('ABSCLIPPED')]), { rect: rect(500, 300, 100, 50), style: { position: 'absolute' } });
    const clipper = bind(el('div', {}, [popup]), {
      rect: rect(0, 0, 200, 100),
      style: { position: 'relative', overflowX: 'hidden', overflowY: 'hidden' },
    });
    const root = body([clipper]);
    pruneSnapshot(root, deps);
    expect(findLeaks(JSON.stringify(root), ['ABSCLIPPED'])).toEqual([]);
  });

  it('a fixed child escapes every ancestor clip', () => {
    const { bind, deps } = harness();
    const toast = bind(el('div', {}, [text('TOAST')]), { rect: rect(900, 600, 200, 60), style: { position: 'fixed' } });
    const clipper = bind(el('div', {}, [toast]), {
      rect: rect(0, 0, 200, 100),
      style: { position: 'relative', overflowX: 'hidden', overflowY: 'hidden' },
    });
    const root = body([clipper]);
    pruneSnapshot(root, deps);
    expect(JSON.stringify(root)).toContain('TOAST');
  });

  it('an inline element does not clip (overflow does not apply to inline boxes)', () => {
    const { bind, deps } = harness();
    const leaf = bind(el('b', {}, [text('INLINEKEPT')]), { rect: rect(400, 0, 50, 20) });
    const span = bind(el('span', {}, [leaf]), { rect: rect(0, 0, 100, 20), style: { display: 'inline', overflowX: 'hidden', overflowY: 'hidden' } });
    const root = body([span]);
    pruneSnapshot(root, deps);
    expect(JSON.stringify(root)).toContain('INLINEKEPT');
  });

  it('judges 5,000 nested clipping containers iteratively with one style read each', () => {
    const { bind, deps } = harness();
    let reads = 0;
    const styleOf = deps.styleOf;
    deps.styleOf = (e) => {
      reads++;
      return styleOf(e);
    };
    const leaf = bind(el('div', {}, [text('DEEPCLIPPED')]), { rect: rect(900, 0, 10, 10) });
    let node = leaf;
    for (let i = 0; i < 5_000; i++) {
      node = bind(el('div', {}, [node]), { rect: rect(0, 0, 800, 720), style: { overflowX: 'hidden', overflowY: 'hidden' } });
    }
    const root = body([node]);
    const t0 = performance.now();
    pruneSnapshot(root, deps);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(leaf.childNodes).toEqual([]); // (the tree is too deep for JSON.stringify)
    // body + 5,001 judged elements, plus the bounded collapse probe of the one pruned leaf.
    expect(reads).toBeLessThanOrEqual(5_002 + 16);
  });
});

describe('pruneSnapshot — closed <select> shows only its selected option (final review finding 7)', () => {
  const body = (children: SnNode[]) => doc(el('html', {}, [el('head'), el('body', {}, children)]));
  const ZERO = rect(0, 0, 0, 0);

  it('shows the selected option as a masked value, blanks the others, and pins the select size', () => {
    const { bind, deps } = harness();
    const a = bind(el('option', { value: 'a', title: 'OPTTITLE' }, [text('Alice Smith account')]), { rect: ZERO });
    const b = bind(el('option', { value: 'b', selected: true }, [text('Standard plan')]), { rect: ZERO, attrs: { selected: '' } });
    const g = bind(el('optgroup', { label: 'GROUPLABEL' }, [
      bind(el('option', { label: 'OPTLABEL' }, [text('Bob Jones account')]), { rect: ZERO }),
    ]), { rect: ZERO });
    const select = bind(el('select', { style: 'color:red' }, [a, b, g]), { rect: rect(40, 40, 180, 32), size: { width: 180, height: 32 } });
    const root = body([select]);
    const result = pruneSnapshot(root, deps);
    const json = JSON.stringify(root);
    // The selected option is an input value: masked like every other one, but still selected.
    expect(findLeaks(json, ['Standard plan', 'Alice Smith', 'Bob Jones', 'GROUPLABEL', 'OPTLABEL', 'OPTTITLE'])).toEqual([]);
    expect(b.attributes.selected).toBe(true);
    expect(b.childNodes).toEqual([expect.objectContaining({ textContent: '***' })]);
    expect(a.childNodes).toEqual([expect.objectContaining({ textContent: '' })]);
    expect(select.childNodes).toEqual([a, b, g]); // options stay: :nth-child and the selected index hold
    expect(select.attributes.style).toBe(`${imp('box-sizing:border-box;width:180px;height:32px')};color:red`);
    expect(result.pruned).toBe(0);
  });

  it('never reads layout for options of a closed select', () => {
    const { bind, deps } = harness();
    const opt = bind(el('option', {}, [text('x')]), { rect: ZERO });
    const select = bind(el('select', {}, [opt]));
    const reads: Element[] = [];
    const { rectOf, styleOf } = deps;
    deps.rectOf = (e) => (reads.push(e), rectOf(e));
    deps.styleOf = (e) => (reads.push(e), styleOf(e));
    pruneSnapshot(body([select]), deps);
    expect(reads).not.toContain(deps.nodeFor(opt.id));
  });

  it('a listbox select (multiple) keeps its visible options, judged by layout as usual', () => {
    const { bind, deps } = harness();
    const one = bind(el('option', {}, [text('LISTONE')]), { rect: rect(40, 40, 100, 18) });
    const two = bind(el('option', {}, [text('LISTTWO')]), { rect: rect(40, 58, 100, 18) });
    const select = bind(el('select', { multiple: true }, [one, two]), { rect: rect(40, 40, 120, 80), attrs: { multiple: '' } });
    const root = body([select]);
    pruneSnapshot(root, deps);
    const json = JSON.stringify(root);
    expect(json).toContain('LISTONE');
    expect(json).toContain('LISTTWO');
    expect(select.attributes).not.toHaveProperty('style');
  });
});
