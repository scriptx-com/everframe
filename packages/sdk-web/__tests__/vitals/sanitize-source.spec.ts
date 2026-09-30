// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, describe, expect, it } from 'vitest';
import { sanitizeSource, protocolForPath, scrubUrlsInText, __useWordCharFallbackForTests } from '../../src/vitals/sanitize-source.js';

describe('sanitizeSource', () => {
  const base = 'https://app.example.com/watch/';
  it.each([
    ['https://cdn.example.com/v/main.m3u8?token=abc#frag', { src: 'https://cdn.example.com/v/main.m3u8', protocol: 'hls' }],
    ['https://cdn.example.com/v/manifest.mpd?sig=1', { src: 'https://cdn.example.com/v/manifest.mpd', protocol: 'dash' }],
    ['https://cdn.example.com/clip.mp4', { src: 'https://cdn.example.com/clip.mp4', protocol: 'progressive' }],
    ['https://cdn.example.com/clip.WEBM', { src: 'https://cdn.example.com/clip.WEBM', protocol: 'progressive' }],
    ['https://cdn.example.com/stream', { src: 'https://cdn.example.com/stream', protocol: 'unknown' }],
    ['/media/local.mp4?x=1', { src: 'https://app.example.com/media/local.mp4', protocol: 'progressive' }],
    ['blob:https://app.example.com/9f2c-…', { src: 'blob:', protocol: 'unknown' }],
    ['data:video/mp4;base64,AAAA', { src: 'data:', protocol: 'unknown' }],
    ['', { src: 'unknown', protocol: 'unknown' }],
    [null, { src: 'unknown', protocol: 'unknown' }],
    // URL parsing failures are caught and return UNKNOWN
    ['http://[', { src: 'unknown', protocol: 'unknown' }],
    // Non-http(s) schemes are rejected by the protocol guard
    ['javascript:alert(1)', { src: 'unknown', protocol: 'unknown' }],
    // A junk relative string is resolved against the base like any other relative path —
    // in practice this input cannot occur, because callers pass el.currentSrc or a player
    // library's asset URI, both of which are already absolute.
    ['not a url at all ::', { src: 'https://app.example.com/watch/not%20a%20url%20at%20all%20::', protocol: 'unknown' }],
  ])('%s → %o', (raw, expected) => {
    expect(sanitizeSource(raw as string | null, { baseURI: base })).toEqual(expected);
  });

  it('keeps the query (but never the fragment) when keepQuery is true', () => {
    expect(sanitizeSource('https://c.example.com/a.m3u8?token=abc#x', { keepQuery: true, baseURI: base }))
      .toEqual({ src: 'https://c.example.com/a.m3u8?token=abc', protocol: 'hls' });
  });

  it('uses document.baseURI when no baseURI is given', () => {
    const out = sanitizeSource('/rel/clip.mp4');
    expect(out.src.startsWith(new URL('/', document.baseURI).origin)).toBe(true);
  });
});

describe('scrubUrlsInText', () => {
  // Codex round-3 item 1 — the scrubber originally only recognised absolute
  // http(s) URLs; a same-origin licence/manifest failure carries its token
  // in a root-relative or protocol-relative URL just as often.
  it('strips the query from an absolute URL', () => {
    expect(scrubUrlsInText('request to https://license.example.com/v1/widevine?token=SECRET failed'))
      .toBe('request to https://license.example.com/v1/widevine failed');
  });
  it('strips the query from a root-relative URL', () => {
    expect(scrubUrlsInText('request to /license?token=SECRET failed'))
      .toBe('request to /license failed');
  });
  it('strips the query from a protocol-relative URL', () => {
    expect(scrubUrlsInText('manifest at //cdn.example/manifest.mpd?sig=SECRET rejected'))
      .toBe('manifest at //cdn.example/manifest.mpd rejected');
  });
  it('leaves ordinary prose with slashes intact', () => {
    const prose = 'Retry succeeded after 1/2 attempts, and/or a pass/fail fallback kicked in.';
    expect(scrubUrlsInText(prose)).toBe(prose);
  });
  it('leaves a trailing "?" that is plain punctuation, not a query, alone', () => {
    expect(scrubUrlsInText('Did you mean /help? Try again.')).toBe('Did you mean /help? Try again.');
  });

  // Codex round-4 finding 5 — `\w` is ASCII-only, so the "is this / mid-word"
  // check was blind to non-ASCII letters immediately before the slash. A
  // genuine root-relative URL must still be scrubbed regardless of what kind
  // of text surrounds it…
  it('still scrubs a genuine root-relative URL with a token embedded in non-English prose', () => {
    expect(scrubUrlsInText('請求 /license?token=SECRET 失敗'))
      .toBe('請求 /license 失敗');
  });
  // …but ordinary non-English, slash-separated prose (no whitespace/quote
  // before the "/" — a REAL word character immediately precedes it, same as
  // "and/or" in ASCII) must survive intact, not get truncated at the first
  // "?" or "#".
  it('leaves an ordinary non-ASCII slash-separated phrase intact (CJK)', () => {
    const prose = '成功/失败?请重试';
    expect(scrubUrlsInText(prose)).toBe(prose);
  });
  it('leaves an ordinary non-ASCII slash-separated phrase intact (accented Latin)', () => {
    const prose = 'café/thé?peut-être';
    expect(scrubUrlsInText(prose)).toBe(prose);
  });
  it('still leaves an ASCII slash-separated phrase with a "?" intact — clearly prose, not a URL', () => {
    const prose = 'pass/fail? try again';
    expect(scrubUrlsInText(prose)).toBe(prose);
  });
});

