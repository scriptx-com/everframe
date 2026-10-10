// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The shared JWT rule, as one string for every engine: data/redaction-patterns.json (`jwt`, loaded
// by the Android and iOS SDKs) carries the same bytes, and a protocol spec keeps them equal.
//
// A JWS has three base64url segments; a JWE has five, and `dir` / ECDH-ES leave the second one
// empty. The header is base64url JSON: its `{` always encodes to `e`, then `y` for a following
// `"` or space and `w` for a newline, tab or carriage return. So a header starts with `eyJ` (`{"`),
// `eyA` (`{ `), `ewo` (`{\n`), `ewk` (`{\t`) or `ew0` (`{\r`); class, package and module names
// almost never do. Three branches:
// - at the start of a word: a JWS or JWE (an optional second segment, then one to three more);
// - glued to the text before it (`%3D…`, `x_…`, `\n…` in JSON), a five-segment JWE, which needs no
//   JSON payload (its second segment is an encrypted key, or empty for `dir`);
// - glued, a JWS whose payload is JSON too.
// There is no lookbehind: Safari before 16.4 cannot parse one.
export const JWT_PATTERN = String.raw`\b(?:eyJ|eyA|ewo|ewk|ew0)[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,}){0,2}|(?:eyJ|eyA|ewo|ewk|ew0)[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]{8,}){3}|(?:eyJ|eyA|ewo|ewk|ew0)[A-Za-z0-9_-]{5,}\.(?:eyJ|eyA|ewo|ewk|ew0)[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}`;
export const JWT_REPLACEMENT = '[REDACTED:JWT]';

const JWT_AT = new RegExp(JWT_PATTERN, 'y');
// The fewest characters a header can have: a three-character JSON prefix plus five.
const MIN_HEADER = 8;

/** [A-Za-z0-9_-]: the characters of one base64url segment. */
function isSegmentChar(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
    || code === 95 || code === 45;
}

/** Whether a JSON header's base64url can start at `index`: `eyJ`, `eyA`, `ewo`, `ewk` or `ew0`. */
function headerPrefixAt(value: string, index: number): boolean {
  if (value.charCodeAt(index) !== 101) return false; // e
  const second = value.charCodeAt(index + 1);
  const third = value.charCodeAt(index + 2);
  if (second === 121) return third === 74 || third === 65; // y: J or A
  if (second === 119) return third === 111 || third === 107 || third === 48; // w: o, k or 0
  return false;
}

function nextHeaderPrefix(value: string, from: number): number {
  for (let index = from; index + 3 <= value.length; index++) if (headerPrefixAt(value, index)) return index;
  return -1;
}

/** The first header prefix after a `-` in [from, end) that still leaves a full header; -1 when none. */
function boundaryStart(value: string, from: number, end: number): number {
  for (let index = from; index + MIN_HEADER <= end; index++) {
    if (value.charCodeAt(index - 1) === 45 && headerPrefixAt(value, index)) return index;
  }
  return -1;
}

function matchEndAt(value: string, start: number): number {
  JWT_AT.lastIndex = start;
  const match = JWT_AT.exec(value);
  return match ? start + match[0].length : -1;
}

/**
 * `value.replace(new RegExp(JWT_PATTERN, 'g'), replacement)`, in linear time.
 *
 * The plain scan retries the pattern at every header prefix, and each try runs to the end of its
 * segment, so `'eyJ-'.repeat(n)` costs O(n²): seconds for a 64 KB body, minutes for a megabyte.
 * Every match starts with a header prefix and a header that runs to the end of its segment, where
 * a `.` must follow. All starts inside one segment therefore end their header at the same place
 * and succeed or fail on the same text after it; a later start only has a shorter header. So the
 * leftmost start, then the leftmost start at a word boundary (the first branch needs one; inside a
 * segment only `-` gives one), decide the whole segment. Each try reads at most five segments.
 */
export function redactJwt(value: string, replacement: string = JWT_REPLACEMENT): string {
  let out = '';
  let copied = 0;
  let from = 0;
  for (;;) {
    const first = nextHeaderPrefix(value, from);
    if (first < 0) break;
    let end = first + 3;
    while (end < value.length && isSegmentChar(value.charCodeAt(end))) end++;
    if (end - first >= MIN_HEADER && value.charCodeAt(end) === 46) {
      let matchEnd = matchEndAt(value, first);
      let start = first;
      if (matchEnd < 0) {
        const boundary = boundaryStart(value, first + 1, end);
        if (boundary >= 0) {
          start = boundary;
          matchEnd = matchEndAt(value, start);
        }
      }
      if (matchEnd >= 0) {
        out += value.slice(copied, start) + replacement;
        copied = matchEnd;
        from = matchEnd;
        continue;
      }
    }
    from = end;
  }
  return copied === 0 ? value : out + value.slice(copied);
}
