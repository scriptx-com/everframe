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
  // eslint-disable-next-line no-control-regex
  return value.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '').replace(/[\t\n\r]/g, '');
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
      url = url.replace(/,+$/, '');
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

/** Each candidate sanitized; bogus descriptors or unsafe URLs drop that candidate. */
export function sanitizeSrcset(value: string, base: string): string | null {
  const out: string[] = [];
  for (const { url, descriptor } of parseSrcset(value)) {
    if (descriptor !== '' && !SRCSET_DESCRIPTOR_RE.test(descriptor)) continue;
    const clean = sanitizeHttpUrl(url, base);
    if (clean === null) continue;
    // A URL ending in ',' would re-parse as "URL with no descriptor".
    const encoded = clean.replace(/,+$/, (commas) => '%2C'.repeat(commas.length));
    out.push(descriptor === '' ? encoded : `${encoded} ${descriptor}`);
  }
  return out.length > 0 ? out.join(', ') : null;
}

/**
 * Meta `href`: scheme + host + path of any hierarchical scheme (a packaged
 * webOS app runs from file://), never userinfo, query or fragment. An opaque
 * path (`data:…`, `about:…`, `blob:…`) IS the content, so it yields '' — as
 * does an unparseable href.
 */
export function sanitizeMetaHref(href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return '';
  }
  if (!url.pathname.startsWith('/')) return '';
  return `${url.protocol}//${url.host}${url.pathname}`;
}
