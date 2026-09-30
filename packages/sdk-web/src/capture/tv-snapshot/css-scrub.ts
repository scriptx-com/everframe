// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Allowlist CSS scrubber for TV snapshots (spec §Privacy and masking).
//
// ALWAYS: every url(), image-set()/-webkit-image-set(), @import and
// @font-face src URL goes through the one URL sanitizer; fragment refs survive
// only when they name a retained id.
//
// ON A MASKED PAGE ONLY: every string token is removed except (1) font-family
// names (`font-family`, `font`, `local()`), (2) URL targets (which are
// sanitized, and `data:` ones dropped), (3) identifier-only
// grid-template-areas strings, (4) enumerated ARIA attribute-selector values.
// A declaration holding any other string is dropped whole, as is a rule whose
// selector (or an at-rule whose prelude) holds one; every custom property,
// every attr() text source and every @counter-style is dropped. A blocklist
// cannot be made safe here — content, quotes, counters, custom properties and
// more can all carry text.
//
// This runs on slow TV CPUs over page-controlled text: everything below is a
// single-pass scanner (no regex over unbounded input), identifiers are read
// with their escapes decoded the way the browser reads them (`u\72l(` IS
// `url(`), and rule nesting is capped. LAZY (tv-snapshot chunk).
import type { RedactionEngineConfig } from '@everframe/sdk-core';
import { isAriaStateValue } from './allowlists.js';
import { documentFragmentId, fragmentId, isDataUrl, sanitizeHttpUrl } from './url-sanitize.js';
import { pageRedactionConfig, redactUrlPath } from './page-redact.js';

export interface CssScrubContext {
  masked: boolean;
  retainedIds: ReadonlySet<string>;
  baseHref: string;
  /** Customer redaction rules; URL paths are pattern-redacted with them. */
  redaction?: RedactionEngineConfig | undefined;
}

/** Deeper at-rule nesting is dropped; real stylesheets nest a handful of levels. */
const MAX_RULE_DEPTH = 32;
/** Length caps that keep every remaining regex on short input (S18). */
const MAX_PROPERTY_LENGTH = 128;
const MAX_GRID_STRING_LENGTH = 1024;
const MAX_DESCRIPTOR_LENGTH = 256;
const MAX_ATTRIBUTE_SELECTOR_LENGTH = 256;
/** rrweb's marker between a <style>'s text nodes; kept so the replay can split the text again. */
const RR_SPLIT = '/* rr_split */';

// ── characters and escapes ─────────────────────────────────────────────────

function isIdentCode(code: number): boolean {
  return (
    (code >= 97 && code <= 122) || // a-z
    (code >= 65 && code <= 90) || // A-Z
    (code >= 48 && code <= 57) || // 0-9
    code === 45 || // -
    code === 95 || // _
    code >= 0x80
  );
}

function isHexCode(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 102) || (code >= 65 && code <= 70);
}

function isSpace(c: string | undefined): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
}

/** s[i] === '\\' starts a valid escape (CSS Syntax §4.3.8). */
function isValidEscape(s: string, i: number): boolean {
  return s[i] === '\\' && i + 1 < s.length && s[i + 1] !== '\n';
}

/** s[i] === '\\' → [end, decoded char]. */
function consumeEscape(s: string, i: number): [number, string] {
  let j = i + 1;
  if (j >= s.length) return [j, '�'];
  if (!isHexCode(s.charCodeAt(j))) return [j + 1, s[j]!];
  const start = j;
  while (j < s.length && j - start < 6 && isHexCode(s.charCodeAt(j))) j++;
  const code = parseInt(s.slice(start, j), 16);
  if (s[j] === '\r' && s[j + 1] === '\n') j += 2;
  else if (isSpace(s[j])) j++;
  const valid = code !== 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
  return [j, valid ? String.fromCodePoint(code) : '�'];
}

/** Decode escapes; inside a string, backslash-newline is a line continuation. */
function unescape(s: string, inString: boolean): string {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  let run = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] !== '\\') {
      i++;
      continue;
    }
    out += s.slice(run, i);
    if (inString && s[i + 1] === '\n') {
      i += 2;
    } else {
      const [end, ch] = consumeEscape(s, i);
      out += ch;
      i = end;
    }
    run = i;
  }
  return out + s.slice(run);
}

