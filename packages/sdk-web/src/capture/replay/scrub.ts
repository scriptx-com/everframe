// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// REPLAY-04 — post-serialization scrub. The PRIVACY POLICY gets the LAST WORD.
//
// Spec 2026-10-11, "Web masking". rrweb masks inputs and blocks sensitive
// elements at capture; this pass walks the emitted rrweb JSON and enforces,
// whatever rrweb did:
//   (a) pattern PII removed from EVERY string leaf, `textContent`/`text`
//       included: the sdk-core Luhn/JWT/SSN/email scrubber (email forced on)
//       plus RFC 6750 bearer tokens. Ordinary UI text stays VISIBLE.
//   (b) every Input event's value is the mask placeholder and never carries a
//       checked state (maskAllInputs, enforced after the fact).
//   (c) an attribute ALLOWLIST that strips what rrweb is known to leak (#1581:
//       no attribute masking by default; #1385/#1609/#456/#1596: values escape
//       via full-snapshot/hidden-input/select/textarea paths) and form state
//       (checked/selected), with `style`/`_cssText` (strings, and style diff
//       objects on mutations) URL-stripped via a CSS url() extractor (CR-03).
// Free-text non-pattern PII outside inputs is the customer's to mark sensitive.
import { redactStringContent, type RedactionEngineConfig } from '@everframe/sdk-core';

import { MASK_PLACEHOLDER } from './mask-mapping.js';

/**
 * Attribute ALLOWLIST policy (RESEARCH §"Pattern 3", #1581). Any attribute whose
 * name is NOT structurally safe is stripped from every serialized DOM node. We
 * keep only layout/identity attributes that cannot carry user content.
 *
 * Everything else — `value`, `placeholder`, `title`, `alt`, `aria-label`, every
 * `data-*`, and form state (`checked`, `selected`: what the user chose is an
 * input value, spec 2026-10-11) — is removed. `href`/`src` are kept but query
 * strings are stripped.
 */
const ALLOWED_ATTRS = new Set<string>([
  'id',
  'class',
  'type',
  'name',
  'rel',
  'role',
  'width',
  'height',
  'colspan',
  'rowspan',
  'disabled',
  'readonly',
  'hidden',
  'dir',
  'lang',
  'rr_width',
  'rr_height',
  '_cssText',
  'style',
  'href',
  'src',
]);

/** rrweb EventType.IncrementalSnapshot / IncrementalSource.Input. Literals: no rrweb import (REPLAY-05). */
const INCREMENTAL_SNAPSHOT = 3;
const INPUT_SOURCE = 5;

/**
 * RFC 6750 bearer credentials: the `bearer` pattern of
 * packages/protocol/data/redaction-patterns.json without its `(?i)` prefix
 * (JS spells it as the `i` flag). mask-zero-leak.spec.ts pins the parity.
 * Replay-only: sdk-core's shared `redactStringContent` is unchanged.
 */
export const BEARER_PATTERN_SOURCE = String.raw`Bearer\s+[A-Za-z0-9._~+/-]+=*`;
const BEARER = new RegExp(BEARER_PATTERN_SOURCE, 'gi');
const BEARER_REPLACEMENT = '[REDACTED]';

/** Attributes that hold URLs — kept, but query strings stripped (#1581). */
const URL_ATTRS = new Set<string>(['href', 'src']);

/** Strip the query string + fragment from a URL-bearing attribute value. */
function stripUrlQuery(value: string): string {
  // Keep the path; drop everything from the first `?` or `#`.
  const q = value.search(/[?#]/);
  return q >= 0 ? value.slice(0, q) : value;
}

/**
 * Strip query strings from every `url(...)` token inside a CSS value (CR-03).
 *
 * `style` and `_cssText` are kept on the allowlist (the player needs layout), but
 * an inline `background:url(https://t.example.com?token=SECRET)` would otherwise
 * exfil the query string. This finds each `url( ... )` token — handling optional
 * single/double quotes and surrounding whitespace — and rewrites the inner URL
 * through `stripUrlQuery`, leaving the surrounding CSS intact.
 */
function stripCssUrls(value: string): string {
  return value.replace(
    /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi,
    (_match, quote: string, inner: string) => `url(${quote}${stripUrlQuery(inner)}${quote})`,
  );
}

/**
 * Remove complete bearer credentials first: other pattern redactors can split
 * a credential and leave a suffix the bearer expression no longer recognizes.
 * Then run sdk-core's Luhn/JWT/SSN scrubber with email masking forced ON.
 */
function scrubText(value: string, config: RedactionEngineConfig): string {
  return redactStringContent(value.replace(BEARER, BEARER_REPLACEMENT), config);
}

/**
 * A `style` value: a string on a serialized node, or — on an attribute
 * MUTATION — an object of property → value (or [value, priority]). Every
 * string inside is pattern-scrubbed and URL-stripped (CR-03).
 */
function scrubStyle(value: unknown, config: RedactionEngineConfig): unknown {
  if (typeof value === 'string') return stripCssUrls(scrubText(value, config));
  if (Array.isArray(value)) return value.map((item) => scrubStyle(item, config));
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) record[key] = scrubStyle(record[key], config);
  }
  return value;
}

