// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { sanitizeSource, protocolForPath, scrubUrlsInText } from '../../src/vitals/sanitize-source.js';

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