/** An identifier (escapes included) from s[i] → [end, decoded name]. */
function consumeIdent(s: string, i: number): [number, string] {
  let j = i;
  while (j < s.length) {
    if (isIdentCode(s.charCodeAt(j))) j++;
    else if (isValidEscape(s, j)) j = consumeEscape(s, j)[0];
    else break;
  }
  return [j, unescape(s.slice(i, j), false)];
}

function startsIdent(s: string, i: number): boolean {
  return isIdentCode(s.charCodeAt(i)) || isValidEscape(s, i);
}

// ── scanning primitives ────────────────────────────────────────────────────

/** s[i] is a quote → [end, closed]; an unclosed (bad) string ends at a newline or the input's end. */
function scanString(s: string, i: number): [number, boolean] {
  const quote = s[i];
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === quote) return [j + 1, true];
    if (c === '\n') return [j, false];
    j++;
  }
  return [s.length, false];
}

function skipString(s: string, i: number): number {
  return scanString(s, i)[0];
}

/** Does `s` (already top-level-scanned text) hold only closed strings? */
function stringsClosed(s: string): boolean {
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const [end, closed] = scanString(s, i);
      if (!closed) return false;
      i = end;
      continue;
    }
    i++;
  }
  return true;
}

function skipComment(s: string, i: number): number {
  const end = s.indexOf('*/', i + 2);
  return end === -1 ? s.length : end + 2;
}

/** First `stops` char at paren/bracket depth 0, skipping strings, comments and escapes. */
function findTopLevel(s: string, from: number, stops: string): number {
  let depth = 0;
  let i = from;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipString(s, i);
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      i = skipComment(s, i);
      continue;
    }
    if (depth === 0 && stops.indexOf(c) !== -1) return i;
    if (c === '(' || c === '[') depth++;
    else if ((c === ')' || c === ']') && depth > 0) depth--;
    i++;
  }
  return s.length;
}

/** s[open] === '{' → index of the matching '}' (or s.length). */
function matchBrace(s: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipString(s, i);
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      i = skipComment(s, i);
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return s.length;
}

/** Drop comments, keeping rrweb's `/* rr_split *\/` markers. */
function stripComments(s: string): string {
  let out = '';
  let last = 0;
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipString(s, i);
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      const end = skipComment(s, i);
      const comment = s.slice(i, end);
      out += s.slice(last, i) + (comment === RR_SPLIT ? comment : '');
      i = end;
      last = end;
      continue;
    }
    i++;
  }
  return out + s.slice(last);
}

/** The decoded value of a CSS string literal (quotes included in `literal`). */
function cssStringValue(literal: string): string {
  const quote = literal[0]!;
  const body = literal.length > 1 && literal.endsWith(quote) ? literal.slice(1, -1) : literal.slice(1);
  return unescape(body, true);
}

/** Quote-safe and control-free: `\\`, `"` and every C0/DEL char become escapes. */
function escapeCssString(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\\"\x00-\x1f\x7f]/g, (c) =>
    c === '\\' || c === '"' ? `\\${c}` : `\\${c.charCodeAt(0).toString(16)} `,
  );
}

/** The target inside `url( … )` — quoted or not — decoded. */
function urlTokenValue(args: string): string {
  const t = args.trim();
  if (t[0] === '"' || t[0] === "'") return cssStringValue(t.slice(0, skipString(t, 0)));
  return unescape(t, false);
}

function sanitizeCssUrl(raw: string, ctx: CssScrubContext): string | null {
  const id = fragmentId(raw) ?? documentFragmentId(raw, ctx.baseHref);
  if (id !== null) return ctx.retainedIds.has(id) ? `#${id}` : null;
  if (raw.trim().startsWith('#')) return null;
  if (isDataUrl(raw)) return ctx.masked ? null : raw.trim();
  const clean = sanitizeHttpUrl(raw, ctx.baseHref);
  return clean === null ? null : redactUrlPath(clean, pageRedactionConfig(ctx.redaction));
}

// ── exception checks ──────────────────────────────────────────────────────

const GRID_CELL_RE = /^(?:\.+|-?[_a-zA-Z\u0080-\uFFFF][-_a-zA-Z0-9\u0080-\uFFFF]*|--[-_a-zA-Z0-9\u0080-\uFFFF]*)$/;

