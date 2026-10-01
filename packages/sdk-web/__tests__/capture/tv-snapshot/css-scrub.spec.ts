// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scrubCssText, scrubInlineStyle, type CssScrubContext } from '../../../src/capture/tv-snapshot/css-scrub.js';
import { findLeaks } from './leak-assert.js';

const masked: CssScrubContext = { masked: true, retainedIds: new Set(['g', 'c']), baseHref: 'https://app.example.test/tv/' };
const open: CssScrubContext = { ...masked, masked: false };
const PHRASE = ['Alice Smith', 'SECRET'];

describe('masked page — spec regression cases (byte-level absence)', () => {
  it('drops an unquoted custom property carrying text', () => {
    const out = scrubCssText(':root{--patient-name: Alice Smith;--x:"Alice Smith"}a{color:red}', masked);
    expect(findLeaks(out, PHRASE)).toEqual([]);
    expect(out).toContain('a{color:red}');
  });

  it("drops a blocked element's stylesheet-embedded data:image/svg+xml background (percent and base64)", () => {
    const pct = "#vault{background:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Ctext%3EAlice Smith%3C/text%3E%3C/svg%3E\");width:10px}";
    const b64 = `#vault{background-image:url(data:image/svg+xml;base64,${Buffer.from('<svg><text>Alice Smith</text></svg>').toString('base64')});height:4px}`;
    const out = scrubCssText(pct + b64, masked);
    expect(findLeaks(out, PHRASE)).toEqual([]);
    expect(out).not.toMatch(/data:/i);
    expect(out).toContain('#vault{width:10px}');
    expect(out).toContain('#vault{height:4px}');
  });

  it('drops ::before { content: "…" }', () => {
    const out = scrubCssText('#v::before{content:"Alice Smith";color:red}', masked);
    expect(findLeaks(out, PHRASE)).toEqual([]);
    expect(out).toBe('#v::before{color:red}');
  });

  it('drops content: var(--phrase) sources', () => {
    const out = scrubCssText(':root{--phrase:"Alice Smith"}#v::before{content:var(--phrase)}', masked);
    expect(findLeaks(out, PHRASE)).toEqual([]);
  });

  it('drops an inherited quotes pair used by content: open-quote', () => {
    const out = scrubCssText('#q{quotes:"Alice Smith" "Alice Smith"}#q::before{content:open-quote}', masked);
    expect(findLeaks(out, PHRASE)).toEqual([]);
    expect(out).not.toContain('open-quote'); // S26(a): only icon/symbol strings, counters, none/normal
  });

  it('drops @counter-style entirely, including negative and additive-symbols', () => {
    const out = scrubCssText('@counter-style leak{system:cyclic;symbols:"A";negative:"Alice Smith";additive-symbols:1 "Alice Smith"}li{list-style:leak}', masked);
    expect(findLeaks(out, PHRASE)).toEqual([]);
    expect(out).not.toContain('@counter-style');
    expect(out).toContain('li{list-style:leak}');
  });

  it('strips a token from quoted image-set and -webkit-image-set', () => {
    const out = scrubCssText(
      '.p{background-image:image-set("https://cdn.example.test/a.png?access_token=SECRET" 1x, url(https://cdn.example.test/b.png?t=SECRET) 2x)}' +
        '.q{background-image:-webkit-image-set(url("https://cdn.example.test/c.png#SECRET") 1x)}',
      masked,
    );
    expect(findLeaks(out, PHRASE)).toEqual([]);
    expect(out).toContain('image-set(url("https://cdn.example.test/a.png") 1x, url("https://cdn.example.test/b.png") 2x)');
    expect(out).toContain('-webkit-image-set(url("https://cdn.example.test/c.png") 1x)');
  });

  it('sanitizes @import and @font-face src, dropping format() hints and keeping local() names', () => {
    const out = scrubCssText(
      '@import url("https://cdn.example.test/x.css?token=SECRET") screen;' +
        '@font-face{font-family:"Fixture Sans";src:url("https://f.example.test/f.woff2?sig=SECRET") format("woff2"),local("LG Smart UI")}',
      masked,
    );
    expect(findLeaks(out, PHRASE)).toEqual([]);
    expect(out).toContain('@import url("https://cdn.example.test/x.css") screen;');
    expect(out).toContain('@font-face{font-family:"Fixture Sans";src:url("https://f.example.test/f.woff2"),local("LG Smart UI")}');
  });

  it('removes credentials from url()', () => {
    expect(scrubCssText('a{background:url(https://alice:secret@cdn.example.test/i.png)}', masked))
      .toBe('a{background:url("https://cdn.example.test/i.png")}');
  });

  it('keeps fragment refs to retained ids and drops the rest', () => {
    const out = scrubCssText('.i{clip-path:url(#c);mask:url(#missing);fill:url(#g)}', masked);
    expect(out).toBe('.i{clip-path:url("#c");fill:url("#g")}');
  });

  it('keeps enumerated ARIA attribute selectors and drops every other quoted selector', () => {
    const out = scrubCssText(
      '[aria-current="page"]{background:green}[aria-pressed="true"]{color:red}[data-name="Alice Smith"]{color:blue}[aria-current="Alice Smith"]{color:blue}',
      masked,
    );
    expect(out).toBe('[aria-current="page"]{background:green}[aria-pressed="true"]{color:red}');
  });

  it('keeps identifier grid-template-areas, drops non-identifier forms', () => {
    const out = scrubCssText('#g{grid-template-areas:"head head" "side main";grid-template:"a b" 10px / 1fr 1fr}#h{grid-template-areas:"Alice Smith!";color:red}', masked);
    expect(out).toContain('grid-template-areas:"head head" "side main"');
    expect(out).toContain('grid-template:"a b" 10px / 1fr 1fr');
    expect(out).toContain('#h{color:red}');
  });

  it('keeps font-family names', () => {
    expect(scrubCssText('body{font-family:"LG Smart UI",sans-serif}', masked)).toBe('body{font-family:"LG Smart UI",sans-serif}');
  });

  it('scrubs nested @media blocks and drops @supports preludes with strings', () => {
    const out = scrubCssText('@media (min-width:1px){a::before{content:"Alice Smith"}b{color:red}}@supports (content:"Alice Smith"){i{color:red}}', masked);
    expect(findLeaks(out, PHRASE)).toEqual([]);
    expect(out).toBe('@media (min-width:1px){b{color:red}}');
  });

  it('keeps !important and survives an unterminated string', () => {
    expect(scrubCssText('a{color:red !important}', masked)).toBe('a{color:red !important}');
    expect(() => scrubCssText('a{content:"Alice Smith', masked)).not.toThrow();
    expect(findLeaks(scrubCssText('a{content:"Alice Smith', masked), PHRASE)).toEqual([]);
  });

  it('scrubs an inline style attribute', () => {
    const out = scrubInlineStyle(`--n: Alice Smith; background: url("data:image/png;base64,${Buffer.from('Alice Smith').toString('base64')}"); color: red`, masked);
    expect(out).toBe('color:red');
    expect(findLeaks(out, PHRASE)).toEqual([]);
  });
});

