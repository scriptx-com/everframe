// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Source-URL hygiene for `source_change` (spec 2026-09-02 §2). Signed CDN and
// license URLs carry tokens in the query, so the default keeps origin + path
// only; `vitals.captureSourceQuery: true` opts back in. Fragments never
// leave the browser (they are not sent to servers anyway).
export type SourceProtocol = 'hls' | 'dash' | 'progressive' | 'unknown';

export interface SanitizedSource {
  src: string;
  protocol: SourceProtocol;
}

const UNKNOWN: SanitizedSource = { src: 'unknown', protocol: 'unknown' };
const PROGRESSIVE_EXT = new Set(['mp4', 'm4v', 'webm', 'ogg', 'ogv', 'mov', 'mp3', 'aac', 'm4a', 'wav', 'flac']);

export function protocolForPath(pathname: string): SourceProtocol {
  const dot = pathname.lastIndexOf('.');
  if (dot < 0) return 'unknown';
  const ext = pathname.slice(dot + 1).toLowerCase();
  if (ext === 'm3u8') return 'hls';
  if (ext === 'mpd') return 'dash';
  if (PROGRESSIVE_EXT.has(ext)) return 'progressive';
  return 'unknown';
}

/** Origin + path only — the reduction both `sanitizeSource` (a whole-string URL) and `scrubUrlsInText` (a URL-shaped SUBSTRING found inside prose) apply, so there is exactly one place that decides what survives a URL. */
function originAndPath(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

export function sanitizeSource(
  raw: string | null | undefined,
  opts: { keepQuery?: boolean; baseURI?: string } = {},
): SanitizedSource {
  if (!raw) return UNKNOWN;
  if (raw.startsWith('blob:')) return { src: 'blob:', protocol: 'unknown' };
  if (raw.startsWith('data:')) return { src: 'data:', protocol: 'unknown' };
  let url: URL;
  try {
    url = new URL(raw, opts.baseURI ?? (typeof document !== 'undefined' ? document.baseURI : undefined));
  } catch {
    return UNKNOWN;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return UNKNOWN;
  const src = opts.keepQuery === true ? `${url.origin}${url.pathname}${url.search}` : originAndPath(url);
  return { src, protocol: protocolForPath(url.pathname) };
}

// Matches an absolute http(s) URL embedded inside a larger string — closed
// off at whitespace/quotes/angle-brackets/closing-paren, the characters that
// realistically terminate a URL inside free-form prose (an error message),
// vs. inside a query string or path segment (which none of these appear in
// unencoded).
const EMBEDDED_URL_RE = /https?:\/\/[^\s"'<>)]+/gi;

// Codex round-3 item 1 — the absolute-URL regex above misses root-relative
// ("/license?token=secret") and protocol-relative ("//cdn.example/x?sig=y")
// URL-shaped substrings, and a same-origin licence/manifest endpoint is
// exactly the ordinary case, not a corner one. This matches a "/" that could
// plausibly START a path — preceded by whitespace, a quote/bracket, or the
// beginning of the string, per the negative lookbehind — and is NOT part of
// an ordinary word: "and/or", "1/2", "pass/fail", a filesystem path typed
// mid-sentence ("path/to/file") all have a WORD character immediately before
// the "/" and are excluded. `\/\/?` matches either one slash (root-relative)
// or two (protocol-relative); both are handled by the same replacer since
// the only thing being removed is the query/fragment suffix, and there is no
// origin to reconstruct for a relative URL the way `originAndPath` does for
// an absolute one.
//
// Codex round-4 finding 5 — `\w` is ASCII-only in JavaScript (`[A-Za-z0-9_]`),
// so this "is it mid-word" check was blind to every non-ASCII letter: a
// preceding "功" or "é" doesn't match `\w`, so the lookbehind let the match
// through as if the string started fresh at that "/", even though a real
// word character sits right before it. An ordinary non-English phrase like
// "成功/失败?请重试" or "café/thé?peut-être" got treated as a path and
// truncated at the first "?", destroying error detail for every non-English
// customer. `\p{L}`/`\p{N}` (Unicode property escapes, hence the `u` flag)
// make the SAME "preceded by a real word character" test Unicode-aware
// instead of narrowing what counts as URL-shaped — a genuine root-relative
// URL (preceded by whitespace/quote/start-of-string either way) is scrubbed
// exactly as before.
const EMBEDDED_RELATIVE_URL_RE = /(?<![\p{L}\p{N}_])\/\/?[^\s"'<>)]+/gu;

/**
 * Scrubs URL-shaped substrings out of free-form integration error text
 * (Codex round-2 item 1, extended by round-3 item 1). `sanitizeSource` above
 * strips exactly this — query and fragment, keeping origin and path — for a
 * `src` field that IS a bare URL; this reuses the SAME reduction for any URL
 * found INSIDE a larger string, because a real Shaka/hls.js HTTP failure
 * routinely embeds the full failing request URL verbatim in its error
 * message, and a signed CDN/licence request carries its token in the query
 * string — same-origin licence endpoints are ordinary, so a root-relative or
 * protocol-relative request URL is just as likely to appear here as an
 * absolute one. Applies to ANY integration's error text (built-in or a
 * customer's own), not just Shaka's — hls.js error details can carry URLs
 * too, and this runs at the single funnel every integration's events pass
 * through (`player-adapter.ts`'s `integrationEmit`), not per-integration.
 *
 * A substring that merely LOOKS like it starts an absolute URL but doesn't
 * parse (a truncated/malformed one) is left alone rather than mangled — this
 * is a best-effort scrub of recognisable URLs, not a guarantee every
 * possible secret-bearing substring is caught. The relative-URL pass never
 * needs to parse at all — it just drops everything from the first `?`/`#`
 * onward — but skips that drop when the `?`/`#` is the very last character
 * of the match (nothing follows it): that shape is ordinary punctuation
 * ending a sentence ("Did you mean /help? Try again."), not a query string,
 * and a real query/fragment always has at least one character after the
 * marker.
 */
export function scrubUrlsInText(text: string): string {
  const absoluteScrubbed = text.replace(EMBEDDED_URL_RE, (match) => {
    try {
      return originAndPath(new URL(match));
    } catch {
      return match;
    }
  });
  return absoluteScrubbed.replace(EMBEDDED_RELATIVE_URL_RE, (match) => {
    const cut = match.search(/[?#]/);
    if (cut === -1 || cut === match.length - 1) return match;
    return match.slice(0, cut);
  });
}
