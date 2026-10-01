// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_PATTERN_TEXT_LENGTH } from '../../../src/capture/tv-snapshot/page-redact.js';
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

  it('blanks <title> text, in head and inside SVG (final review finding 7)', () => {
    const title = el('title', {}, [text('Alice Smith — account')]);
    const svgTitle = el('title', {}, [text('SVGTOOLTIP')], { isSVG: true });
    const root = doc(el('html', {}, [el('head', {}, [title]), el('body', {}, [el('svg', {}, [svgTitle], { isSVG: true })])]));
    scrub(root);
    expect(findLeaks(JSON.stringify(root), ['Alice Smith', 'SVGTOOLTIP'])).toEqual([]);
    expect(title.childNodes).toHaveLength(1);
  });

  describe('URL paths are pattern-redacted (DOM and CSS)', () => {
    const EMAIL = 'alice@example.test';
    const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJlMTIzNDU2';
    const CARD = '4111111111111111';
    const SECRETS = [EMAIL, 'alice%40example.test', 'eyJzdWIiOiJhbGljZSJ9', CARD];
    const parses = (url: string): void => {
      expect(() => new URL(url)).not.toThrow();
      expect(new URL(url).href).toBe(url);
    };

    it('redacts emails, JWTs and card numbers in src, href, srcset and poster', () => {
      const img = el('img', {
        src: `/u/${EMAIL}/p.png`,
        srcset: `/reset/${JWT}/1.png 1x, https://cdn.example.test/c/${CARD}.png 2x`,
      });
      const encoded = el('img', { src: '/u/alice%40example.test/p.png' });
      const video = el('video', { poster: `https://cdn.example.test/${JWT}/v.jpg` });
      const link = el('a', { href: `/user/${EMAIL}` });
      const use = el('use', { 'xlink:href': `https://cdn.example.test/${EMAIL}.svg` }, [], { isSVG: true });
      const root = page(img, encoded, video, link, el('svg', {}, [use], { isSVG: true }));
      scrub(root);
      expect(findLeaks(JSON.stringify(root), SECRETS)).toEqual([]);
      expect(img.attributes.src).toBe('https://app.example.test/u/%5BREDACTED%3AEMAIL%5D/p.png');
      expect(encoded.attributes.src).toBe('https://app.example.test/u/%5BREDACTED%3AEMAIL%5D/p.png');
      expect(link.attributes.href).toBe('https://app.example.test/user/%5BREDACTED%3AEMAIL%5D');
      for (const url of [img.attributes.src, encoded.attributes.src, video.attributes.poster, link.attributes.href, use.attributes['xlink:href']]) {
        parses(url as string);
      }
      const candidates = String(img.attributes.srcset).split(', ');
      expect(candidates).toHaveLength(2);
      for (const c of candidates) {
        const [url, descriptor] = c.split(' ');
        parses(url!);
        expect(descriptor).toMatch(/^[12]x$/);
      }
    });

    it('leaves an ordinary path byte-for-byte unchanged', () => {
      const img = el('img', { src: 'https://cdn.example.test/posters/show-12/p%20q.png' });
      scrub(page(img));
      expect(img.attributes.src).toBe('https://cdn.example.test/posters/show-12/p%20q.png');
    });

    it('redacts url(), image-set, @import and @font-face src targets in CSS', () => {
      const sheet = el('style', {
        _cssText:
          `@import url("https://cdn.example.test/${EMAIL}/a.css");` +
          `@font-face{font-family:f;src:url(/fonts/${JWT}.woff2)}` +
          `.a{background-image:image-set(url("/i/${CARD}.png") 1x)}` +
          `.b{background:url(/u/${EMAIL}.png)}`,
      });
      const inline = el('div', { style: `background-image:url('/p/${JWT}/x.png')` });
      const root = doc(el('html', {}, [el('head', {}, [sheet]), el('body', {}, [inline])]));
      scrub(root);
      const json = JSON.stringify(root);
      expect(findLeaks(json, SECRETS)).toEqual([]);
      const urls = [...`${String(sheet.attributes._cssText)}${String(inline.attributes.style)}`.matchAll(/url\("([^"]*)"\)/g)].map((m) => m[1]!);
      expect(urls).toHaveLength(5);
      for (const url of urls) parses(url);
      expect(urls.every((u) => u.includes('REDACTED'))).toBe(true);
    });

    it('redacts a ~20k-char URL path in well under a second', () => {
      const img = el('img', { src: `/${'a'.repeat(20_000)}`, srcset: `/${'a.'.repeat(10_000)} 1x` });
      const started = performance.now();
      scrub(page(img));
      expect(performance.now() - started).toBeLessThan(1000);
      parses(img.attributes.src as string);
    });
  });

  describe('truncation never leaves a partial token', () => {
    it('backs up to the start of an email the cap cuts through', () => {
      const prefix = '!'.repeat(MAX_PATTERN_TEXT_LENGTH - 9);
      const t = text(`${prefix}alice@example.test tail`);
      scrub(page(el('p', {}, [t])));
      expect(t.textContent).toBe(prefix);
    });

    it('backs up past a card number the cap cuts between digit groups', () => {
      const prefix = '!'.repeat(MAX_PATTERN_TEXT_LENGTH - 14);
      const t = text(`${prefix}4111 1111 1111 1111 tail`);
      scrub(page(el('p', {}, [t])));
      expect(t.textContent).toBe(prefix);
    });

    it('backs up past a card number the cap cuts inside a digit group', () => {
      const prefix = '!'.repeat(MAX_PATTERN_TEXT_LENGTH - 12);
      const t = text(`${prefix}4111-1111-1111-1111 tail`);
      scrub(page(el('p', {}, [t])));
      expect(t.textContent).toBe(prefix);
    });

    it('cuts plain prose at the cap', () => {
      const t = text('!'.repeat(MAX_PATTERN_TEXT_LENGTH + 50));
      scrub(page(el('p', {}, [t])));
      expect(t.textContent).toHaveLength(MAX_PATTERN_TEXT_LENGTH);
    });
  });

  describe('doctype', () => {
    const doctype = (name: string, publicId: string, systemId: string) => ({ type: 1 as const, id: 800, name, publicId, systemId });

    it('keeps a standard DTD (it decides the document mode)', () => {
      const dt = doctype('html', '-//W3C//DTD HTML 4.01 Transitional//EN', 'http://www.w3.org/TR/html4/loose.dtd');
      scrub(doc(dt, el('html')));
      expect(dt).toEqual(doctype('html', '-//W3C//DTD HTML 4.01 Transitional//EN', 'http://www.w3.org/TR/html4/loose.dtd'));
      const html5 = doctype('html', '', '');
      scrub(doc(html5, el('html')));
      expect(html5).toEqual(doctype('html', '', ''));
    });

    it('clears page-chosen identifiers and names', () => {
      const dt = doctype('Alice', 'Alice Smith', `https://evil.test/${'alice@example.test'}.dtd?u=1`);
      const root = doc(dt, el('html'));
      scrub(root);
      expect(dt).toEqual(doctype('', '', ''));
      expect(findLeaks(JSON.stringify(root), ['Alice', 'alice@example.test'])).toEqual([]);
    });
  });
});
