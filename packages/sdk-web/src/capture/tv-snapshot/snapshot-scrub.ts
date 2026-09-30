// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Post-serialization scrub for TV DOM snapshots (spec §Privacy and masking).
// Its OWN allowlist — the replay scrubber (scrub.ts) is untouched: that one
// deletes rr_scroll*, aria-* and every SVG attribute, which is right for replay
// and wrong for a screenshot (scrolled rails render from the top, selection
// styling and icons vanish). Every retained slot is shape-validated.
// LAZY (tv-snapshot chunk).
import { redactStringContent, type RedactionEngineConfig } from '@everframe/sdk-core';
import { MASK_PLACEHOLDER } from '../replay/mask-mapping.js';
import { replayRedactionConfig } from '../replay/scrub.js';
import { scrubCssText, scrubInlineStyle, type CssScrubContext } from './css-scrub.js';
import { fragmentId, isDataUrl, sanitizeHttpUrl, sanitizeSrcset } from './url-sanitize.js';
import { isAllowedSvgAttr, isAriaStateValue } from './allowlists.js';
import {
  SN_CDATA,
  SN_COMMENT,
  SN_ELEMENT,
  SN_TEXT,
  type SnAttributeValue,
  type SnElement,
  type SnNode,
} from './sn-types.js';

export interface SnapshotScrubContext extends CssScrubContext {
  redaction?: RedactionEngineConfig | undefined;
}

/** Layout/identity attributes that cannot carry user content (same spirit as scrub.ts). */
const BASE_ATTRS = new Set([
  'id', 'class', 'type', 'name', 'rel', 'role', 'width', 'height', 'colspan', 'rowspan',
  'checked', 'selected', 'disabled', 'readonly', 'hidden', 'dir', 'lang', 'sizes', 'media',
]);
const URL_ATTRS = new Set(['href', 'src', 'poster', 'xlink:href']);
const LINK_TAGS = new Set(['a', 'area']);

// ── bounded pattern scrub (S18) ────────────────────────────────────────────
// The shared redaction engine's JWT and email patterns are unanchored `+`/`{8,}`
// runs: on a long run of word characters they backtrack quadratically (20k
// chars ≈ 0.6 s on a laptop, far worse on a TV CPU). Every character those
// patterns can match is in TOKEN_CHAR, so capping each maximal TOKEN_CHAR run
// bounds every match attempt; an over-long run is a blob or a token, never
// display text, and is masked whole. Prose and CJK are untouched.

/** No legitimate email or display word is longer; a longer JWT is masked whole. */
const MAX_TOKEN_RUN = 128;
/** Far more text than one TV-screen node shows; the rest is dropped before any regex. */
const MAX_PATTERN_TEXT_LENGTH = 65_536;

/** [A-Za-z0-9._%+@-] — the union of the engine's JWT and email character classes. */
function isTokenChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 46 || code === 95 || code === 37 || code === 43 || code === 64 || code === 45
  );
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

function redactPageString(value: string, config: RedactionEngineConfig): string {
  const capped = value.length > MAX_PATTERN_TEXT_LENGTH ? value.slice(0, MAX_PATTERN_TEXT_LENGTH) : value;
  return redactStringContent(maskLongTokenRuns(capped), config);
}

// ── attributes ─────────────────────────────────────────────────────────────

function sanitizeDomUrl(value: string, ctx: SnapshotScrubContext): string | null {
  const id = fragmentId(value);
  if (id !== null) return ctx.retainedIds.has(id) ? `#${id}` : null;
  const t = value.trim();
  if (t.startsWith('#')) return null;
  if (isDataUrl(t)) return !ctx.masked && /^data:image\//i.test(t) ? t : null;
  return sanitizeHttpUrl(t, ctx.baseHref);
}