describe('protocolForPath', () => {
  it.each([['/a/b.m3u8', 'hls'], ['/x.mpd', 'dash'], ['/x.mp4', 'progressive'], ['/x.ogg', 'progressive'], ['/x.aac', 'progressive'], ['/x.mp3', 'progressive'], ['/x', 'unknown'], ['/x.txt', 'unknown']])(
    '%s → %s', (p, expected) => expect(protocolForPath(p)).toBe(expected));
});

// The relative-URL pass used to be a lookbehind + `\p{…}` regex literal, a
// SyntaxError at module load below Chrome 62/64 (webOS 4 = Chrome 53) that
// kept the whole SDK from loading. The scan that replaced it must behave
// exactly like that regex.
describe('scrubUrlsInText — lookbehind-free relative-URL pass', () => {
  // The original pattern, built from a string so this spec itself parses anywhere.
  const ORIGINAL = new RegExp('(?<![\\p{L}\\p{N}_])\\/\\/?[^\\s"\'<>)]+', 'gu');
  const original = (text: string): string =>
    text.replace(/https?:\/\/[^\s"'<>)]+/gi, (m) => {
      try {
        const u = new URL(m);
        return `${u.origin}${u.pathname}`;
      } catch {
        return m;
      }
    }).replace(ORIGINAL, (m) => {
      const cut = m.search(/[?#]/);
      return cut === -1 || cut === m.length - 1 ? m : m.slice(0, cut);
    });
  const CASES = [
    'request to /license?token=SECRET failed',
    'manifest at //cdn.example/manifest.mpd?sig=SECRET rejected',
    'a//x?y and b/c?d',
    '功/x?y 成功/失败?请重试',
    'café/thé?peut-être',
    '(/p?q=1) "/q#frag" \'/r?s\'',
    '𝒳/astral?letter 😀/emoji?not-letter',
    'x_/under?score 9/digit?q ½/half?q',
    '/start?of=string',
    'ends with /help? ',
    'Did you mean /help? Try again.',
    '/ lone slash, // double, /// triple?x',
    '\u3001/ideographic-comma?q \u3005/iteration?q',
    'https://license.example.com/v1/widevine?token=SECRET then /rel?t=1',
    '',
  ];

  it.each(CASES)('matches the original regex on %j', (text) => {
    expect(scrubUrlsInText(text)).toBe(original(text));
  });

  it('matches it on 2,000 generated strings', () => {
    const alphabet = ['/', '//', '?', '#', 'a', '_', '9', '功', 'é', ' ', '"', ')', '<', '😀', '\u3001', 'x=1'];
    let seed = 42;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let k = 0; k < 2000; k++) {
      let text = '';
      for (let j = rand(12); j >= 0; j--) text += alphabet[rand(alphabet.length)];
      expect(scrubUrlsInText(text), JSON.stringify(text)).toBe(original(text));
    }
  });

  describe('without Unicode property escapes (Chrome < 64 fallback)', () => {
    afterEach(() => __useWordCharFallbackForTests(false));

    it.each([
      ['請求 /license?token=SECRET 失敗', '請求 /license 失敗'],
      ['成功/失败?请重试', '成功/失败?请重试'],
      ['café/thé?peut-être', 'café/thé?peut-être'],
      ['and/or?maybe', 'and/or?maybe'],
      ['「/license?token=SECRET」', '「/license'], // (the closing bracket rides in the match, as with the regex)
    ])('%j → %j', (text, expected) => {
      __useWordCharFallbackForTests(true);
      expect(scrubUrlsInText(text)).toBe(expected);
    });
  });

  it('scans a 20k-character near-miss in under a second', () => {
    const text = 'a/'.repeat(10_000);
    const started = performance.now();
    scrubUrlsInText(text);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