function validGridAreaString(literal: string): boolean {
  if (literal.length > MAX_GRID_STRING_LENGTH) return false;
  const value = cssStringValue(literal).trim();
  return value !== '' && value.split(/\s+/).every((cell) => GRID_CELL_RE.test(cell));
}

/**
 * The inside of `[ … ]`. A bare attribute (`[disabled]`) is kept; a valued one
 * — quoted OR unquoted, the two are the same selector — survives only as
 * `=` with an enumerated ARIA state value.
 */
function allowedAttributeSelector(inner: string): boolean {
  if (inner.length > MAX_ATTRIBUTE_SELECTOR_LENGTH) return false;
  let i = 0;
  while (isSpace(inner[i])) i++;
  const nameStart = i;
  while (i < inner.length && (startsIdent(inner, i) || inner[i] === '|' || inner[i] === '*')) {
    i = startsIdent(inner, i) ? consumeIdent(inner, i)[0] : i + 1;
  }
  const name = unescape(inner.slice(nameStart, i), false).toLowerCase();
  while (isSpace(inner[i])) i++;
  if (i >= inner.length) return name !== '';
  if (inner[i] !== '=') return false; // ~= |= ^= $= *= never carry an enumerated state
  i++;
  while (isSpace(inner[i])) i++;
  let value: string;
  if (inner[i] === '"' || inner[i] === "'") {
    const end = skipString(inner, i);
    value = cssStringValue(inner.slice(i, end));
    i = end;
  } else if (startsIdent(inner, i)) {
    const [end, decoded] = consumeIdent(inner, i);
    value = decoded;
    i = end;
  } else {
    return false;
  }
  while (isSpace(inner[i])) i++;
  if (i < inner.length && /^[iIsS]$/.test(inner[i]!)) {
    i++;
    while (isSpace(inner[i])) i++;
  }
  if (i < inner.length) return false;
  // Own keys only: `[constructor=x]` must not reach Object.prototype.
  return isAriaStateValue(name, value);
}

/** A selector (or a prelude's selector-bearing text); null → drop the rule. */
function scrubSelector(selector: string, ctx: CssScrubContext): string | null {
  let i = 0;
  while (i < selector.length) {
    const c = selector[i]!;
    if (c === '\\') {
      if (!isValidEscape(selector, i)) return null; // would escape the `{` we emit next
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      // Masked: no strings. Open: an unclosed one would swallow the output after it.
      const [end, closed] = scanString(selector, i);
      if (ctx.masked || !closed) return null;
      i = end;
      continue;
    }
    if (c === '[' && ctx.masked) {
      const close = findTopLevel(selector, i + 1, ']');
      if (close >= selector.length || !allowedAttributeSelector(selector.slice(i + 1, close))) return null;
      i = close + 1;
      continue;
    }
    i++;
  }
  return selector;
}

// ── values ────────────────────────────────────────────────────────────────

const RESOLUTION_RE = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?(?:x|dppx|dpi|dpcm)$/i;

function scrubImageSet(args: string, ctx: CssScrubContext): string | null {
  const out: string[] = [];
  let i = 0;
  while (i < args.length) {
    const end = findTopLevel(args, i, ',');
    const candidate = args.slice(i, end).trim();
    i = end + 1;
    if (candidate === '') continue;
    let target: string | null = null;
    let rest = '';
    if (startsIdent(candidate, 0)) {
      const [nameEnd, name] = consumeIdent(candidate, 0);
      if (candidate[nameEnd] === '(' && name.toLowerCase() === 'url') {
        const close = findTopLevel(candidate, nameEnd + 1, ')');
        target = urlTokenValue(candidate.slice(nameEnd + 1, close));
        rest = candidate.slice(close + 1);
      }
    } else if (candidate[0] === '"' || candidate[0] === "'") {
      const e = skipString(candidate, 0);
      target = cssStringValue(candidate.slice(0, e));
      rest = candidate.slice(e);
    }
    if (target === null || rest.length > MAX_DESCRIPTOR_LENGTH) continue;
    const clean = sanitizeCssUrl(target, ctx);
    if (clean === null) continue;
    const descriptor = rest.replace(/type\([^)]*\)/gi, '').trim();
    if (descriptor !== '' && !RESOLUTION_RE.test(descriptor)) continue;
    out.push(`url("${escapeCssString(clean)}")${descriptor === '' ? '' : ` ${descriptor}`}`);
  }
  return out.length > 0 ? out.join(', ') : null;
}