function scrubElement(node: SnElement, ctx: SnapshotScrubContext, config: RedactionEngineConfig): void {
  const tag = node.tagName.toLowerCase();
  const next: Record<string, SnAttributeValue> = {};
  for (const key of Object.keys(node.attributes)) {
    const value = node.attributes[key];
    if (value === null || value === undefined) continue;
    const lower = key.toLowerCase();
    if (lower === 'rr_scrollleft' || lower === 'rr_scrolltop') {
      if (typeof value === 'number' && Number.isFinite(value)) next[key] = value;
      continue;
    }
    if (lower === '_csstext') {
      if (typeof value === 'string') next[key] = scrubCssText(value, ctx);
      continue;
    }
    if (lower === 'style') {
      if (typeof value === 'string') {
        const style = scrubInlineStyle(value, ctx);
        if (style !== '') next[key] = style;
      }
      continue;
    }
    if (lower === 'value') {
      if (value === MASK_PLACEHOLDER) next[key] = value;
      continue;
    }
    if (lower === 'srcset') {
      if (typeof value === 'string') {
        const srcset = sanitizeSrcset(value, ctx.baseHref);
        if (srcset !== null) next[key] = srcset;
      }
      continue;
    }
    if (URL_ATTRS.has(lower)) {
      const url = sanitizeDomUrl(String(value), ctx);
      if (url !== null) next[key] = url;
      else if (lower === 'href' && LINK_TAGS.has(tag)) next[key] = '#'; // keeps :link styling, carries nothing
      continue;
    }
    if (typeof value === 'string' && isAriaStateValue(lower, value)) {
      next[key] = value;
      continue;
    }
    if (node.isSVG === true && isAllowedSvgAttr(key, String(value), ctx.retainedIds)) {
      next[key] = value;
      continue;
    }
    if (BASE_ATTRS.has(lower)) {
      next[key] = typeof value === 'string' ? redactPageString(value, config) : value;
    }
    // Everything else — title, alt, placeholder, aria-label, out-of-set ARIA
    // values, data-*, on*, rr_media*, rr_src, rr_width… — is dropped.
  }
  node.attributes = next;
}

// ── tree walk ──────────────────────────────────────────────────────────────

/**
 * Ids whose value the pattern scrub leaves unchanged. A fragment ref to an id
 * the scrub rewrote (e.g. `id="alice@example.test"`) would otherwise keep the
 * raw id text in the `#ref`.
 */
function survivingIds(ids: ReadonlySet<string>, config: RedactionEngineConfig): Set<string> {
  const out = new Set<string>();
  ids.forEach((id) => {
    if (redactPageString(id, config) === id) out.add(id);
  });
  return out;
}

/** Scrub a serialized snapshot tree in place. Iterative: page-controlled depth never grows the stack. */
export function scrubSnapshotTree(root: SnNode, ctx: SnapshotScrubContext): void {
  const config = replayRedactionConfig(ctx.redaction);
  const scrubCtx: SnapshotScrubContext = { ...ctx, retainedIds: survivingIds(ctx.retainedIds, config) };
  const stack: Array<{ node: SnNode; parentTag: string | null }> = [{ node: root, parentTag: null }];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const { node, parentTag } = item;
    if (node.type === SN_TEXT) {
      node.textContent =
        parentTag === 'style' || node.isStyle === true
          ? scrubCssText(node.textContent, scrubCtx)
          : redactPageString(node.textContent, config);
      continue;
    }
    if (node.type === SN_COMMENT || node.type === SN_CDATA) {
      node.textContent = '';
      continue;
    }
    if (node.type === SN_ELEMENT) {
      scrubElement(node, scrubCtx, config);
      const tag = node.tagName.toLowerCase();
      for (const child of node.childNodes) stack.push({ node: child, parentTag: tag });
      continue;
    }
    if ('childNodes' in node) for (const child of node.childNodes) stack.push({ node: child, parentTag: null });
  }
}

/** Every non-empty element id in the tree (before scrubbing). */
export function collectRetainedIds(root: SnNode): Set<string> {
  const ids = new Set<string>();
  const stack: SnNode[] = [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.type === SN_ELEMENT) {
      const id = node.attributes.id;
      if (typeof id === 'string' && id !== '') ids.add(id);
    }
    if ('childNodes' in node) for (const child of node.childNodes) stack.push(child);
  }
  return ids;
}
