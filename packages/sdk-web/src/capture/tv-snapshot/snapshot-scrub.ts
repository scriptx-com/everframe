// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Post-serialization scrub for TV DOM snapshots (spec §Privacy and masking).
// Its OWN allowlist — the replay scrubber (scrub.ts) is untouched: that one
// deletes rr_scroll*, aria-* and every SVG attribute, which is right for replay
// and wrong for a screenshot (scrolled rails render from the top, selection
// styling and icons vanish). Every retained slot is shape-validated.
// LAZY (tv-snapshot chunk).
import type { RedactionEngineConfig } from '@everframe/sdk-core';
import { MASK_PLACEHOLDER } from '../replay/mask-mapping.js';
import { pageRedactionConfig, redactPageString, redactUrlPath } from './page-redact.js';
import { scrubCssText, scrubInlineStyle, type CssScrubContext } from './css-scrub.js';
import { fragmentId, isDataUrl, sanitizeHttpUrl, sanitizeSrcset } from './url-sanitize.js';
import { isAllowedSvgAttr, isAriaStateValue } from './allowlists.js';
import {
  SN_CDATA,
  SN_COMMENT,
  SN_DOCTYPE,
  SN_ELEMENT,
  SN_TEXT,
  type SnAttributeValue,
  type SnElement,
  type SnNode,
  type SnOther,
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

// ── attributes ─────────────────────────────────────────────────────────────

function sanitizeDomUrl(value: string, ctx: SnapshotScrubContext, config: RedactionEngineConfig): string | null {
  const id = fragmentId(value);
  if (id !== null) return ctx.retainedIds.has(id) ? `#${id}` : null;
  const t = value.trim();
  if (t.startsWith('#')) return null;
  if (isDataUrl(t)) return !ctx.masked && /^data:image\//i.test(t) ? t : null;
  const clean = sanitizeHttpUrl(t, ctx.baseHref);
  return clean === null ? null : redactUrlPath(clean, config);
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
        const srcset = sanitizeSrcset(value, ctx.baseHref, (url) => redactUrlPath(url, config));
        if (srcset !== null) next[key] = srcset;
      }
      continue;
    }
    if (URL_ATTRS.has(lower)) {
      const url = sanitizeDomUrl(String(value), ctx, config);
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

// ── doctype ────────────────────────────────────────────────────────────────

// The standard DTD identifiers (HTML 2.0–4.01, XHTML 1.0/1.1/Basic, the HTML5
// legacy-compat string). They decide quirks/limited-quirks mode, so a known
// one is kept verbatim; anything else is page-chosen text and is cleared.
const DTD_PUBLIC_IDS = new Set(
  [
    '-//IETF//DTD HTML//EN',
    '-//IETF//DTD HTML 2.0//EN',
    '-//W3C//DTD HTML 3.2//EN',
    '-//W3C//DTD HTML 3.2 Final//EN',
    '-//W3C//DTD HTML 4.0//EN',
    '-//W3C//DTD HTML 4.0 Transitional//EN',
    '-//W3C//DTD HTML 4.0 Frameset//EN',
    '-//W3C//DTD HTML 4.01//EN',
    '-//W3C//DTD HTML 4.01 Transitional//EN',
    '-//W3C//DTD HTML 4.01 Frameset//EN',
    '-//W3C//DTD XHTML 1.0 Strict//EN',
    '-//W3C//DTD XHTML 1.0 Transitional//EN',
    '-//W3C//DTD XHTML 1.0 Frameset//EN',
    '-//W3C//DTD XHTML 1.1//EN',
    '-//W3C//DTD XHTML Basic 1.0//EN',
    '-//W3C//DTD XHTML Basic 1.1//EN',
    '-//WAPFORUM//DTD XHTML Mobile 1.0//EN',
    '-//WAPFORUM//DTD XHTML Mobile 1.1//EN',
    '-//WAPFORUM//DTD XHTML Mobile 1.2//EN',
  ].map((id) => id.toLowerCase()),
);
const DTD_SYSTEM_PATHS = [
  'TR/html4/strict.dtd', 'TR/html4/loose.dtd', 'TR/html4/frameset.dtd',
  'TR/REC-html40/strict.dtd', 'TR/REC-html40/loose.dtd', 'TR/REC-html40/frameset.dtd',
  'TR/xhtml1/DTD/xhtml1-strict.dtd', 'TR/xhtml1/DTD/xhtml1-transitional.dtd', 'TR/xhtml1/DTD/xhtml1-frameset.dtd',
  'TR/xhtml11/DTD/xhtml11.dtd', 'TR/xhtml-basic/xhtml-basic10.dtd', 'TR/xhtml-basic/xhtml-basic11.dtd',
];
const DTD_SYSTEM_IDS = new Set(
  ['about:legacy-compat'].concat(
    DTD_SYSTEM_PATHS.map((p) => `http://www.w3.org/${p}`.toLowerCase()),
    DTD_SYSTEM_PATHS.map((p) => `https://www.w3.org/${p}`.toLowerCase()),
  ),
);

/**
 * A doctype keeps only what sets the document mode: the `html` name and a
 * standard public/system identifier. (A system id also matters for mode —
 * HTML 4.01 Transitional with one is limited-quirks, without one quirks — so
 * a STANDARD one is kept; any other is cleared.)
 */
function scrubDoctype(node: SnOther): void {
  if (node.name !== undefined && node.name.toLowerCase() !== 'html') node.name = '';
  if (node.publicId !== undefined && !DTD_PUBLIC_IDS.has(node.publicId.toLowerCase())) node.publicId = '';
  if (node.systemId !== undefined && !DTD_SYSTEM_IDS.has(node.systemId.toLowerCase())) node.systemId = '';
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
  const config = pageRedactionConfig(ctx.redaction);
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
    if (node.type === SN_DOCTYPE) {
      scrubDoctype(node);
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