/** A declaration value (or an at-rule prelude), or null when the whole thing must go. */
function scrubValue(prop: string, value: string, ctx: CssScrubContext, block: DeclarationBlock | null): string | null {
  const fontNames = prop === 'font-family' || prop === 'font';
  const gridAreas = prop === 'grid-template-areas' || prop === 'grid-template' || prop === 'grid';
  const fontSrc = block === 'font-face' && prop === 'src';
  let out = '';
  let run = 0; // start of the not-yet-copied raw text
  let i = 0;
  while (i < value.length) {
    const c = value[i]!;
    if (c === '"' || c === "'") {
      // An unclosed string is invalid CSS, and re-emitted it would swallow (and
      // re-tokenize) whatever the scrubber writes after it — drop it in every mode.
      const [end, closed] = scanString(value, i);
      if (!closed) return null;
      if (ctx.masked && !fontNames && !(gridAreas && validGridAreaString(value.slice(i, end)))) return null;
      i = end;
      continue;
    }
    if (c === '\\' && !isValidEscape(value, i)) return null; // would escape the `;`/`}` emitted next
    if (!startsIdent(value, i)) {
      i++;
      continue;
    }
    const [j, name] = consumeIdent(value, i);
    if (value[j] !== '(') {
      i = j;
      continue;
    }
    const lower = name.toLowerCase();
    if (lower === 'url' || lower === 'src') {
      const close = findTopLevel(value, j + 1, ')');
      const clean = sanitizeCssUrl(urlTokenValue(value.slice(j + 1, close)), ctx);
      if (clean === null) return null;
      out += `${value.slice(run, i)}url("${escapeCssString(clean)}")`;
      i = run = close + 1;
      continue;
    }
    if (lower === 'image-set' || lower === '-webkit-image-set') {
      const close = findTopLevel(value, j + 1, ')');
      const set = scrubImageSet(value.slice(j + 1, close), ctx);
      if (set === null) return null;
      out += `${value.slice(run, i)}${lower}(${set})`;
      i = run = close + 1;
      continue;
    }
    if (fontSrc && (lower === 'format' || lower === 'tech')) {
      out = (out + value.slice(run, i)).trimEnd();
      i = run = findTopLevel(value, j + 1, ')') + 1;
      continue;
    }
    if (fontSrc && lower === 'local') {
      const close = findTopLevel(value, j + 1, ')'); // the font name, kept verbatim
      if (close >= value.length || !stringsClosed(value.slice(j + 1, close))) return null;
      i = close + 1;
      continue;
    }
    if (ctx.masked && lower === 'attr') return null; // pulls page text into `content`
    i = j + 1; // any other function: keep scanning its arguments
  }
  return out + value.slice(run);
}

// ── declaration validity (masked pages) ───────────────────────────────────

type DeclarationBlock = 'style' | 'font-face' | 'page' | 'counter-style';

/** Descriptors of @font-face / @page, which `CSS.supports()` does not know. */
const FONT_FACE_DESCRIPTORS = new Set(
  (
    'font-family src font-style font-weight font-stretch font-display unicode-range font-feature-settings ' +
    'font-variation-settings font-named-instance ascent-override descent-override line-gap-override size-adjust'
  ).split(' '),
);
const PAGE_DESCRIPTORS = new Set(['size', 'page-orientation', 'marks', 'bleed']);

/**
 * Fallback when `CSS.supports` is missing: standard property names (vendor
 * prefixes stripped before the lookup). Names only — a stricter engine check
 * is always preferred.
 */