/** The redaction config the replay scrub runs with: email ON (replay is high-liability). */
export function replayRedactionConfig(base?: RedactionEngineConfig): RedactionEngineConfig {
  const maskInputs = new Set<'email' | 'tel' | 'creditcard' | 'ssn'>(base?.maskInputs ?? []);
  maskInputs.add('email');
  return {
    ...(base ?? {}),
    maskInputs: Array.from(maskInputs),
  };
}

/** Recursively scrub an attributes record in place on a serialized node. */
function scrubAttributes(
  attributes: Record<string, unknown>,
  config: RedactionEngineConfig,
): void {
  for (const key of Object.keys(attributes)) {
    const lower = key.toLowerCase();
    if (lower === 'rr_scrollleft' || lower === 'rr_scrolltop') {
      // rrweb rebuild consumes numeric held-scroll state from full snapshots.
      // These internal layout fields must never become a string payload path.
      if (typeof attributes[key] !== 'number' || !Number.isFinite(attributes[key])) delete attributes[key];
      continue;
    }
    if (URL_ATTRS.has(lower)) {
      const v = attributes[key];
      if (typeof v === 'string') {
        attributes[key] = stripUrlQuery(scrubText(v, config));
      }
      continue;
    }
    if (lower === 'style' || lower === '_csstext') {
      // CR-03 — `style`/`_cssText` carry layout the player needs, but can also
      // carry `url(...?token=SECRET)` exfil. Pattern-scrub THEN strip the query
      // string from every CSS url() token, in strings and in style diff objects.
      // Handled BEFORE the allowlist check because `_cssText` lowercases to
      // `_csstext`, which the mixed-case ALLOWED_ATTRS membership would not match.
      attributes[key] = scrubStyle(attributes[key], config);
      continue;
    }
    if (!ALLOWED_ATTRS.has(lower)) {
      // Disallowed attribute (value/placeholder/title/alt/aria-label/data-*) —
      // strip it entirely rather than mask, so nothing leaks via attributes.
      delete attributes[key];
      continue;
    }
    // Allowed non-URL attribute: still scrub any string content defensively.
    const v = attributes[key];
    if (typeof v === 'string') {
      attributes[key] = scrubText(v, config);
    }
  }
}

/**
 * Recursively walk an arbitrary serialized-rrweb value, scrubbing:
 *   - `textContent` / `text` string fields (text nodes, #text),
 *   - `attributes` objects (allowlist + URL query strip),
 *   - any other string leaf (defensive — covers select/textarea value escapes).
 */
function scrubNode(node: unknown, config: RedactionEngineConfig): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) scrubNode(item, config);
    return;
  }
  const obj = node as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (key === 'attributes' && val !== null && typeof val === 'object' && !Array.isArray(val)) {
      scrubAttributes(val as Record<string, unknown>, config);
      continue;
    }
    if (typeof val === 'string') {
      // SELECTIVE redaction (owner decision 2026-06-16): run the pattern scrubber
      // (Luhn/JWT/SSN/email/bearer) over every string leaf — including `textContent`/`text`
      // — so credit cards / JWTs / SSNs / emails are masked, but ordinary UI text
      // stays VISIBLE and the replay is watchable. The aggressive bits are already
      // handled at CAPTURE: rrweb `maskAllInputs` masks every input value, and
      // `markSensitive` / sensitive-rect map to rrweb `rr-block` so those subtrees
      // are OMITTED entirely. Free-text non-pattern PII (names typed into
      // non-inputs) is the customer's responsibility via markSensitive — the
      // standard session-replay posture (FullStory/LogRocket).
      obj[key] = scrubText(val, config);
      continue;
    }
    if (val !== null && typeof val === 'object') {
      scrubNode(val, config);
    }
  }
}

/**
 * maskAllInputs masks every typed value at capture; this enforces it after the
 * fact, so an rrweb gap or an input the masking missed can never ship a value:
 * an Input event carries the placeholder and never a checked state.
 */
function maskInputEvent(event: unknown): void {
  if (event === null || typeof event !== 'object') return;
  const { type, data } = event as { type?: unknown; data?: unknown };
  if (type !== INCREMENTAL_SNAPSHOT || data === null || typeof data !== 'object') return;
  const input = data as Record<string, unknown>;
  if (input['source'] !== INPUT_SOURCE) return;
  if (typeof input['text'] === 'string') input['text'] = MASK_PLACEHOLDER;
  if (input['isChecked'] === true) input['isChecked'] = false;
}

/**
 * Post-serialization scrub over an array of emitted rrweb events. Mutates a deep
 * clone and returns it — the input is never mutated. The scrub is the policy's
 * LAST WORD over the transport-floor output.
 *
 * @param events  the emitted rrweb events (eventWithTime[])
 * @param baseConfig  optional customer redaction config (custom rules/allow props)
 */
export function scrubReplayEvents<T>(events: readonly T[], baseConfig?: RedactionEngineConfig): T[] {
  const config = replayRedactionConfig(baseConfig);
  // Deep clone so the retained buffer is untouched (it may still be live).
  const cloned: T[] = JSON.parse(JSON.stringify(events));
  for (const event of cloned) {
    maskInputEvent(event);
    scrubNode(event, config);
  }
  return cloned;
}

/** Re-export for callers that want the placeholder marker (golden-file affordance). */
export { MASK_PLACEHOLDER };
