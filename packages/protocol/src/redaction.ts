// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// JWT and JWE redaction by structure, not by a base64 prefix list.
//
// A candidate is a header segment of base64url characters (at least 8), a `.`, a payload or
// encrypted-key segment, a `.`, and a third segment (possibly empty: an unsecured JWT); a JWE adds
// two more. It is redacted only when the header decodes to a JOSE header: RFC 7515 and RFC 7516
// require every JOSE header to be a JSON object with an "alg" member. So the decoded header, after
// any leading JSON whitespace, must start with `{` and contain `"alg"`. Dotted class, package and
// module names, bundle IDs, version strings and Kotlin `$lambda` frames never decode to that.
//
// The Android and iOS SDKs implement the same scanner (`JwtScan`). The `jwt` entry in
// data/redaction-patterns.json names it and keeps only a candidate regex (JWT_CANDIDATE_PATTERN)
// for an engine that can read nothing else; the scanner is authoritative. A shared corpus
// (__tests__/fixtures/jwt-redaction-corpus.v1.json) holds expected outputs from one reference
// implementation, and all three scanners are tested against it.

export const JWT_REPLACEMENT = '[REDACTED:JWT]';
/** Candidate shape only: an engine that cannot run the scanner over-redacts with it. */
export const JWT_CANDIDATE_PATTERN = String.raw`[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*)?`;
/** Text glued before a header (`x_`, `token`, the `3D` of `%3D`) that the scanner looks past. */
export const MAX_JWT_GLUE = 64;
/**
 * Starts per candidate whose whole header is decoded. A start is decoded only when its first 8
 * characters pass the prefix check (whitespace, `{`, whitespace, `"`), which glued text rarely does.
 */
export const MAX_JWT_FULL_DECODES = 4;
const MIN_HEADER = 8;
const DOT = 46;

const BASE64URL: Int8Array = (() => {
  const table = new Int8Array(128).fill(-1);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  for (let index = 0; index < alphabet.length; index++) table[alphabet.charCodeAt(index)] = index;
  return table;
})();

/** [A-Za-z0-9_-]: the characters of one base64url segment. */
function isSegmentChar(code: number): boolean {
  return code < 128 && BASE64URL[code]! >= 0;
}

function segmentEnd(value: string, from: number): number {
  let end = from;
  while (end < value.length && isSegmentChar(value.charCodeAt(end))) end++;
  return end;
}

function isJsonWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function byteAt(a: number, b: number, c: number, d: number, k: number): number {
  return k === 0 ? (a << 2) | (b >> 4) : k === 1 ? ((b & 15) << 4) | (c >> 2) : ((c & 3) << 6) | d;
}

/**
 * The prefix check: the first 8 characters at `start` (6 bytes) decode to optional JSON whitespace,
 * `{`, optional whitespace and `"` (a JOSE header's first member name). Whitespace that runs past
 * the 6 bytes passes; the full decode decides.
 */
export function joseHeaderPrefix(value: string, start: number): boolean {
  let state = 0; // 0: before `{`, 1: after `{`
  for (let index = start; index < start + 8; index += 4) {
    const a = BASE64URL[value.charCodeAt(index)]!;
    const b = BASE64URL[value.charCodeAt(index + 1)]!;
    const c = BASE64URL[value.charCodeAt(index + 2)]!;
    const d = BASE64URL[value.charCodeAt(index + 3)]!;
    for (let k = 0; k < 3; k++) {
      const byte = byteAt(a, b, c, d, k);
      if (isJsonWhitespace(byte)) continue;
      if (state === 0 && byte === 0x7b) { state = 1; continue; }
      return state === 1 && byte === 0x22;
    }
  }
  return true;
}

const ALG = 0x22616c6722; // "alg"
const ENC = 0x22656e6322; // "enc"
const WINDOW = 2 ** 40; // five bytes