const KNOWN_PROPERTIES = new Set(
  (
    'accent-color align-content align-items align-self all animation animation-composition animation-delay ' +
    'animation-direction animation-duration animation-fill-mode animation-iteration-count animation-name ' +
    'animation-play-state animation-timing-function appearance aspect-ratio backdrop-filter backface-visibility ' +
    'background background-attachment background-blend-mode background-clip background-color background-image ' +
    'background-origin background-position background-position-x background-position-y background-repeat ' +
    'background-size block-size border border-block border-block-color border-block-end border-block-end-color ' +
    'border-block-end-style border-block-end-width border-block-start border-block-start-color ' +
    'border-block-start-style border-block-start-width border-block-style border-block-width border-bottom ' +
    'border-bottom-color border-bottom-left-radius border-bottom-right-radius border-bottom-style ' +
    'border-bottom-width border-collapse border-color border-end-end-radius border-end-start-radius border-image ' +
    'border-image-outset border-image-repeat border-image-slice border-image-source border-image-width ' +
    'border-inline border-inline-color border-inline-end border-inline-end-color border-inline-end-style ' +
    'border-inline-end-width border-inline-start border-inline-start-color border-inline-start-style ' +
    'border-inline-start-width border-inline-style border-inline-width border-left border-left-color ' +
    'border-left-style border-left-width border-radius border-right border-right-color border-right-style ' +
    'border-right-width border-spacing border-start-end-radius border-start-start-radius border-style border-top ' +
    'border-top-color border-top-left-radius border-top-right-radius border-top-style border-top-width ' +
    'border-width bottom box-decoration-break box-shadow box-sizing break-after break-before break-inside ' +
    'caption-side caret-color clear clip clip-path clip-rule color color-interpolation color-interpolation-filters ' +
    'color-scheme column-count column-fill column-gap column-rule column-rule-color column-rule-style ' +
    'column-rule-width column-span column-width columns contain contain-intrinsic-size container ' +
    'container-name container-type content content-visibility counter-increment counter-reset counter-set ' +
    'cursor cx cy d direction display dominant-baseline empty-cells fill fill-opacity fill-rule filter flex ' +
    'flex-basis flex-direction flex-flow flex-grow flex-shrink flex-wrap float flood-color flood-opacity font ' +
    'font-family font-feature-settings font-kerning font-optical-sizing font-size font-size-adjust font-stretch ' +
    'font-style font-synthesis font-variant font-variant-caps font-variant-east-asian font-variant-ligatures ' +
    'font-variant-numeric font-variation-settings font-weight gap grid grid-area grid-auto-columns ' +
    'grid-auto-flow grid-auto-rows grid-column grid-column-end grid-column-gap grid-column-start grid-gap ' +
    'grid-row grid-row-end grid-row-gap grid-row-start grid-template grid-template-areas grid-template-columns ' +
    'grid-template-rows height hyphens image-orientation image-rendering inline-size inset inset-block ' +
    'inset-block-end inset-block-start inset-inline inset-inline-end inset-inline-start isolation ' +
    'justify-content justify-items justify-self left letter-spacing lighting-color line-break line-clamp ' +
    'line-height list-style list-style-image list-style-position list-style-type margin margin-block ' +
    'margin-block-end margin-block-start margin-bottom margin-inline margin-inline-end margin-inline-start ' +
    'margin-left margin-right margin-top marker marker-end marker-mid marker-start mask mask-clip mask-composite ' +
    'mask-image mask-mode mask-origin mask-position mask-repeat mask-size mask-type max-block-size max-height ' +
    'max-inline-size max-width min-block-size min-height min-inline-size min-width mix-blend-mode object-fit ' +
    'object-position offset offset-distance offset-path offset-rotate opacity order orphans outline ' +
    'outline-color outline-offset outline-style outline-width overflow overflow-anchor overflow-wrap ' +
    'overflow-x overflow-y overscroll-behavior overscroll-behavior-x overscroll-behavior-y padding ' +
    'padding-block padding-block-end padding-block-start padding-bottom padding-inline padding-inline-end ' +
    'padding-inline-start padding-left padding-right padding-top page-break-after page-break-before ' +
    'page-break-inside paint-order perspective perspective-origin place-content place-items place-self ' +
    'pointer-events position quotes r resize right rotate row-gap rx ry scale scroll-behavior scroll-margin ' +
    'scroll-padding scroll-snap-align scroll-snap-stop scroll-snap-type shape-image-threshold shape-margin ' +
    'shape-outside shape-rendering stop-color stop-opacity stroke stroke-dasharray stroke-dashoffset ' +
    'stroke-linecap stroke-linejoin stroke-miterlimit stroke-opacity stroke-width tab-size table-layout ' +
    'text-align text-align-last text-anchor text-combine-upright text-decoration text-decoration-color ' +
    'text-decoration-line text-decoration-skip-ink text-decoration-style text-decoration-thickness ' +
    'text-emphasis text-emphasis-color text-emphasis-position text-emphasis-style text-indent text-justify ' +
    'text-orientation text-overflow text-rendering text-shadow text-size-adjust text-transform ' +
    'text-underline-offset text-underline-position text-wrap top touch-action transform transform-box ' +
    'transform-origin transform-style transition transition-behavior transition-delay transition-duration ' +
    'transition-property transition-timing-function translate unicode-bidi user-select vector-effect ' +
    'vertical-align visibility white-space widows width will-change word-break word-spacing word-wrap ' +
    'writing-mode x y z-index zoom box-align box-flex box-orient box-pack font-smoothing tap-highlight-color ' +
    'text-fill-color text-stroke text-stroke-color text-stroke-width osx-font-smoothing'
  ).split(' '),
);

