// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// patches/rrweb-snapshot@2.1.6.patch replaces rrweb-snapshot's regex CSS URL
// pass with a linear scanner (S18). It must find exactly what the regex found.
import { describe, expect, it } from 'vitest';
import { absolutifyURLs, markCssSplits } from 'rrweb-snapshot';

const HREF = 'https://app.example.test/tv/dir/page.html';

/** The patched pass, observed through its output for a base that keeps paths recognizable. */
function absolutize(css: string): string {
  return absolutifyURLs(css, HREF);
}

/** The original pass, end to end (same callback body as rrweb-snapshot 2.1.6). */
function original(css: string): string {
  return css.replace(/url\((?:(')([^']*)'|(")(.*?)"|([^)]*))\)/gm, (origin, q1, p1, q2, p2, p3) => {
    const filePath: string = p1 || p2 || p3;
    const quote: string = q1 || q2 || '';
    if (!filePath) return origin;
    if (/^(?:[a-z+]+:)?\/\//i.test(filePath) || /^www\..*/i.test(filePath)) return `url(${quote}${filePath}${quote})`;
    if (/^(data:)([^,]*),(.*)/i.test(filePath)) return `url(${quote}${filePath}${quote})`;
    if (filePath[0] === '/') return `url(${quote}https://app.example.test${filePath}${quote})`;
    const noHash = filePath.split('#')[0]!;
    const hash = filePath.substring(noHash.length);
    const stack = HREF.split('#')[0]!.split('/');
    stack.pop();
    for (const part of noHash.split('/')) {
      if (part === '.') continue;
      if (part === '..') stack.pop();
      else stack.push(part);
    }
    return `url(${quote}${stack.join('/')}${hash}${quote})`;
  });
}

describe('patched rrweb-snapshot absolutifyURLs', () => {
  it('matches the original regex on hand-picked inputs', () => {
    const cases = [
      'a{background:url(img/a.png)}',
      "url('x.png') url(\"y.png\") url(z.png)",
      "url('a)b') url('unclosed",
      'url("a\nb") url("c")',
      'url("a"b")',
      'url() url(\'\') url("")',
      'url(/abs.png) url(//cdn/x) url(data:image/png;base64,AA) url(www.x/y) url(../up.png#frag)',
      'URL(upper.png) url(url(nested.png))',
      "url('x'y') tail)",
      'url("a b")',
    ];
    for (const css of cases) expect(absolutize(css), css).toBe(original(css));
  });

  it('matches the original regex on random CSS-ish strings', () => {
    const alphabet = ['url(', 'url(', ')', "'", '"', '\n', 'a', '/', '.', '#', ' ', '..', 'data:', '//'];
    let seed = 7;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 3000; i++) {
      let css = '';
      const len = 1 + rand(14);
      for (let k = 0; k < len; k++) css += alphabet[rand(alphabet.length)];
      expect(absolutize(css), JSON.stringify(css)).toBe(original(css));
    }
  });

  it('stays linear on unclosed url( runs (S18)', () => {
    for (const css of ['background:' + 'url('.repeat(64_000), 'url("'.repeat(40_000) + '\n', "url('".repeat(40_000), 'url(a)'.repeat(40_000)]) {
      const started = performance.now();
      absolutize(css);
      expect(performance.now() - started).toBeLessThan(1000);
    }
  });

  it('marks no split points (the one-off snapshot needs none; the search is quadratic)', () => {
    const style = document.createElement('style');
    style.appendChild(document.createTextNode('a{}'));
    style.appendChild(document.createTextNode('{'.repeat(20_000)));
    const started = performance.now();
    expect(markCssSplits('a{}b{}', style)).toBe('a{}b{}');
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
