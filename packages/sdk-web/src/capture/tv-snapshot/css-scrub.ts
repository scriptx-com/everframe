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
import { ARIA_STATE_VALUES } from './allowlists.js';
import { fragmentId, isDataUrl, sanitizeHttpUrl } from './url-sanitize.js';

export interface CssScrubContext {
  masked: boolean;
  retainedIds: ReadonlySet<string>;
  baseHref: string;
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

function skipString(s: string, i: number): number {
  const quote = s[i];
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === quote) return j + 1;
    if (c === '\n') return j; // an unterminated (bad) string ends at the newline
    j++;
  }
  return s.length;
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

function escapeCssString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ');
}

/** The target inside `url( … )` — quoted or not — decoded. */
function urlTokenValue(args: string): string {
  const t = args.trim();
  if (t[0] === '"' || t[0] === "'") return cssStringValue(t.slice(0, skipString(t, 0)));
  return unescape(t, false);
}

function sanitizeCssUrl(raw: string, ctx: CssScrubContext): string | null {
  const id = fragmentId(raw);
  if (id !== null) return ctx.retainedIds.has(id) ? `#${id}` : null;
  if (raw.trim().startsWith('#')) return null;
  if (isDataUrl(raw)) return ctx.masked ? null : raw.trim();
  return sanitizeHttpUrl(raw, ctx.baseHref);
}

// ── exception checks ──────────────────────────────────────────────────────

const GRID_CELL_RE = /^(?:\.+|-?[_a-zA-Z\u0080-￿][-_a-zA-Z0-9\u0080-￿]*|--[-_a-zA-Z0-9\u0080-￿]*)$/;

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
  const allowed = ARIA_STATE_VALUES[name];
  return allowed !== undefined && allowed.has(value);
}

/** A selector (or a prelude's selector-bearing text); null → drop the rule. */
function scrubSelector(selector: string, ctx: CssScrubContext): string | null {
  if (!ctx.masked) return selector;
  let i = 0;
  while (i < selector.length) {
    const c = selector[i]!;
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") return null;
    if (c === '[') {
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
function scrubValue(prop: string, value: string, ctx: CssScrubContext, fontFace: boolean): string | null {
  const fontNames = prop === 'font-family' || prop === 'font';
  const gridAreas = prop === 'grid-template-areas' || prop === 'grid-template' || prop === 'grid';
  const fontSrc = fontFace && prop === 'src';
  let out = '';
  let run = 0; // start of the not-yet-copied raw text
  let i = 0;
  while (i < value.length) {
    const c = value[i]!;
    if (c === '"' || c === "'") {
      const end = skipString(value, i);
      const literal = value.slice(i, end);
      if (ctx.masked && !fontNames && !(gridAreas && validGridAreaString(literal))) return null;
      i = end;
      continue;
    }
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
      i = findTopLevel(value, j + 1, ')') + 1; // the font name, kept verbatim
      continue;
    }
    if (ctx.masked && lower === 'attr') return null; // pulls page text into `content`
    i = j + 1; // any other function: keep scanning its arguments
  }
  return out + value.slice(run);
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

function scrubDeclarations(body: string, ctx: CssScrubContext, fontFace: boolean): string {
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
    const clean = scrubValue(prop, value, ctx, fontFace);
    if (clean === null || clean.trim() === '') continue;
    out.push(`${prop}:${clean.trim()}${important ? ' !important' : ''}`);
  }
  return out.join(';');
}

// ── rule lists ────────────────────────────────────────────────────────────

function atName(prelude: string): string {
  return startsIdent(prelude, 1) ? consumeIdent(prelude, 1)[1].toLowerCase() : '';
}

/** An at-rule prelude: URLs sanitized, and on a masked page no strings or valued attribute selectors. */
function scrubPrelude(prelude: string, ctx: CssScrubContext): string | null {
  const value = scrubValue('', prelude, ctx, false);
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
    const declarations = scrubDeclarations(body, ctx, true);
    return declarations === '' ? '' : `@font-face{${declarations}}`;
  }
  // @document / @-moz-document preludes are URL matchers; masked @counter-style carries text.
  if (name === 'counter-style' && ctx.masked) return '';
  const cleanPrelude = scrubPrelude(prelude, ctx);
  if (cleanPrelude === null) return '';
  if (name === 'page' || name === 'counter-style') return `${cleanPrelude}{${scrubDeclarations(body, ctx, false)}}`;
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
    const declarations = scrubDeclarations(body, ctx, false);
    if (declarations !== '') out += `${selector}{${declarations}}`;
  }
  return out;
}

/** Stylesheet text (`_cssText`, `<style>` text). */
export function scrubCssText(css: string, ctx: CssScrubContext): string {
  return scrubRuleList(stripComments(css), ctx, 0);
}

/** A `style` attribute. */
export function scrubInlineStyle(css: string, ctx: CssScrubContext): string {
  return scrubDeclarations(stripComments(css), ctx, false);
}