describe('unmasked page (Review Focus 2)', () => {
  it('keeps content strings, custom properties and data: resources, but still sanitizes URLs', () => {
    const out = scrubCssText(
      '.icon::before{content:"\\e900"}:root{--Brand:"Ever"}.b{background:url("data:image/png;base64,AAAA")}.c{background:url(https://x.example.test/a.png?t=SECRET)}',
      open,
    );
    expect(out).toContain('.icon::before{content:"\\e900"}');
    expect(out).toContain(':root{--Brand:"Ever"}');
    expect(out).toContain('url("data:image/png;base64,AAAA")');
    expect(out).toContain('url("https://x.example.test/a.png")');
    expect(out).not.toContain('SECRET');
  });
});

describe('tokenizer agreement — text the browser would see that a naive scan misses', () => {
  const b64 = Buffer.from('<svg><text>Alice Smith</text></svg>').toString('base64');

  it('recognises escape-spelled url() and image-set() function names', () => {
    for (const ctx of [masked, open]) {
      const out = scrubCssText(`a{background:u\\72l(https://cdn.example.test/i.png?t=SECRET);width:1px}`, ctx);
      expect(findLeaks(out, PHRASE)).toEqual([]);
      expect(out).toContain('url("https://cdn.example.test/i.png")');
      const set = scrubCssText('b{background:image-s\\65t(url(https://cdn.example.test/j.png?t=SECRET) 1x)}', ctx);
      expect(findLeaks(set, PHRASE)).toEqual([]);
    }
    const data = scrubCssText(`a{background:\\75rl(data:image/svg+xml;base64,${b64});width:1px}`, masked);
    expect(findLeaks(data, PHRASE)).toEqual([]);
    expect(data).not.toMatch(/data:/i);
    expect(data).toBe('a{width:1px}');
  });

  it('sanitizes url() in @supports preludes and drops @document rules', () => {
    for (const ctx of [masked, open]) {
      const out = scrubCssText(
        '@supports (background:url(https://x.example.test/a.png?t=SECRET)){a{color:red}}' +
          '@-moz-document url-prefix(https://x.example.test/?t=SECRET){b{color:red}}@document url(https://x.example.test/SECRET){c{color:red}}',
        ctx,
      );
      expect(findLeaks(out, PHRASE)).toEqual([]);
      expect(out).not.toContain('document');
    }
    expect(scrubCssText('@supports (display:grid){a{color:red}}', masked)).toBe('@supports (display:grid){a{color:red}}');
  });

  it('treats unquoted attribute-selector values like strings on a masked page', () => {
    const out = scrubCssText(
      '[data-name=Alice]{color:blue}[aria-pressed=true]{color:red}[disabled]{opacity:.5}[aria-current=page i]{color:green}.a:is([title=SECRET]){color:red}',
      masked,
    );
    expect(findLeaks(out, PHRASE.concat('Alice'))).toEqual([]);
    expect(out).toBe('[aria-pressed=true]{color:red}[disabled]{opacity:.5}[aria-current=page i]{color:green}');
    expect(scrubCssText('[data-name=Alice]{color:blue}', open)).toBe('[data-name=Alice]{color:blue}');
  });

  it('keeps escaped class selectors (utility CSS) and escaped font names', () => {
    expect(scrubCssText('.md\\:flex{display:flex}.w-1\\/2{width:50%}', masked)).toBe('.md\\:flex{display:flex}.w-1\\/2{width:50%}');
    expect(scrubCssText('p{font-family:\\5FAE\\8F6F\\96C5\\9ED1,sans-serif}', masked)).toBe('p{font-family:\\5FAE\\8F6F\\96C5\\9ED1,sans-serif}');
  });

  it('drops attr() text sources on a masked page', () => {
    expect(scrubCssText('a::after{content:attr(data-name);color:red}', masked)).toBe('a::after{color:red}');
    expect(scrubCssText('a::after{content:attr(data-name)}', open)).toBe('a::after{content:attr(data-name)}');
  });

  it('drops unsafe schemes and keeps a relative URL absolute', () => {
    expect(scrubCssText('a{background:url(javascript:alert(1))}b{background:url(img/x.png?t=SECRET)}', masked)).toBe(
      'b{background:url("https://app.example.test/tv/img/x.png")}',
    );
  });

  it("keeps rrweb's rr_split markers even when the rule after one is dropped", () => {
    expect(scrubCssText('a{color:red}/* rr_split */#v::before{content:"Alice Smith"}/* other */b{color:blue}', masked)).toBe(
      'a{color:red}/* rr_split */b{color:blue}',
    );
  });

  it('survives pathological nesting without throwing', () => {
    const deep = `${'@media all{'.repeat(5_000)}a{color:red}${'}'.repeat(5_000)}`;
    expect(() => scrubCssText(deep, masked)).not.toThrow();
  });
});

