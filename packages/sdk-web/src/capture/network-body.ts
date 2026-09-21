// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import { redactStringContent } from '@traceitx/sdk-core';
import type { RedactionConfig } from '@traceitx/sdk-core';

/**
 * True iff `contentType` (a raw header value, possibly with `; charset=…`)
 * matches an allowlist entry. Entries are exact (`application/json`) or a
 * `type/*` wildcard (`text/*`). Comparison is case-insensitive; params ignored.
 */
export function contentTypeAllowed(
  contentType: string | null | undefined,
  allowlist: string[],
): boolean {
  if (!contentType) return false;
  const mime = contentType.split(';', 1)[0]!.trim().toLowerCase();
  if (!mime) return false;
  const [type] = mime.split('/', 1);
  for (const raw of allowlist) {
    const entry = raw.trim().toLowerCase();
    if (entry === mime) return true;
    if (entry.endsWith('/*') && entry.slice(0, -2) === type) return true;
  }
  return false;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder(); // default: fatal=false → lone bytes become U+FFFD

/**
 * Cap `text` to at most `byteCap` UTF-8 bytes without splitting a multi-byte
 * character. Returns the (possibly shorter) text, a truncation flag, and the
 * ORIGINAL UTF-8 byte length. When the cut lands mid-character we drop the
 * trailing partial char rather than emit a replacement glyph.
 */
export function capUtf8(text: string, byteCap: number): { text: string; truncated: boolean; bytes: number } {
  const full = encoder.encode(text);
  if (full.length <= byteCap) return { text, truncated: false, bytes: full.length };
  // Decode the first byteCap bytes; a trailing partial char decodes to U+FFFD —
  // strip it so no half-character survives.
  let sliced = decoder.decode(full.subarray(0, byteCap));
  if (sliced.endsWith('�')) sliced = sliced.slice(0, -1);
  return { text: sliced, truncated: true, bytes: full.length };
}

/** Reuse the default-deny redaction engine on a body string (JWT/SSN/CC/custom). */
export function redactBodyText(text: string, cfg: RedactionConfig): string {
  return redactStringContent(text, cfg);
}