/**
 * Decodes the whole header value[start, end) once, keeping only the last five bytes, and checks
 * for a JOSE header: optional JSON whitespace, `{`, and `"alg"` anywhere after it. Returns 0 when
 * it is not one, 1 for a header with "alg" and 2 when it also names "enc" (a JWE). Linear in the
 * header length, with no cap: certificate chains (x5c) make headers several kilobytes long.
 */
export function joseHeaderKind(value: string, start: number, end: number): 0 | 1 | 2 {
  let opened = false;
  let alg = false;
  let enc = false;
  let window = 0;
  for (let index = start; end - index >= 2; index += 4) {
    const remaining = end - index;
    const a = BASE64URL[value.charCodeAt(index)]!;
    const b = BASE64URL[value.charCodeAt(index + 1)]!;
    const c = remaining > 2 ? BASE64URL[value.charCodeAt(index + 2)]! : -1;
    const d = remaining > 3 ? BASE64URL[value.charCodeAt(index + 3)]! : -1;
    const count = c < 0 ? 1 : d < 0 ? 2 : 3;
    for (let k = 0; k < count; k++) {
      const byte = byteAt(a, b, c, d, k);
      if (!opened) {
        if (byte === 0x7b) opened = true;
        else if (!isJsonWhitespace(byte)) return 0;
      }
      window = (window * 256 + byte) % WINDOW;
      if (window === ALG) alg = true;
      else if (window === ENC) enc = true;
    }
  }
  if (!opened || !alg) return 0;
  return enc ? 2 : 1;
}

/**
 * The token whose header segment ends at `headerEnd` (a `.` follows), with its header starting
 * in the first MAX_JWT_GLUE characters of the run [runStart, headerEnd); null when none verifies.
 * A JWE header with two more segments takes all five; otherwise three, with a payload of at least
 * 2 characters (`{}` is `e30`).
 */
function tokenAt(value: string, runStart: number, headerEnd: number): { start: number; end: number } | null {
  const payloadEnd = segmentEnd(value, headerEnd + 1);
  if (value.charCodeAt(payloadEnd) !== DOT) return null;
  const thirdEnd = segmentEnd(value, payloadEnd + 1);
  let fifthEnd = -1;
  if (value.charCodeAt(thirdEnd) === DOT) {
    const fourthEnd = segmentEnd(value, thirdEnd + 1);
    if (value.charCodeAt(fourthEnd) === DOT) fifthEnd = segmentEnd(value, fourthEnd + 1);
  }
  const payloadLength = payloadEnd - headerEnd - 1;
  const last = Math.min(runStart + MAX_JWT_GLUE, headerEnd - MIN_HEADER);
  let decodes = 0;
  for (let start = runStart; start <= last && decodes < MAX_JWT_FULL_DECODES; start++) {
    if (!joseHeaderPrefix(value, start)) continue;
    decodes++;
    const kind = joseHeaderKind(value, start, headerEnd);
    if (kind === 0) continue;
    if (kind === 2 && fifthEnd >= 0) return { start, end: fifthEnd };
    if (payloadLength >= 2) return { start, end: thirdEnd };
  }
  return null;
}

/**
 * Replaces every JWT and JWE in `value` whose header decodes to a JOSE header. Linear: each segment
 * run is a header candidate once, a candidate reads at most four more segments, it checks the
 * 8-character prefix at most MAX_JWT_GLUE + 1 times, and it decodes the whole header at most
 * MAX_JWT_FULL_DECODES times. A token glued to the text before it keeps that text; only the token
 * is replaced.
 */
export function redactJwt(value: string, replacement: string = JWT_REPLACEMENT): string {
  let out = '';
  let copied = 0;
  let index = 0;
  while (index < value.length) {
    if (!isSegmentChar(value.charCodeAt(index))) { index++; continue; }
    const runEnd = segmentEnd(value, index);
    const token = runEnd - index >= MIN_HEADER && value.charCodeAt(runEnd) === DOT ? tokenAt(value, index, runEnd) : null;
    if (token) {
      out += value.slice(copied, token.start) + replacement;
      copied = token.end;
      index = token.end;
    } else {
      index = runEnd;
    }
  }
  return copied === 0 ? value : out + value.slice(copied);
}