describe('linear on slow TV CPUs (~20k-char near-miss inputs, S18)', () => {
  const N = 20_000;
  const cases: Array<[string, () => unknown]> = [
    ['unterminated string of escapes', () => scrubCssText(`a{content:"${'\\'.repeat(N)}`, masked)],
    ['unclosed comments', () => scrubCssText('/*'.repeat(N / 2), masked)],
    ['nested functions', () => scrubCssText(`a{width:${'calc('.repeat(N / 5)}1px}`, masked)],
    ['unclosed url()', () => scrubCssText(`a{background:${'url('.repeat(N / 4)}}`, open)],
    ['unclosed image-set candidates', () => scrubCssText(`a{background:image-set(${'url(x) type('.repeat(N / 12)})}`, open)],
    ['near-miss resolution descriptor', () => scrubCssText(`a{background:image-set(url(x) ${'1'.repeat(N)}y)}`, open)],
    ['near-miss ARIA selectors', () => scrubCssText(`${'[aria-current="page"'.repeat(N / 20)}{color:red}`, masked)],
    ['open attribute brackets', () => scrubCssText(`${'[a'.repeat(N / 2)}{color:red}`, masked)],
    ['near-miss grid areas', () => scrubCssText(`a{grid-template-areas:"${'a '.repeat(N / 2)}!"}`, masked)],
    ['near-miss !important', () => scrubCssText(`a{color:red ${'!  '.repeat(N / 3)}importan}`, masked)],
    ['trailing whitespace runs before format()', () => scrubCssText(`@font-face{src:url(x)${' a'.repeat(N / 2)} format(x)}`, masked)],
    ['many declarations', () => scrubInlineStyle('color:red;'.repeat(N / 10), masked)],
    ['long escape-spelled ident', () => scrubCssText(`a{b:${'\\41'.repeat(N / 3)}(}`, masked)],
    ['deep nesting', () => scrubCssText(`${'@media all{'.repeat(N / 11)}`, masked)],
  ];
  it.each(cases)('%s', (_name, run) => {
    const started = performance.now();
    run();
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('fix round 1 — browser preprocessing, prototype keys, invalid declarations, escaping', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ends strings at CR, CRLF and FF exactly as the browser does (CSS Syntax §3.3)', () => {
    for (const nl of ['\r', '\r\n', '\f']) {
      const sheet = scrubCssText(`#v::before{font-family:"x${nl};content:'Alice Smith';x:"}b{color:red}`, masked);
      expect(findLeaks(sheet, PHRASE)).toEqual([]);
      const inline = scrubInlineStyle(`font-family:"x${nl};--patient-name:Alice Smith;y:"`, masked);
      expect(findLeaks(inline, PHRASE)).toEqual([]);
      expect(inline).not.toContain('--patient-name');
    }
  });

  it('maps NUL to U+FFFD before scanning', () => {
    expect(scrubCssText('a{color:red}\u0000b{color:blue}', masked)).not.toContain('\u0000');
  });

  it('drops an unclosed string in every mode — re-emitted it would swallow the output after it', () => {
    for (const ctx of [masked, open]) {
      const out = scrubCssText('a{font-family:"x\n;content:\'Alice Smith\'}b{font-family:"y;content:\'SECRET\';z"}', ctx);
      expect(out).not.toMatch(/font-family:"x/);
      expect(scrubCssText('a[title="x\n]{color:red}b{color:blue}', ctx)).toBe('b{color:blue}');
    }
    expect(scrubCssText('@font-face{font-family:F;src:local("x\n)}', masked)).not.toContain('local');
  });

  it('drops a dangling backslash that would escape the scrubber\'s own `}`', () => {
    expect(scrubCssText('a{color:red\\', open)).toBe('');
    expect(scrubInlineStyle('color:red\\', open)).toBe('');
  });

  it('never reaches Object.prototype through an attribute-selector name', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
      const sheet = `[${name}="x"]{color:red}[${name}=x]{color:red}b{color:blue}`;
      expect(() => scrubCssText(sheet, masked)).not.toThrow();
      expect(scrubCssText(sheet, masked)).toBe('b{color:blue}');
    }
  });

  it('masked, no CSS.supports (name allowlist fallback): drops unknown properties, keeps known and prefixed ones', () => {
    vi.stubGlobal('CSS', {});
    expect(scrubInlineStyle('patient: Alice Smith; color: red; -webkit-box-flex: 1; -webkit-patient: Alice Smith', masked)).toBe(
      'color:red;-webkit-box-flex:1',
    );
    expect(scrubCssText('a{patient:Alice Smith;width:1px}', masked)).toBe('a{width:1px}');
    vi.stubGlobal('CSS', undefined);
    expect(scrubInlineStyle('patient: Alice Smith; color: red', masked)).toBe('color:red');
  });

  it('masked, with CSS.supports: keeps only what the engine accepts, asked without !important', () => {
    const calls: Array<[string, string]> = [];
    const valid = new Map([['color', /^(?:red|blue)$/], ['width', /^\d+px$/]]);
    vi.stubGlobal('CSS', {
      supports: (p: string, v: string) => {
        calls.push([p, v]);
        return valid.get(p)?.test(v) ?? false;
      },
    });
    expect(scrubInlineStyle('patient: Alice Smith; color: Alice Smith; color: red !important; width: 2px', masked)).toBe(
      'color:red !important;width:2px',
    );
    expect(calls).toContainEqual(['color', 'red']);
    // @font-face descriptors are not properties; they use their own allowlist.
    expect(scrubCssText('@font-face{font-family:"F";src:url(https://f.example.test/f.woff2);patient:Alice Smith}', masked)).toBe(
      '@font-face{font-family:"F";src:url("https://f.example.test/f.woff2")}',
    );
  });

  it('falls back to the allowlist when CSS.supports throws', () => {
    vi.stubGlobal('CSS', {
      supports: () => {
        throw new Error('boom');
      },
    });
    expect(scrubInlineStyle('patient: Alice Smith; color: red', masked)).toBe('color:red');
  });

  it('unmasked pages keep unknown declarations (no masking there)', () => {
    expect(scrubInlineStyle('patient: Alice; color: red', open)).toBe('patient:Alice;color:red');
  });

  it('escapes every control character in re-emitted URL strings', () => {
    const out = scrubCssText('a{background:url("data:text/plain,a\\1 b\\7f c\\9 d")}', open);
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(out).toBe('a{background:url("data:text/plain,a\\1 b\\7f c\\9 d")}');
  });

  it.each([
    ['CR runs', () => scrubCssText(`a{font-family:"${'\r'.repeat(20_000)}`, masked)],
    ['FF-separated strings', () => scrubCssText(`a{font-family:${'"\f'.repeat(10_000)}}`, masked)],
    ['many unknown declarations', () => scrubInlineStyle('patient:x;'.repeat(2_000), masked)],
    ['dangling escapes', () => scrubCssText(`${'a\\\n'.repeat(6_000)}{color:red}`, masked)],
  ])('stays linear: %s', (_name, run) => {
    const started = performance.now();
    run();
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('masked @font-face descriptor values (final review finding 8)', () => {
  const face = (decls: string): string => scrubCssText(`@font-face{font-family:"F";${decls}}`, masked);
  const kept = (decl: string): void => expect(face(decl), decl).toBe(`@font-face{font-family:"F";${decl}}`);
  const dropped = (decl: string): void => expect(face(decl), decl).toBe('@font-face{font-family:"F"}');

  it.each([
    'unicode-range:U+0000-00FF, U+0131, U+4??',
    'font-display:swap',
    'font-weight:400',
    'font-weight:100 900',
    'font-weight:bold',
    'font-style:italic',
    'font-style:oblique 10deg 20deg',
    'font-stretch:condensed',
    'font-stretch:75% 125%',
    'ascent-override:90%',
    'descent-override:normal',
    'line-gap-override:0%',
    'size-adjust:105.5%',
    'font-named-instance:auto',
  ])('keeps a well-formed %s', (decl) => kept(decl));

  it.each([
    'unicode-range:Alice Smith',
    'unicode-range:U+0000-00FF, Alice',
    'font-display:Alice',
    'font-weight:Alice Smith',
    'font-weight:400 500 600',
    'font-style:oblique Alice',
    'font-style:italic 10deg',
    'font-stretch:Alice',
    'ascent-override:Alice',
    'size-adjust:normal',
    'font-named-instance:"Alice Smith"',
    'font-feature-settings:"Alice Smith"',
    'font-variation-settings:"Alice Smith" 1',
  ])('drops a malformed %s', (decl) => dropped(decl));

  it('keeps an engine-valid font-feature-settings when CSS.supports agrees, drops it without CSS.supports', () => {
    // (Quoted feature tags are strings, which a masked page drops anyway.)
    vi.stubGlobal('CSS', { supports: (p: string, v: string) => p === 'font-feature-settings' && v === 'normal' });
    kept('font-feature-settings:normal');
    dropped('font-variation-settings:normal');
    vi.stubGlobal('CSS', undefined);
    dropped('font-feature-settings:normal');
    vi.unstubAllGlobals();
  });

  it('a 20k-character near-miss unicode-range is rejected in under a second', () => {
    const started = performance.now();
    dropped(`unicode-range:${'U+0000-00FF,'.repeat(1_700)}X`);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('leaves @font-face descriptors alone on an unmasked page', () => {
    expect(scrubCssText('@font-face{font-family:"F";font-display:whatever}', open)).toBe('@font-face{font-family:"F";font-display:whatever}');
  });
});

describe('image() on any page (final review finding 9)', () => {
  it.each([
    ['unmasked', open],
    ['masked', masked],
  ] as const)('drops a declaration using image("…?t=…") on a %s page', (_label, ctx) => {
    const out = scrubCssText('a{background-image:image("https://cdn.example.test/p.png?t=SECRET");color:red}', ctx);
    expect(findLeaks(out, PHRASE)).toEqual([]);
    expect(out).toBe('a{color:red}');
  });

  it('drops image() in an inline style too, keeping the rest', () => {
    const out = scrubInlineStyle('background:IMAGE(\'https://cdn.example.test/p.png?t=SECRET\'), red;width:4px', open);
    expect(findLeaks(out, PHRASE)).toEqual([]);
    expect(out).toBe('width:4px');
  });

  it('still keeps url() and image-set() on an unmasked page', () => {
    const out = scrubCssText('a{background:url(https://cdn.example.test/p.png?t=SECRET)}', open);
    expect(out).toBe('a{background:url("https://cdn.example.test/p.png")}');
  });
});

describe('masked page — custom property VALUE allowlist (codex r4 F4)', () => {
  const kept = (value: string): boolean => scrubCssText(`:root{--v:${value}}`, masked).includes('--v:');
  it.each([
    '#101018', '#fc0', ' #ffcc00 ', 'rgb(255, 204, 0)', 'rgba(0 0 0 / 50%)', 'hsl(210deg 50% 40%)', 'hsla(.5turn,10%,20%,.3)',
    'red', 'Transparent', 'currentColor', '0', '-1.5', '6px', '1.25rem', '50%', '1000ms', '.5s', '9999px',
  ])('keeps %s', (value) => {
    expect(kept(value)).toBe(true);
  });
  it.each([
    'var(--surface)', 'var( --a , #000 )', 'var(--a, var(--b, 4px))', 'calc(100% - 2 * var(--gap))', 'calc((1px + 2px) / 3)',
    '0 2px 4px #000', '1px, 2px / 3px', 'rgb(0 0 0) 2px', '0 2px 4px rgba(0,0,0,.5)', '1.5',
  ])('keeps the structured value %s', (value) => {
    expect(kept(value)).toBe(true);
  });
  it.each([
    'Alice Smith', 'Alice', '"Alice Smith"', "'x'", 'url(https://cdn.example.test/a.png)', 'url(#g)', '\\41 lice', 'solid',
    '6px solid', 'var(--a, Alice)', 'calc(1px + Alice)', 'rgb(Alice, 0, 0)', 'attr(title)', '1Alice', '#xyz', '#12345',
    'var(Alice)', 'var(--a) Alice', 'inherit', 'u+0041', '-\\41', `${'1px '.repeat(80)}`,
    // S26(b): nothing that can spell digits or words
    '4111 1111 1111 1111', 'Tan Brown', 'red blue', '0 0 4px #000', '12345px', '1.23456', '1e3', '1e3ms',
    `${'1px '.repeat(13)}`, 'var(--a, tan) red', 'calc(10000px + 1px)',
  ])('drops %s', (value) => {
    expect(kept(value)).toBe(false);
  });
  it('also allowlists custom properties in inline styles, and keeps dropping content strings', () => {
    expect(scrubInlineStyle('--focus:#ffcc00;--name:Alice Smith;outline:6px solid var(--focus)', masked)).toBe(
      '--focus:#ffcc00;outline:6px solid var(--focus)',
    );
    expect(findLeaks(scrubCssText('a::before{content:"Alice Smith"}:root{--c:#000}', masked), PHRASE)).toEqual([]);
  });
  it('stays linear on long near-miss values (S18)', () => {
    const started = performance.now();
    kept('calc('.repeat(20_000));
    kept(`var(--a, ${'var(--b, '.repeat(5_000)}`);
    kept('1'.repeat(60_000) + 'x');
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('content: allowlist on TV snapshots (S26a)', () => {
  const kept = (value: string): boolean => scrubCssText(`a::before{content:${value}}`, masked).includes('content:');
  it.each(['""', 'none', 'normal', '"\\e900"', '"\\f101\\f102"', '"•"', '"→"', '"·"', '"\\a"', '"/"', 'counter(item)', 'counters(item, ".")', 'counter(item) "."'])(
    'keeps %s',
    (value) => expect(kept(value)).toBe(true),
  );
  it.each(['"Alice"', '"A"', '"7"', '"é"', '"ab"', '"••"', 'attr(title)', 'open-quote', 'url(https://cdn.example.test/a.png)', '"\\e900" "x"', 'counters(item, "Alice")', 'counter(item) attr(x)'])(
    'drops %s',
    (value) => expect(kept(value)).toBe(false),
  );
});