const VENDOR_PREFIX_RE = /^-(?:webkit|moz|ms|o)-/;

type SupportsFn = (property: string, value: string) => boolean;

function engineSupports(): SupportsFn | null {
  const css = (globalThis as { CSS?: { supports?: unknown } }).CSS;
  return css !== undefined && typeof css.supports === 'function' ? (css.supports as SupportsFn).bind(css) : null;
}

/** Would the browser accept `prop: value` here? (Masked pages keep only these.) */
function isValidDeclaration(block: DeclarationBlock, prop: string, value: string): boolean {
  if (block === 'font-face') return FONT_FACE_DESCRIPTORS.has(prop);
  if (block === 'page' && PAGE_DESCRIPTORS.has(prop)) return true;
  const supports = engineSupports();
  if (supports !== null) {
    try {
      return supports(prop, value);
    } catch {
      // fall through to the name allowlist
    }
  }
  return KNOWN_PROPERTIES.has(prop.replace(VENDOR_PREFIX_RE, ''));
}

/** `value !important` → [value, true]; a hand scan, not a regex over page text. */
function splitImportant(value: string): [string, boolean] {
  const t = value.trimEnd();
  if (t.length < 10 || t.slice(-9).toLowerCase() !== 'important') return [t, false];
  let k = t.length - 9;
  while (k > 0 && isSpace(t[k - 1])) k--;
  return t[k - 1] === '!' ? [t.slice(0, k - 1).trim(), true] : [t, false];
}

const PROPERTY_RE = /^-?[a-z_][-a-z0-9_]*$/;

function scrubDeclarations(body: string, ctx: CssScrubContext, block: DeclarationBlock): string {
  const out: string[] = [];
  let i = 0;
  while (i < body.length) {
    const end = findTopLevel(body, i, ';{');
    if (body[end] === '{') {
      i = matchBrace(body, end) + 1; // CSS nesting — dropped
      continue;
    }
    const declaration = body.slice(i, end);
    i = end + 1;
    const colon = findTopLevel(declaration, 0, ':');
    if (colon >= declaration.length) continue;
    const rawProp = declaration.slice(0, colon).trim();
    if (rawProp.length > MAX_PROPERTY_LENGTH) continue;
    const custom = rawProp.startsWith('--');
    if (custom && ctx.masked) continue;
    const prop = custom ? rawProp : rawProp.toLowerCase();
    if (!custom && !PROPERTY_RE.test(prop)) continue;
    const [value, important] = splitImportant(declaration.slice(colon + 1).trim());
    const clean = scrubValue(prop, value, ctx, block)?.trim() ?? '';
    if (clean === '') continue;
    // Masked: an unknown or invalid declaration renders nothing but would carry
    // its text verbatim (`patient: Alice Smith`), so only valid ones survive.
    if (ctx.masked && !isValidDeclaration(block, prop, clean)) continue;
    out.push(`${prop}:${clean}${important ? ' !important' : ''}`);
  }
  return out.join(';');
}

// ── rule lists ────────────────────────────────────────────────────────────

function atName(prelude: string): string {
  return startsIdent(prelude, 1) ? consumeIdent(prelude, 1)[1].toLowerCase() : '';
}

/** An at-rule prelude: URLs sanitized, and on a masked page no strings or valued attribute selectors. */
function scrubPrelude(prelude: string, ctx: CssScrubContext): string | null {
  const value = scrubValue('', prelude, ctx, null);
  return value === null ? null : scrubSelector(value, ctx);
}

const RULE_LIST_AT_RULES = new Set([
  'media', 'supports', 'layer', 'container', 'scope', 'starting-style', 'keyframes', '-webkit-keyframes',
]);

