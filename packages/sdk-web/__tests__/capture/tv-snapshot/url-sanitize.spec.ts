// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import {
  documentFragmentId,
  fragmentId,
  isDataUrl,
  MAX_SRCSET_LENGTH,
  sanitizeHttpUrl,
  sanitizeMetaHref,
  sanitizeSrcset,
} from '../../../src/capture/tv-snapshot/url-sanitize.js';

const BASE = 'https://app.example.test/tv/';

describe('sanitizeHttpUrl', () => {
  it('removes credentials, query and fragment, keeping origin + path', () => {
    expect(sanitizeHttpUrl('https://alice:secret@cdn.example.test:8443/p/poster.png?access_token=T#x', BASE))
      .toBe('https://cdn.example.test:8443/p/poster.png');
  });
  it('resolves relative URLs against the base', () => {
    expect(sanitizeHttpUrl('img/a.png?t=1', BASE)).toBe('https://app.example.test/tv/img/a.png');
  });
  it.each(['javascript:alert(1)', 'blob:https://app.example.test/1', 'file:///etc/passwd', 'ws://x.test/', 'data:image/png;base64,AA==', ''])(
    'refuses %s',
    (raw) => expect(sanitizeHttpUrl(raw, BASE)).toBeNull(),
  );
});

describe('fragments and data URLs', () => {
  it('recognises same-document fragment references only', () => {
    expect(fragmentId('#play')).toBe('play');
    expect(fragmentId(' #a%20b ')).toBe('a b');
    expect(fragmentId('page.html#play')).toBeNull();
    expect(fragmentId('#')).toBeNull();
  });
  it('detects data: URLs', () => {
    expect(isDataUrl('  DATA:image/svg+xml,<svg/>')).toBe(true);
    expect(isDataUrl('https://x.test/data:')).toBe(false);
  });
});

describe('sanitizeSrcset', () => {
  it('cleans every candidate and keeps valid descriptors', () => {
    expect(sanitizeSrcset('https://a:b@cdn.example.test/1.png?t=S 1x, https://cdn.example.test/2.png?t=S 2x', BASE))
      .toBe('https://cdn.example.test/1.png 1x, https://cdn.example.test/2.png 2x');
  });
  it('drops candidates with unsafe URLs or bogus descriptors, null when none survive', () => {
    expect(sanitizeSrcset('javascript:x 1x, https://cdn.example.test/w.png 300w', BASE)).toBe('https://cdn.example.test/w.png 300w');
    expect(sanitizeSrcset('https://cdn.example.test/a.png Alice', BASE)).toBeNull();
  });
});

describe('sanitizeMetaHref', () => {
  it('keeps origin + path only', () => {
    expect(sanitizeMetaHref('https://alice:pw@app.example.test/path/x?access_token=T#code=C')).toBe('https://app.example.test/path/x');
  });
  it('keeps scheme + path for a packaged file:// app (Review Focus 3)', () => {
    expect(sanitizeMetaHref('file:///media/developer/apps/usr/palm/applications/com.x/index.html?x=1#y'))
      .toBe('file:///media/developer/apps/usr/palm/applications/com.x/index.html');
  });
  it('returns an empty string for an unparseable href', () => {
    expect(sanitizeMetaHref('not a url')).toBe('');
  });
});

describe('parser-equivalent classification (hardening)', () => {
  it('classifies URLs the way the browser URL parser does', () => {
    expect(isDataUrl('\x01data:image/png;base64,AA==')).toBe(true);
    expect(isDataUrl('da\tta:image/png;base64,AA==')).toBe(true);
    expect(sanitizeHttpUrl('java\nscript:alert(1)', BASE)).toBeNull();
    expect(fragmentId('\t#play\n')).toBe('play');
  });
  it('strips credentials from protocol-relative URLs', () => {
    expect(sanitizeHttpUrl('//bob:pw@cdn.example.test/x.png?k=1', BASE)).toBe('https://cdn.example.test/x.png');
  });
  it('refuses relative URLs when the base is not http(s) or is empty', () => {
    expect(sanitizeHttpUrl('img/a.png', 'file:///apps/x/index.html')).toBeNull();
    expect(sanitizeHttpUrl('img/a.png', '')).toBeNull();
  });
});

