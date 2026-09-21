// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// REPLAY-04 — post-serialization scrub. The PRIVACY POLICY gets the LAST WORD.
//
// rrweb's masking is the transport floor; this pass walks the emitted rrweb JSON
// and applies SELECTIVE redaction (owner decision 2026-06-16 — a watchable replay
// cannot also mask all free text):
//   (a) the sdk-core Luhn/JWT/SSN/email scrubber over EVERY string leaf, including
//       `textContent`/`text`. Pattern PII (credit cards, JWTs, SSNs, emails) is
//       masked; ordinary UI text stays VISIBLE. The aggressive masking lives at
//       CAPTURE instead: rrweb `maskAllInputs` masks every input value, and
//       `markSensitive` / sensitive-rect map to rrweb `rr-block` (those subtrees
//       are OMITTED). Free-text non-pattern PII (names in non-inputs) is the
//       customer's responsibility via markSensitive — standard replay posture.
//   (c) an attribute ALLOWLIST that strips the attributes rrweb is known
//       to leak (#1581: no attribute masking by default; #1385/#1609/#456/#1596:
//       values escape via full-snapshot/hidden-input/select/textarea paths), with
//       `style`/`_cssText` URL-stripped via a CSS url() extractor (CR-03) so
//       `url(...?token=SECRET)` exfil query strings cannot survive in inline CSS.
//
// Closes the documented rrweb leakage gaps regardless of the rrweb config, so the
// golden-file zero-leak suite holds even on the populated-field checkout path.
import { redactStringContent, type RedactionEngineConfig } from '@traceitx/sdk-core';

import { MASK_PLACEHOLDER } from './mask-mapping.js';

/**
 * Attribute ALLOWLIST policy (RESEARCH §"Pattern 3", #1581). Any attribute whose
 * name is NOT structurally safe is stripped from every serialized DOM node. We
 * keep only layout/identity attributes that cannot carry user content.
 *
 * Everything else — `value`, `placeholder`, `title`, `alt`, `aria-label`, every
 * `data-*` — is removed. `href`/`src` are kept but query strings are stripped.
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
  'checked',
  'selected',
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
 * Scrub a single string value: run the sdk-core default-deny Luhn/JWT/SSN scrubber
 * (with email masking forced ON — replay must never carry an email even though the
 * SDK-wide default leaves email opt-in). Any leftover masked text already arrives
 * as the placeholder from rrweb; this pass guarantees a value never survives.
 */
function scrubText(value: string, config: RedactionEngineConfig): string {
  return redactStringContent(value, config);
}

/** The redaction config the replay scrub runs with: email ON (replay is high-liability). */
function replayRedactionConfig(base?: RedactionEngineConfig): RedactionEngineConfig {
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
    if (URL_ATTRS.has(lower)) {
      const v = attributes[key];
      if (typeof v === 'string') {
        attributes[key] = stripUrlQuery(scrubText(v, config));
      }
      continue;
    }
    if (lower === 'style' || lower === '_csstext') {
      // CR-03 — `style`/`_cssText` carry layout the player needs, but can also
      // carry `url(...?token=SECRET)` exfil. Run the pattern scrub THEN strip the
      // query string from every CSS url() token (the attribute is not dropped).
      // Handled BEFORE the allowlist check because `_cssText` lowercases to
      // `_csstext`, which the mixed-case ALLOWED_ATTRS membership would not match.
      const v = attributes[key];
      if (typeof v === 'string') {
        attributes[key] = stripCssUrls(scrubText(v, config));
      }
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
      // (Luhn/JWT/SSN/email) over every string leaf — including `textContent`/`text`
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
    scrubNode(event, config);
  }
  return cloned;
}

/** Re-export for callers that want the placeholder marker (golden-file affordance). */
export { MASK_PLACEHOLDER };
