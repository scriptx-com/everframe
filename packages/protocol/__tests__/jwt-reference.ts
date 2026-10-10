// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The reference JWT redaction: the rule written as plainly as possible, trying every position and
// decoding with Buffer. It is slow on purpose and only runs in tests. The TS, Kotlin and Swift
// scanners must give exactly its output (see jwt-redaction-corpus.v1.json).
import { Buffer } from 'node:buffer';

const SEGMENT = /[A-Za-z0-9_-]/;
const isSegment = (char: string | undefined) => char !== undefined && SEGMENT.test(char);
const segmentEnd = (value: string, from: number) => { let end = from; while (isSegment(value[end])) end++; return end; };
const runStart = (value: string, at: number) => { let start = at; while (start > 0 && isSegment(value[start - 1])) start--; return start; };

const decode = (text: string) => Buffer.from(text, 'base64url').toString('latin1');
/** The first 8 characters decode to optional whitespace, `{`, optional whitespace and `"`, or run out first. */
const prefixPasses = (value: string, start: number) => /^[ \t\n\r]*(?:\{[ \t\n\r]*(?:"|$)|$)/.test(decode(value.slice(start, start + 8)));

/** The end of a token that starts exactly at `start`, or -1. */
function tokenEnd(value: string, start: number): number {
  if (!isSegment(value[start])) return -1;
  const run = runStart(value, start);
  const headerEnd = segmentEnd(value, start);
  if (start - run > 64 || headerEnd - start < 8 || value[headerEnd] !== '.') return -1;
  // Only the first four starts of a run that pass the prefix check get a full decode.
  if (!prefixPasses(value, start)) return -1;
  let earlier = 0;
  for (let at = run; at < start; at++) if (headerEnd - at >= 8 && prefixPasses(value, at)) earlier++;
  if (earlier >= 4) return -1;
  // RFC 7515/7516: a JOSE header is a JSON object with an "alg" member. The whole header decodes.
  const header = decode(value.slice(start, headerEnd));
  if (!header.replace(/^[ \t\n\r]*/, '').startsWith('{') || !header.includes('"alg"')) return -1;
  const segments: Array<[number, number]> = [];
  for (let at = headerEnd; segments.length < 4 && value[at] === '.';) {
    const end = segmentEnd(value, at + 1);
    segments.push([at + 1, end]);
    at = end;
  }
  if (segments.length < 2) return -1;
  if (header.includes('"enc"') && segments.length === 4) return segments[3]![1];
  return segments[0]![1] - segments[0]![0] >= 2 ? segments[1]![1] : -1;
}

export function referenceRedactJwt(value: string, replacement = '[REDACTED:JWT]'): string {
  let out = '';
  let copied = 0;
  for (let at = 0; at < value.length;) {
    const end = tokenEnd(value, at);
    if (end < 0) { at++; continue; }
    out += value.slice(copied, at) + replacement;
    copied = end;
    at = end;
  }
  return out + value.slice(copied);
}