function scrubAtStatement(prelude: string, ctx: CssScrubContext): string {
  const name = atName(prelude);
  if (name === 'import') {
    const rest = prelude.slice(consumeIdent(prelude, 1)[0]).trim();
    let target: string | null = null;
    let tail = '';
    if (rest[0] === '"' || rest[0] === "'") {
      const end = skipString(rest, 0);
      target = cssStringValue(rest.slice(0, end));
      tail = rest.slice(end);
    } else if (startsIdent(rest, 0)) {
      const [nameEnd, fn] = consumeIdent(rest, 0);
      if (rest[nameEnd] === '(' && fn.toLowerCase() === 'url') {
        const close = findTopLevel(rest, nameEnd + 1, ')');
        target = urlTokenValue(rest.slice(nameEnd + 1, close));
        tail = rest.slice(close + 1);
      }
    }
    if (target === null) return '';
    const clean = sanitizeCssUrl(target, ctx);
    const cleanTail = scrubPrelude(tail, ctx);
    if (clean === null || cleanTail === null) return '';
    return `@import url("${escapeCssString(clean)}")${cleanTail.trimEnd()};`;
  }
  if (name === 'layer' || (name === 'namespace' && !ctx.masked)) {
    const clean = scrubPrelude(prelude, ctx);
    return clean === null ? '' : `${clean};`;
  }
  return ''; // @charset, masked @namespace and anything unknown
}

function scrubAtBlock(prelude: string, body: string, ctx: CssScrubContext, depth: number): string {
  const name = atName(prelude);
  if (name === 'font-face') {
    const declarations = scrubDeclarations(body, ctx, 'font-face');
    return declarations === '' ? '' : `@font-face{${declarations}}`;
  }
  // @document / @-moz-document preludes are URL matchers; masked @counter-style carries text.
  if (name === 'counter-style' && ctx.masked) return '';
  const cleanPrelude = scrubPrelude(prelude, ctx);
  if (cleanPrelude === null) return '';
  if (name === 'page' || name === 'counter-style') return `${cleanPrelude}{${scrubDeclarations(body, ctx, name)}}`;
  if (RULE_LIST_AT_RULES.has(name)) return `${cleanPrelude}{${scrubRuleList(body, ctx, depth + 1)}}`;
  return ''; // @document, @property, @font-feature-values, @font-palette-values, unknown
}

function scrubRuleList(s: string, ctx: CssScrubContext, depth: number): string {
  if (depth > MAX_RULE_DEPTH) return '';
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (isSpace(c) || c === '}' || c === ';') {
      i++;
      continue;
    }
    if (c === '/' && s.startsWith(RR_SPLIT, i)) {
      out += RR_SPLIT; // kept even when the rule after it is dropped
      i += RR_SPLIT.length;
      continue;
    }
    const stop = findTopLevel(s, i, '{;');
    if (stop >= s.length) break;
    const prelude = s.slice(i, stop).trim();
    if (s[stop] === ';') {
      if (prelude.startsWith('@')) out += scrubAtStatement(prelude, ctx);
      i = stop + 1;
      continue;
    }
    const close = matchBrace(s, stop);
    const body = s.slice(stop + 1, close);
    i = close + 1;
    if (prelude.startsWith('@')) {
      out += scrubAtBlock(prelude, body, ctx, depth);
      continue;
    }
    const selector = scrubSelector(prelude, ctx);
    if (selector === null) continue;
    const declarations = scrubDeclarations(body, ctx, 'style');
    if (declarations !== '') out += `${selector}{${declarations}}`;
  }
  return out;
}

/**
 * CSS Syntax §3.3 input preprocessing, which the browser applies before it
 * tokenizes: CR, CRLF and FF are newlines (they end a string), NUL is U+FFFD.
 * Scanning the raw text instead would disagree with the browser about where
 * a string ends.
 */
function preprocess(css: string): string {
  // eslint-disable-next-line no-control-regex
  return css.replace(/\r\n?|\f/g, '\n').replace(/\x00/g, '\uFFFD');
}

/** Stylesheet text (`_cssText`, `<style>` text). */
export function scrubCssText(css: string, ctx: CssScrubContext): string {
  return scrubRuleList(stripComments(preprocess(css)), ctx, 0);
}

/** A `style` attribute. */
export function scrubInlineStyle(css: string, ctx: CssScrubContext): string {
  return scrubDeclarations(stripComments(preprocess(css)), ctx, 'style');
}
