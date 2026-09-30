// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Pattern redaction (emails, JWTs, card numbers, SSNs, customer rules) over
// page-controlled strings in a TV snapshot: text nodes, allowlisted attribute
// values and the paths of every retained URL, DOM or CSS (spec §Privacy and
// masking). Raw CSS is NOT pattern-scrubbed — it is allowlisted instead.
// LAZY (tv-snapshot chunk).
//
// Bounded (S18): the shared engine's JWT and email patterns are unanchored
// `+`/`{8,}` runs that backtrack quadratically on a long run of word
// characters (20k chars ≈ 0.6 s on a laptop, far worse on a TV CPU). Every
// character those patterns can match is a TOKEN char, so capping each maximal
// TOKEN run bounds every match attempt; an over-long run is a blob or a token,
// never display text, and is masked whole. Prose and CJK are untouched.
import { redactStringContent, type RedactionEngineConfig } from '@everframe/sdk-core';
import { MASK_PLACEHOLDER } from '../replay/mask-mapping.js';
import { replayRedactionConfig } from '../replay/scrub.js';

/** No legitimate email or display word is longer; a longer JWT is masked whole. */
const MAX_TOKEN_RUN = 128;
/** Far more text than one TV-screen node shows; the rest is dropped before any regex. */
export const MAX_PATTERN_TEXT_LENGTH = 65_536;

/** The engine config snapshots run with — the replay one (email masking ON). */
export function pageRedactionConfig(base?: RedactionEngineConfig): RedactionEngineConfig {
  return replayRedactionConfig(base);
}

/** [A-Za-z0-9._%+@-] — the union of the engine's JWT and email character classes. */
function isTokenChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 46 || code === 95 || code === 37 || code === 43 || code === 64 || code === 45
  );
}

/** [\d\s-] — the engine's card-number class (a card may straddle a cut between digit groups). */
function isDigitGroupChar(ch: string): boolean {
  return (ch >= '0' && ch <= '9') || ch === '-' || /\s/.test(ch);
}

/**
 * Cut at `max` without leaving a partial token behind: back up to the start of
 * a token run the cut lands inside, then past any trailing digit-group run
 * that contains a digit (so `alice@exa` or 12 of 16 card digits never survive
 * as unrecognizable fragments).
 */
function truncateAtTokenBoundary(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  if (isTokenChar(s.charCodeAt(end))) {
    while (end > 0 && isTokenChar(s.charCodeAt(end - 1))) end--;
  }
  let start = end;
  let digits = false;
  while (start > 0 && isDigitGroupChar(s[start - 1]!)) {
    start--;
    if (s[start]! >= '0' && s[start]! <= '9') digits = true;
  }
  return s.slice(0, digits ? start : end);
}

function maskLongTokenRuns(s: string): string {
  let out = '';
  let copied = 0;
  let i = 0;
  while (i < s.length) {
    if (!isTokenChar(s.charCodeAt(i))) {
      i++;
      continue;
    }
    const start = i;
    while (i < s.length && isTokenChar(s.charCodeAt(i))) i++;
    if (i - start > MAX_TOKEN_RUN) {
      out += s.slice(copied, start) + MASK_PLACEHOLDER;
      copied = i;
    }
  }
  return copied === 0 ? s : out + s.slice(copied);
}

/** Pattern-redact a page-controlled string (text node, attribute value). */
export function redactPageString(value: string, config: RedactionEngineConfig): string {
  return redactStringContent(maskLongTokenRuns(truncateAtTokenBoundary(value, MAX_PATTERN_TEXT_LENGTH)), config);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Pattern-redact the path of a URL already reduced to `scheme://host/path` by
 * sanitizeHttpUrl. Each path segment is percent-decoded first (so
 * `alice%40example.test` is caught) and re-encoded only when redaction changed
 * it, so the result is still a valid URL with the same segment structure.
 */
export function redactUrlPath(url: string, config: RedactionEngineConfig): string {
  const schemeEnd = url.indexOf('//');
  const pathStart = schemeEnd < 0 ? -1 : url.indexOf('/', schemeEnd + 2);
  if (pathStart < 0) return url;
  const segments = url.slice(pathStart).split('/');
  let changed = false;
  for (let k = 0; k < segments.length; k++) {
    const decoded = decodeSegment(segments[k]!);
    const redacted = redactPageString(decoded, config);
    if (redacted !== decoded) {
      segments[k] = encodeURIComponent(redacted);
      changed = true;
    }
  }
  return changed ? url.slice(0, pathStart) + segments.join('/') : url;
}
