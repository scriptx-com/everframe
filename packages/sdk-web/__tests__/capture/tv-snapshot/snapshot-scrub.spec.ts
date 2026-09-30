// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { beforeEach, describe, expect, it } from 'vitest';
import { collectRetainedIds, scrubSnapshotTree } from '../../../src/capture/tv-snapshot/snapshot-scrub.js';
import type { SnDocument } from '../../../src/capture/tv-snapshot/sn-types.js';
import { doc, el, find, resetIds, text } from './sn-builders.js';
import { findLeaks } from './leak-assert.js';

const BASE = 'https://app.example.test/tv/';
function scrub(root: SnDocument, masked = true): SnDocument {
  scrubSnapshotTree(root, { masked, retainedIds: collectRetainedIds(root), baseHref: BASE });
  return root;
}
const page = (...body: ReturnType<typeof el>[]) => doc(el('html', {}, [el('head'), el('body', {}, body)]));

beforeEach(() => resetIds());

describe('snapshot scrubber', () => {
  it('keeps finite nested scroll offsets and drops anything else', () => {
    const rail = el('div', { id: 'rail', rr_scrollLeft: 400, rr_scrollTop: 12 });
    const bad = el('div', { rr_scrollLeft: Number.NaN, rr_scrollTop: '5' });
    scrub(page(rail, bad));
    expect(rail.attributes).toEqual({ id: 'rail', rr_scrollLeft: 400, rr_scrollTop: 12 });
    expect(bad.attributes).toEqual({});
  });

  it('keeps enumerated ARIA state and drops labels and out-of-set values', () => {
    const nav = el('a', { 'aria-current': 'page', 'aria-label': 'Alice Smith', href: 'https://app.example.test/home' });
    const toggle = el('button', { 'aria-pressed': 'true', 'aria-expanded': 'Alice', 'aria-selected': 'false' });
    scrub(page(nav, toggle));
    expect(nav.attributes).toEqual({ 'aria-current': 'page', href: 'https://app.example.test/home' });
    expect(toggle.attributes).toEqual({ 'aria-pressed': 'true', 'aria-selected': 'false' });
  });

  it('keeps validated SVG geometry and same-document refs to retained ids', () => {
    const path = el('path', { d: 'M0 0L10 5L0 10z', title: 'Alice Smith' }, [], { isSVG: true });
    const symbol = el('symbol', { id: 'play', viewBox: '0 0 10 10' }, [path], { isSVG: true });
    const grad = el('linearGradient', { id: 'g', gradientUnits: 'userSpaceOnUse' }, [el('stop', { offset: '0', 'stop-color': '#f00' }, [], { isSVG: true })], { isSVG: true });
    const use = el('use', { href: '#play', fill: 'url(#g)', 'xlink:href': '#gone' }, [], { isSVG: true });
    const junk = el('path', { d: 'call', fill: 'Alice', transform: 'Alice(1)' }, [], { isSVG: true });
    scrub(page(el('svg', { width: '40', height: '40', viewBox: '0 0 40 40' }, [grad, symbol, use, junk], { isSVG: true })));
    expect(use.attributes).toEqual({ href: '#play', fill: 'url(#g)' });
    expect(path.attributes).toEqual({ d: 'M0 0L10 5L0 10z' });
    expect(grad.attributes).toEqual({ id: 'g', gradientUnits: 'userSpaceOnUse' });
    expect(junk.attributes).toEqual({});
  });

  it('sanitizes every URL-bearing attribute, including srcset candidates (credential-bearing src regression)', () => {
    const root = page(
      el('img', {
        src: 'https://alice:secret@cdn.example.test/p.png?token=SECRET#f',
        srcset: 'https://cdn.example.test/1.png?t=SECRET 1x, https://alice:secret@cdn.example.test/2.png 2x',
        alt: 'Alice Smith',
      }),
      el('video', { poster: 'https://cdn.example.test/v.jpg?sig=SECRET' }),
      el('a', { href: 'javascript:alert("SECRET")' }, [text('Go')]),
      el('link', { rel: 'stylesheet', href: 'https://cdn.example.test/s.css?SECRET' }),
    );
    scrub(root);
    const img = find(root, (e) => e.tagName === 'img')!;
    expect(img.attributes).toEqual({
      src: 'https://cdn.example.test/p.png',
      srcset: 'https://cdn.example.test/1.png 1x, https://cdn.example.test/2.png 2x',
    });
    expect(find(root, (e) => e.tagName === 'video')!.attributes).toEqual({ poster: 'https://cdn.example.test/v.jpg' });
    expect(find(root, (e) => e.tagName === 'a')!.attributes).toEqual({ href: '#' });
    expect(findLeaks(JSON.stringify(root), ['alice:secret', 'SECRET', 'Alice Smith'])).toEqual([]);
  });

  it('drops file: asset URLs from a packaged app page (Review Focus 3)', () => {
    const img = el('img', { src: 'file:///media/developer/apps/com.x/poster.png' });
    scrub(page(img));
    expect(img.attributes).toEqual({});
  });

  it('keeps an input value only when it is the mask placeholder', () => {
    const masked = el('input', { type: 'text', value: '***' });
    const raw = el('input', { type: 'text', value: 'ALICETYPED', placeholder: 'Search Alice' });
    scrub(page(masked, raw));
    expect(masked.attributes).toEqual({ type: 'text', value: '***' });
    expect(raw.attributes).toEqual({ type: 'text' });
  });

  it('drops free-text, data-* and handler attributes', () => {
    const div = el('div', { title: 'Alice', 'data-user': 'Alice', onerror: 'x()', rr_mediaState: 'played', class: 'tile', role: 'button' });
    scrub(page(div));
    expect(div.attributes).toEqual({ class: 'tile', role: 'button' });
  });

  it('pattern-scrubs text nodes and CSS-scrubs <style> text', () => {
    const root = doc(
      el('html', {}, [
        el('head', {}, [el('style', {}, [text('a::before{content:"Alice Smith"}b{color:red}')])]),
        el('body', {}, [el('p', {}, [text('mail alice@example.test now')])]),
      ]),
    );
    scrub(root);
    const json = JSON.stringify(root);
    expect(findLeaks(json, ['Alice Smith', 'alice@example.test'])).toEqual([]);
    expect(json).toContain('b{color:red}');
  });

  it('scrubs _cssText and style attributes on a masked page', () => {
    const style = el('style', { _cssText: ':root{--patient-name: Alice Smith}p{color:red}' });
    const inline = el('p', { style: '--x: Alice Smith; color: blue' });
    const root = doc(el('html', {}, [el('head', {}, [style]), el('body', {}, [inline])]));
    scrub(root);
    expect(style.attributes).toEqual({ _cssText: 'p{color:red}' });
    expect(inline.attributes).toEqual({ style: 'color:blue' });
  });

  it('keeps DOM data:image only on unmasked pages and never other data: types', () => {
    const pic = () => el('img', { src: 'data:image/png;base64,AAAA' });
    const frame = () => el('iframe', { src: 'data:text/html,<b>Alice</b>' });
    const openPic = pic();
    const openFrame = frame();
    scrub(page(openPic, openFrame), false);
    expect(openPic.attributes).toEqual({ src: 'data:image/png;base64,AAAA' });
    expect(openFrame.attributes).toEqual({});
    const maskedPic = pic();
    scrub(page(maskedPic), true);
    expect(maskedPic.attributes).toEqual({});
  });

  it('collects the ids retained in the tree', () => {
    const root = page(el('div', { id: 'a' }, [el('span', { id: 'b' })]), el('p'));
    expect([...collectRetainedIds(root)].sort()).toEqual(['a', 'b']);
  });

  it('honours isStyle text nodes as CSS even without a <style> parent', () => {
    const t = text('p::after{content:"Alice Smith"}i{color:red}');
    t.isStyle = true;
    scrub(page(el('div', {}, [t])));
    expect(t.textContent).not.toContain('Alice Smith');
    expect(t.textContent).toContain('i{color:red}');
  });

  it('blanks comments and CDATA', () => {
    const comment = { type: 5 as const, id: 900, textContent: 'Alice Smith' };
    const root = doc(el('html', {}, [el('body', {}, [comment as never])]));
    scrub(root);
    expect(comment.textContent).toBe('');
  });

  it('never keeps a fragment ref to an id the pattern scrub rewrote', () => {
    const target = el('div', { id: 'alice@example.test' });
    const link = el('a', { href: '#alice@example.test' });
    const use = el('use', { href: '#alice@example.test' }, [], { isSVG: true });
    const root = page(target, link, el('svg', {}, [use], { isSVG: true }));
    scrub(root);
    expect(link.attributes).toEqual({ href: '#' });
    expect(use.attributes).toEqual({});
    expect(findLeaks(JSON.stringify(root), ['alice@example.test'])).toEqual([]);
  });

  it('drops prototype-named attributes without throwing', () => {
    const names = ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'];
    const attrs: Record<string, string> = {};
    for (const n of names) Object.defineProperty(attrs, n, { value: 'Alice', enumerable: true, configurable: true, writable: true });
    const plain = el('div', { ...attrs, class: 'tile' });
    const svg = el('path', { ...attrs }, [], { isSVG: true });
    scrub(page(plain, el('svg', {}, [svg], { isSVG: true })));
    expect(Object.keys(plain.attributes)).toEqual(['class']);
    expect(Object.keys(svg.attributes)).toEqual([]);
    expect(Object.getPrototypeOf(plain.attributes)).toBe(Object.prototype);
  });

  it('keeps a relative same-origin URL, resolved and stripped', () => {
    const img = el('img', { src: 'img/p.png?u=alice' });
    scrub(page(img));
    expect(img.attributes).toEqual({ src: 'https://app.example.test/tv/img/p.png' });
  });

  it('fully redacts an over-long token run instead of pattern-matching it', () => {
    const jwtish = `${'a'.repeat(200)}.${'b'.repeat(200)}.${'c'.repeat(200)}`;
    const t = text(`token ${jwtish} end`);
    scrub(page(el('p', {}, [t])));
    expect(t.textContent).toBe('token *** end');
  });

  it('leaves prose, CJK and short tokens intact', () => {
    const t = text('寿司が好きです。 Watch now — 12 episodes');
    scrub(page(el('p', {}, [t])));
    expect(t.textContent).toBe('寿司が好きです。 Watch now — 12 episodes');
  });

  // S18: page-controlled strings through the pattern scrub stay linear.
  it.each([
    ['one long run', `${'a'.repeat(20_000)}`],
    ['near-miss email runs', `${'a'.repeat(120)}@ `.repeat(160)],
    ['near-miss JWT runs', `${'a'.repeat(60)}.${'a'.repeat(60)} `.repeat(160)],
    ['dotted run', 'a.'.repeat(10_000)],
  ])('pattern-scrubs %s (~20k chars) in well under a second', (_label, input) => {
    const t = text(input);
    const div = el('div', { class: input, id: input });
    const root = page(el('p', {}, [t]), div);
    const started = performance.now();
    scrub(root);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