describe('sanitizeSrcset (HTML parsing algorithm)', () => {
  it('splits candidates separated by a bare comma', () => {
    expect(sanitizeSrcset('https://cdn.example.test/1.png?t=S 1x,https://cdn.example.test/2.png?t=S 2x', BASE))
      .toBe('https://cdn.example.test/1.png 1x, https://cdn.example.test/2.png 2x');
  });
  it('keeps commas inside a URL and drops the query after them', () => {
    expect(sanitizeSrcset('https://cdn.example.test/w_100,h_50/a.png?sig=S 1.5x, b.png .5x', BASE))
      .toBe('https://cdn.example.test/w_100,h_50/a.png 1.5x, https://app.example.test/tv/b.png .5x');
  });
  it('drops multi-token descriptors', () => {
    expect(sanitizeSrcset('https://cdn.example.test/a.png 300w 2x', BASE)).toBeNull();
  });
});

describe('sanitizeMetaHref (scheme allowlist)', () => {
  it('returns an empty string for any scheme outside http(s)/file', () => {
    expect(sanitizeMetaHref('data:text/html,<p>Alice Smith</p>')).toBe('');
    expect(sanitizeMetaHref('about:blank')).toBe('');
    expect(sanitizeMetaHref('blob:https://app.example.test/5f0c')).toBe('');
    expect(sanitizeMetaHref('data:/Alice Smith')).toBe('');
    expect(sanitizeMetaHref('javascript:/Alice')).toBe('');
    expect(sanitizeMetaHref('app://pkg/Alice/index.html')).toBe('');
  });
});

describe('documentFragmentId (rrweb-absolutized CSS fragments)', () => {
  const PAGE = 'https://app.example.test/tv/home';
  it('recognizes a fragment resolved against the document or its directory', () => {
    expect(documentFragmentId('https://app.example.test/tv/#clip', PAGE)).toBe('clip');
    expect(documentFragmentId('https://app.example.test/tv/home#clip', PAGE)).toBe('clip');
    expect(documentFragmentId(' https://app.example.test/tv/?q=1#grad%201 ', PAGE)).toBe('grad 1');
    expect(documentFragmentId('file:///apps/com.x/#clip', 'file:///apps/com.x/index.html')).toBe('clip');
  });
  it('rejects other documents, empty fragments and bare fragments', () => {
    expect(documentFragmentId('https://app.example.test/tv/sprite.svg#clip', PAGE)).toBeNull();
    expect(documentFragmentId('https://cdn.example.test/tv/#clip', PAGE)).toBeNull();
    expect(documentFragmentId('https://app.example.test/tv/#', PAGE)).toBeNull();
    expect(documentFragmentId('#clip', PAGE)).toBeNull(); // fragmentId's job
    expect(documentFragmentId('https://app.example.test/tv/#clip', '')).toBeNull();
  });
});

describe('URL normalization stays linear (S18)', () => {
  it('handles a long interior run of spaces in well under a second', () => {
    const nearMiss = `a${' '.repeat(40_000)}a`;
    const started = performance.now();
    expect(sanitizeHttpUrl(nearMiss, BASE)).not.toBeUndefined();
    expect(fragmentId(nearMiss)).toBeNull();
    expect(documentFragmentId(`${nearMiss}#x`, BASE)).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('srcset scrubbing stays linear (S18)', () => {
  it('handles 60k interior commas in a candidate URL in well under a second', () => {
    const nearMiss = `https://cdn.example/${','.repeat(60_000)}x.png 1x`;
    const started = performance.now();
    sanitizeSrcset(nearMiss, BASE);
    expect(performance.now() - started).toBeLessThan(1000);
  });
  it('stays linear just under the length cap too', () => {
    const nearMiss = `https://cdn.example/${','.repeat(MAX_SRCSET_LENGTH - 40)}x.png 1x`;
    const started = performance.now();
    expect(sanitizeSrcset(nearMiss, BASE)).toMatch(/x\.png 1x$/);
    expect(performance.now() - started).toBeLessThan(1000);
  });
  it('still percent-encodes trailing commas of a URL', () => {
    expect(sanitizeSrcset('https://cdn.example.test/a,,?q=S 1x', BASE)).toBe('https://cdn.example.test/a%2C%2C 1x');
    expect(sanitizeSrcset('https://cdn.example.test/a,,', BASE)).toBe('https://cdn.example.test/a');
  });
  it('refuses a srcset longer than the cap', () => {
    expect(sanitizeSrcset(`https://cdn.example.test/a.png${' '.repeat(MAX_SRCSET_LENGTH)} 1x`, BASE)).toBeNull();
  });
});
