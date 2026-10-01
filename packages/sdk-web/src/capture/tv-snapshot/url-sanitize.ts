// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// ONE URL sanitizer for every URL a TV snapshot carries — DOM attributes,
// every CSS representation and the Meta href (spec §Privacy and masking).
// http(s) URLs lose credentials, query and fragment; every other scheme is
// refused here. Same-document fragments and `data:` are policed by callers,
// which know whether the target id survived and whether the page is masked.
// LAZY: imported only by the tv-snapshot chunk.

/**
 * What the WHATWG URL parser sees: leading/trailing C0 controls and spaces are
 * stripped, and ASCII tab/newline anywhere are removed. Scheme probes go
 * through this so `\x01data:` or `da\tta:` are classified as the browser would.
 */
function normalizeUrl(value: string): string {
  // Trimmed by index, not by a `[…]+$` regex: that backtracks quadratically on
  // a long interior run of spaces (S18 — page-controlled input on TV CPUs).
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start++;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end--;
  return value.slice(start, end).replace(/[\t\n\r]/g, '');
}

const FRAGMENT_RE = /^#([^\s#]+)$/;

/** `#id` with no scheme, host or path → the (decoded) id; anything else → null. */
export function fragmentId(raw: string): string | null {
  const m = FRAGMENT_RE.exec(normalizeUrl(raw));
  if (m === null) return null;
  const id = m[1]!;
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

/**
 * rrweb-snapshot absolutizes every CSS `url()` against the document, so
 * `url(#clip)` arrives as `url(https://host/dir/#clip)`. A fragment URL whose
 * non-fragment part resolves to the document itself (`baseHref`, already
 * reduced to scheme + host + path) or to its directory is a same-document
 * reference again → the (decoded) id. Anything else → null.
 */
export function documentFragmentId(raw: string, baseHref: string): string | null {
  const value = normalizeUrl(raw);
  const hash = value.indexOf('#');
  if (hash <= 0 || baseHref === '') return null;
  const id = fragmentId(value.slice(hash));
  if (id === null) return null;
  let url: URL;
  try {
    url = new URL(value.slice(0, hash), baseHref);
  } catch {
    return null;
  }
  const target = `${url.protocol}//${url.host}${url.pathname}`;
  const dir = baseHref.slice(0, baseHref.lastIndexOf('/') + 1);
  return target === baseHref || target === dir ? id : null;
}

export function isDataUrl(raw: string): boolean {
  return /^data:/i.test(normalizeUrl(raw));
}

/** http(s) → `scheme://host[:port]/path`; any other scheme, or garbage → null. */
export function sanitizeHttpUrl(raw: string, base: string): string | null {
  const value = normalizeUrl(raw);
  if (value === '') return null;
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return `${url.protocol}//${url.host}${url.pathname}`;
}

/**
 * A longer srcset is refused outright (S18): it is page-controlled and every
 * candidate goes through the URL parser and path redaction on a TV CPU.
 */
export const MAX_SRCSET_LENGTH = 16_384;

/** Where `value`'s trailing commas start — a reverse index scan, never `/,+$/` (S18). */
function trailingCommaStart(value: string): number {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2c) end--;
  return end;
}

const isSrcsetSpace = (c: string | undefined): boolean =>
  c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

/** The HTML srcset parsing algorithm: URLs may contain commas, descriptors may nest parens. */
function parseSrcset(value: string): Array<{ url: string; descriptor: string }> {
  const out: Array<{ url: string; descriptor: string }> = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && (isSrcsetSpace(value[i]) || value[i] === ',')) i++;
    if (i >= value.length) break;
    const start = i;
    while (i < value.length && !isSrcsetSpace(value[i])) i++;
    let url = value.slice(start, i);
    let descriptor = '';
    if (url.endsWith(',')) {
      url = url.slice(0, trailingCommaStart(url));
    } else {
      const from = i;
      let depth = 0;
      while (i < value.length) {
        const c = value[i];
        if (c === '(') depth++;
        else if (c === ')' && depth > 0) depth--;
        else if (c === ',' && depth === 0) break;
        i++;
      }
      descriptor = value.slice(from, i).trim();
      i++; // past the comma
    }
    if (url !== '') out.push({ url, descriptor });
  }
  return out;
}

/** One width (`300w`) or density (`1x`, `1.5x`, `.5x`) descriptor — never free text. */
const SRCSET_DESCRIPTOR_RE = /^(?:\d+w|(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?x)$/;

/**
 * Each candidate sanitized; bogus descriptors or unsafe URLs drop that
 * candidate. `mapUrl` post-processes each sanitized URL (path redaction).
 */
export function sanitizeSrcset(
  value: string,
  base: string,
  mapUrl: (url: string) => string = (url) => url,
): string | null {
  if (value.length > MAX_SRCSET_LENGTH) return null;
  const out: string[] = [];
  for (const { url, descriptor } of parseSrcset(value)) {
    if (descriptor !== '' && !SRCSET_DESCRIPTOR_RE.test(descriptor)) continue;
    const sanitized = sanitizeHttpUrl(url, base);
    if (sanitized === null) continue;
    const clean = mapUrl(sanitized);
    // A URL ending in ',' would re-parse as "URL with no descriptor".
    const end = trailingCommaStart(clean);
    const encoded = clean.slice(0, end) + '%2C'.repeat(clean.length - end);
    out.push(descriptor === '' ? encoded : `${encoded} ${descriptor}`);
  }
  return out.length > 0 ? out.join(', ') : null;
}

/**
 * Schemes a TV app's document legitimately runs from: hosted apps are http(s);
 * packaged webOS and Tizen apps are loaded from file://. Any other scheme
 * (`data:`, `javascript:`, `blob:`, `about:`) can carry content in its path.
 */
const META_HREF_SCHEMES = new Set(['http:', 'https:', 'file:']);

/**
 * Meta `href`: scheme + host + path of an allowlisted scheme, never userinfo,
 * query or fragment. '' for any other scheme or an unparseable href.
 */
export function sanitizeMetaHref(href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return '';
  }
  if (!META_HREF_SCHEMES.has(url.protocol)) return '';
  return `${url.protocol}//${url.host}${url.pathname}`;
}
