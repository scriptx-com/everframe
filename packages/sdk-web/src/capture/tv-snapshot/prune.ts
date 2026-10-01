// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Viewport pruning (spec §Privacy and masking): a TV report must not carry
// content the user never saw — RN-web keeps previous screens mounted, rails
// clip their off-screen items, overlays sit hidden — yet the
// recorded scroll offset must land on the same content, so LAYOUT GEOMETRY is
// preserved. Pruned nodes stay in their parent's child list (so :nth-child
// does not shift) as childless placeholders: in-flow → same box, margins
// (including the child margins that collapsed through it), display, position
// and grid/flex placement, hidden; out-of-flow or display:none → display:none.
// All placeholder declarations are !important so author resets cannot resize
// them. Off-screen SVG definitions (clipPath, gradients, symbols…) that other
// content may reference by id survive as zero-size carriers under the topmost
// pruned ancestor; every other part of that SVG is dropped.
//
// SVG is allowlisted: desc/title/metadata text is dropped, a resource leaf
// (<image>, <use>) the user cannot see loses its URL, and a definition
// (symbol, clipPath, gradient… or any child of <defs>) survives only when
// something kept references it by id — then without bare text that never
// renders.
//
// Slotted light-DOM content is judged in its composed-tree context: its
// assigned slot's ancestors (re-projection and hosts followed) can mask, hide
// or clip it, though rrweb serializes it under the host.
//
// Also here, because this is the one pass that sees the LIVE element behind
// each serialized node: SDK chrome removal, blocked-sensitive black boxes, and
// bare text of sensitive display:contents wrappers.
//
// Runs on slow TV silicon over page-sized trees: one iterative post-order walk
// (no recursion — deep pages must not overflow the stack), at most one rect
// and one computed-style read per judged element (plus a bounded
// margin-collapse probe per block placeholder, and one line-fragment read per
// unseen inline element and per bare text node of an element whose own box
// is unseen), and no layout
// reads at all inside head or SVG definitions and leaves (one style read per
// other SVG content element, plus one rect per SVG <text>). LAZY (tv-snapshot chunk).
//
// Unseen inline content keeps its layout but not its content: an inline
// element that no line box of is seen keeps one empty inline-block per
// measured line fragment in place of its children, and so does each bare text
// node of an unseen box (display:contents included) that is kept for a
// visible descendant. Text inside a SEEN box is assumed seen.
//
// "Seen" means: the element's own box — narrowed by its CSS clip / clip-path
// region (sr-only / visually-hidden patterns clip to nothing) — intersects the
// viewport INTERSECTED with
// every clip of an ancestor whose overflow is not visible (hidden, clip, auto,
// scroll — for a scroll container its padding box, so a rail item scrolled out
// of the rail is unseen), AND the element is not `visibility:hidden|collapse`
// nor `opacity:0` (itself or any ancestor — opacity does not inherit, so it is
// propagated). Clips follow the containing-block chain: an absolutely
// positioned box escapes the clips of ancestors below its containing block
// (the nearest positioned OR transform/perspective/filter/backdrop-filter/
// contain/will-change/container-type box), a fixed box those below its
// containing block (the nearest such non-position box, else the viewport).
// Bare text directly inside
// an invisible element is masked even when a `visibility:visible` descendant
// keeps the element itself. Occlusion by other layers is NOT modelled.
//
// A closed <select> (a dropdown, not a listbox) shows only its selected
// option, and that option is an input VALUE (masked like every input value):
// it stays selected with its text replaced by the mask placeholder; every
// other option's text is blanked. None of it is judged by layout (Chromium
// reports zero boxes for it), and the select keeps its measured size so the
// blanked options cannot narrow it.
// The one computed-style read per judged element feeds all of this.
import { MASK_PLACEHOLDER } from '../replay/mask-mapping.js';
import { SN_DOCUMENT, SN_ELEMENT, SN_TEXT, type SnAttributeValue, type SnElement, type SnNode, type SnParent } from './sn-types.js';

export interface PruneRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface PruneDeps {
  nodeFor(id: number): Node | null;
  rectOf(el: Element): PruneRect;
  styleOf(el: Element): CSSStyleDeclaration | null;
  sizeOf(el: Element, rect: PruneRect): { width: number; height: number };
  isSensitive(el: Element): boolean;
  viewport: { width: number; height: number };
  /** Per-line border boxes of an inline element (getClientRects). */
  fragmentsOf?(el: Element): PruneRect[];
  /** Per-line boxes of a text node (a Range's getClientRects). */
  textRectsOf?(text: Node): PruneRect[];
}

export interface PruneResult {
  masked: boolean;
  /**
   * Any page content was withheld: pruned, blanked, masked or stripped. The
   * caller must then scrub CSS as for a masked page — a pruned screen's text
   * can live on in its stylesheet (`content:`, custom properties).
   */
  changed: boolean;
  hiddenIds: Set<number>;
  pruned: number;
}

/**
 * THE one way the pruner removes or blanks page content (codex r4 F2): it
 * applies the change AND records it as withheld (`PruneResult.changed`, which
 * switches the CSS scrub to its masked policy), so no branch can withhold
 * content without the stylesheet policy following. Children dropped, text
 * changed, or any attribute other than `style` dropped or changed counts;
 * pure additions do not. (The walk's own removal of script/noscript/base and
 * SDK chrome — never page content — is the one direct child-list write.)
 */
interface Withheld {
  childNodes?: SnNode[];
  attributes?: Record<string, SnAttributeValue>;
  textContent?: string;
}
type Withhold = (node: SnNode, change: Withheld) => void;

function makeWithhold(result: PruneResult): Withhold {
  return (node, change) => {
    if (change.childNodes !== undefined && (node.type === SN_ELEMENT || node.type === SN_DOCUMENT)) {
      const next = new Set(change.childNodes);
      for (const old of node.childNodes) {
        if (!next.has(old)) {
          result.changed = true;
          break;
        }
      }
      node.childNodes = change.childNodes;
    }
    if (change.attributes !== undefined && node.type === SN_ELEMENT) {
      for (const key of Object.keys(node.attributes)) {
        if (key === 'style') continue;
        if (!hasOwn(change.attributes, key) || change.attributes[key] !== node.attributes[key]) {
          result.changed = true;
          break;
        }
      }
      node.attributes = change.attributes;
    }
    if (change.textContent !== undefined && node.type === SN_TEXT) {
      if (change.textContent !== node.textContent) result.changed = true;
      node.textContent = change.textContent;
    }
  };
}

/**
 * - `visible`: seen (itself or a descendant; see header) — ancestors stay.
 * - `hidden`: claims no visibility; an ancestor may still be pruned.
 * - `keep`: an off-screen SVG reduced to its id definitions — retained, but
 *   claims no visibility (one icon must not keep a whole previous screen).
 * - `remove`: dropped from the child list.
 */
type Verdict = 'remove' | 'visible' | 'hidden' | 'keep';

/**
 * How a parent's final verdict is reached once its children are walked:
 * - `root`/`transparent`: no box of its own judged — visible iff a child is
 *   (the document, nested documents, elements with no live node).
 * - `always`: html/body — always visible, never pruned.
 * - `head`: head content — never pruned, never visible.
 * - `svg`: an SVG root — judged by its own rect; content is not judged.
 * - `svgContent`: inside an SVG — no layout reads, no pruning.
 * - `selectContent`: inside a closed <select> — no layout reads, no pruning;
 *   text blanked (the selected option's is the mask placeholder).
 * - `judge`: an element with a live box — pruned when neither it nor any
 *   descendant is seen.
 */
type Mode = 'root' | 'transparent' | 'always' | 'head' | 'svg' | 'svgContent' | 'selectContent' | 'judge';

interface Frame {
  node: SnParent;
  mode: Mode;
  live: Element | null;
  rect: PruneRect | null;
  /** Computed style, read at most once (undefined = not read yet). */
  style: CSSStyleDeclaration | null | undefined;
  /** Mask bare text in this subtree (inside a sensitive display:contents wrapper). */
  maskText: boolean;
  /** Mask this element's OWN bare text children (it is visibility:hidden / opacity:0). Not inherited. */
  hideText: boolean;
  /** Empty this element's OWN bare text children (an unselected option of a closed select). */
  blankText: boolean;
  /** A closed (dropdown) <select>: its children become `selectContent`. */
  closedSelect: boolean;
  /**
   * SVG content not judged: inside a definition (defs, symbol, clipPath…,
   * rendered only by reference) or inside an unseen SVG root (pruned whole).
   */
  svgSkip: boolean;
  /** SVG content that is not rendered (display:none, or a <text> outside the clip): keeps only its definitions. */
  svgHidden: boolean;
  /** This element or an ancestor has opacity:0 — every descendant is invisible. */
  faded: boolean;
  /** The element's own box is seen (see header). Judged/svg frames only. */
  seen: boolean;
  /** The visible region for in-flow/relative/sticky/float descendants. */
  clip: PruneRect;
  /** The visible region for absolutely positioned descendants (containing-block chain). */
  absClip: PruneRect;
  /** The visible region for fixed descendants: the viewport, unless an ancestor is their containing block. */
  fixedClip: PruneRect;
  index: number;
  kept: SnNode[];
  anyVisible: boolean;
  /** Definition-only SVGs in this subtree, in document order, re-homed if an ancestor is pruned. */
  carry: SnElement[] | null;
}

/** What a pruned placeholder contributes to its parent's margin-collapse probe. */
interface PrunedFlow {
  style: CSSStyleDeclaration | null;
  /** Effective (already collapsed) top/bottom margins in px. */
  top: number;
  bottom: number;
}

const ALWAYS_VISIBLE = new Set(['html', 'body']);
const NEVER_PRUNE = new Set(['style', 'link', 'meta', 'title']);
const REMOVE = new Set(['script', 'noscript', 'base']);
const SKIP_ATTR = 'data-everframe-skip-capture';
/** Atomic-box (replaced) elements: pruned even when inline (ruling S20). */
const REPLACED = new Set(['img', 'video', 'canvas', 'picture', 'iframe', 'object', 'embed']);
/** SVG elements that other content references by id (`<use href>`, `url(#…)`). Lower-case. */
const SVG_DEFS = new Set([
  'defs', 'symbol', 'clippath', 'mask', 'lineargradient', 'radialgradient', 'pattern', 'filter', 'marker',
]);
/** SVG elements whose text is never rendered (tooltips, descriptions, metadata). */
const SVG_NON_RENDERED = new Set(['desc', 'title', 'metadata']);
/** Childless SVG elements that load a resource by URL. Lower-case. */
const SVG_RESOURCE_LEAVES = new Set(['image', 'use', 'feimage']);
const SVG_URL_ATTRS = ['href', 'xlink:href', 'src'];
/** SVG elements whose bare text renders. Anywhere else in a definition bare text is dropped. */
const SVG_TEXT_HOSTS = new Set(['text', 'tspan', 'textpath', 'style']);
/** Attributes of a kept off-screen inline element that carry text or URLs and have no layout effect. */
const CONTENT_ATTRS = new Set(['href', 'title', 'alt', 'placeholder']);
const BLOCK_LEVEL = new Set(['block', 'list-item', 'table', 'flex', 'grid', 'flow-root', '-webkit-box']);
const FLEX_OR_GRID = new Set(['flex', 'inline-flex', 'grid', 'inline-grid', '-webkit-box', '-webkit-inline-box']);
/** Margin-collapse probe bounds (S18): levels descended, style reads and nodes examined per side. */
const COLLAPSE_MAX_DEPTH = 8;
const COLLAPSE_MAX_READS = 16;
const COLLAPSE_MAX_STEPS = 64;
/** Composed-tree ancestors examined for one slot (re-projection included). */
const MAX_SLOT_DEPTH = 64;

/** Case-insensitive own attribute presence (`xlink:href` / `XLINK:HREF`). */
function hasOwnAttr(node: SnElement, lowerName: string): boolean {
  for (const key of Object.keys(node.attributes)) if (key.toLowerCase() === lowerName) return true;
  return false;
}

function hasOwn(obj: object, key: string): boolean {
  // Object.hasOwn is missing on old TV Chromium.
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isReplaced(node: SnElement): boolean {
  const tag = node.tagName.toLowerCase();
  if (REPLACED.has(tag)) return true;
  if (tag !== 'input' || !hasOwn(node.attributes, 'type')) return false;
  return String(node.attributes.type).trim().toLowerCase() === 'image';
}

/** Layout size without transforms (offsetWidth/Height) — rect for SVG and non-HTML elements. */
export function defaultSizeOf(el: Element, rect: PruneRect): { width: number; height: number } {
  const html = el as HTMLElement;
  return typeof html.offsetWidth === 'number' && typeof html.offsetHeight === 'number'
    ? { width: html.offsetWidth, height: html.offsetHeight }
    : { width: rect.width, height: rect.height };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** A non-negative length. */
function px(n: number): string {
  return `${Number.isFinite(n) && n > 0 ? round(n) : 0}px`;
}

/** A signed length (margins may be negative). */
function spx(n: number): string {
  return `${Number.isFinite(n) ? round(n) : 0}px`;
}

/** A computed length → number; anything unparsable counts as 0. */
function num(value: string | undefined): number {
  const n = parseFloat(value ?? '');
  return Number.isFinite(n) ? n : 0;
}

/** A numeric length from a serialized (page-reachable) attribute — never its raw text. */
function lengthAttr(value: unknown): string {
  return px(typeof value === 'number' ? value : parseFloat(String(value)));
}

function important(decls: readonly string[]): string {
  return decls.map((d) => `${d}!important`).join(';');
}

const DISPLAY_NONE = important(['display:none']);

function placeholderStyle(
  s: CSSStyleDeclaration,
  size: { width: number; height: number },
  fill: boolean,
  margins: { top: number; bottom: number },
): string {
  if (s.display === 'none') return DISPLAY_NONE;
  const display = s.display === 'inline' || s.display === 'contents' ? 'inline-block' : s.display;
  const parts: string[] = [
    `display:${display}`,
    `position:${s.position || 'static'}`,
    'box-sizing:border-box',
    `width:${px(size.width)}`,
    `height:${px(size.height)}`,
    'min-width:0',
    'min-height:0',
    'max-width:none',
    'max-height:none',
    `margin:${spx(margins.top)} ${spx(num(s.marginRight))} ${spx(margins.bottom)} ${spx(num(s.marginLeft))}`,
    'padding:0',
    'border:0',
    'flex:0 0 auto',
  ];
  const add = (name: string, value: string | undefined): void => {
    if (value !== undefined && value !== '') parts.push(`${name}:${value}`);
  };
  add('align-self', s.alignSelf);
  add('order', s.order);
  if (s.gridRowStart && s.gridRowEnd) parts.push(`grid-row:${s.gridRowStart} / ${s.gridRowEnd}`);
  if (s.gridColumnStart && s.gridColumnEnd) parts.push(`grid-column:${s.gridColumnStart} / ${s.gridColumnEnd}`);
  add('float', s.cssFloat);
  add('clear', s.clear);
  add('vertical-align', s.verticalAlign);
  if (s.position && s.position !== 'static') {
    add('top', s.top);
    add('right', s.right);
    add('bottom', s.bottom);
    add('left', s.left);
    add('z-index', s.zIndex);
  }
  parts.push(fill ? 'background:#000' : 'visibility:hidden');
  return important(parts);
}

/** Out-of-flow placeholder that still hosts carried SVG definitions (display:none would disable them). */
const OUT_OF_FLOW_CARRIER = important([
  'display:block', 'position:absolute', 'width:0', 'height:0', 'overflow:hidden', 'visibility:hidden',
]);
/**
 * A re-homed definitions SVG. `visibility:visible` because it sits inside a
 * `visibility:hidden` placeholder, and a clipPath/mask/pattern child that
 * inherits `hidden` contributes nothing: the visible icon clipped by it would
 * vanish. Safe — the SVG is zero-size and holds only non-rendering definitions.
 */
const ZERO_SVG = important(['position:absolute', 'width:0', 'height:0', 'overflow:hidden', 'visibility:visible']);

/** Adds the ids of `node` and its whole (current) subtree. Iterative; a node already recorded had its whole subtree recorded. */
function collectIds(node: SnNode, into: Set<number>): void {
  const stack: SnNode[] = [node];
  while (stack.length > 0) {
    const next = stack.pop() as SnNode;
    if (into.has(next.id)) continue;
    into.add(next.id);
    if (next.type === SN_ELEMENT || next.type === SN_DOCUMENT) {
      for (const child of next.childNodes) stack.push(child);
    }
  }
}

function hasIdAttr(node: SnElement): boolean {
  const id = hasOwn(node.attributes, 'id') ? node.attributes.id : undefined;
  return typeof id === 'string' && id !== '';
}

/**
 * Walks one definition element: drops bare text outside `<style>` (a clip
 * path's `<text>` is still content) and reports whether anything in it can be
 * referenced by id. Iterative.
 */
function scrubDefinition(def: SnElement, withhold: Withhold): boolean {
  let referenced = false;
  const stack: SnElement[] = [def];
  while (stack.length > 0) {
    const next = stack.pop() as SnElement;
    if (hasIdAttr(next)) referenced = true;
    if (next.tagName.toLowerCase() === 'style') continue;
    const kept: SnNode[] = [];
    for (const child of next.childNodes) {
      if (child.type === SN_TEXT) continue;
      kept.push(child);
      if (child.type === SN_ELEMENT) stack.push(child);
    }
    withhold(next, { childNodes: kept });
  }
  return referenced;
}

/**
 * The id-referenceable definitions of an SVG subtree, outermost first, in
 * document order, each with its own subtree — every other element is dropped.
 * Iterative.
 */
function svgDefinitions(svg: SnElement, withhold: Withhold): SnElement[] {
  const defs: SnElement[] = [];
  const stack: SnNode[] = svg.childNodes.slice().reverse();
  while (stack.length > 0) {
    const next = stack.pop() as SnNode;
    if (next.type !== SN_ELEMENT) continue;
    if (SVG_DEFS.has(next.tagName.toLowerCase())) {
      if (scrubDefinition(next, withhold)) defs.push(next);
      continue;
    }
    for (let i = next.childNodes.length - 1; i >= 0; i--) stack.push(next.childNodes[i] as SnNode);
  }
  return defs;
}

/** Drops text- and URL-bearing attributes (and `extra` ones). */
function stripContentAttrs(node: SnElement, withhold: Withhold, extra: readonly string[] = []): void {
  const next: Record<string, SnAttributeValue> = {};
  for (const key of Object.keys(node.attributes)) {
    const lower = key.toLowerCase();
    if (CONTENT_ATTRS.has(lower) || lower.startsWith('aria-') || lower.startsWith('data-') || extra.indexOf(lower) !== -1) continue;
    next[key] = node.attributes[key] as SnAttributeValue;
  }
  withhold(node, { attributes: next });
}

function isOutOfFlow(s: CSSStyleDeclaration): boolean {
  return (
    s.display === 'none' ||
    s.position === 'absolute' ||
    s.position === 'fixed' ||
    isFloat(s)
  );
}

function isFloat(s: CSSStyleDeclaration): boolean {
  return s.cssFloat !== undefined && s.cssFloat !== '' && s.cssFloat !== 'none';
}

function isVisibleOverflow(value: string | undefined): boolean {
  return value === undefined || value === '' || value === 'visible' || value === 'clip';
}

/**
 * Whether a block box lets its first (top) or last (bottom) in-flow child's
 * margin collapse through it: a non-BFC-root block with no border or padding
 * on that side. Bottom assumes `height: auto` (computed style cannot tell).
 */
function collapsesThrough(s: CSSStyleDeclaration, side: 'top' | 'bottom'): boolean {
  if (s.display !== 'block' && s.display !== 'list-item') return false;
  if (s.position === 'absolute' || s.position === 'fixed') return false;
  if (isFloat(s)) return false;
  if (!isVisibleOverflow(s.overflowX) || !isVisibleOverflow(s.overflowY) || !isVisibleOverflow(s.overflow)) return false;
  return side === 'top'
    ? num(s.borderTopWidth) === 0 && num(s.paddingTop) === 0
    : num(s.borderBottomWidth) === 0 && num(s.paddingBottom) === 0;
}

/** A dropdown select (not `multiple`, `size` ≤ 1) — it shows only its selected option. */
function isClosedSelect(live: Element): boolean {
  const select = live as HTMLSelectElement;
  return select.multiple !== true && !(typeof select.size === 'number' && select.size > 1);
}

/** Whether overflow on one axis clips its content (hidden, clip, auto, scroll). */
function clipsAxis(value: string | undefined): boolean {
  return value === 'hidden' || value === 'clip' || value === 'auto' || value === 'scroll' || value === 'overlay';
}

function isPositioned(s: CSSStyleDeclaration | null): boolean {
  return s !== null && s.position !== undefined && s.position !== '' && s.position !== 'static';
}

/** A computed value that is set and not `none` (missing on old engines → none). */
function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== null && value !== '' && value !== 'none';
}

/** Whether a comma/space-separated computed keyword list holds one of `keywords`. Short lists only. */
function hasKeyword(value: string | undefined, keywords: readonly string[]): boolean {
  if (value === undefined || value === null || value === '' || value.length > 256) return false;
  return value.split(/[\s,]+/).some((k) => keywords.indexOf(k) !== -1);
}

/**
 * Whether `s` makes its box the containing block of absolutely AND fixed
 * positioned descendants without `position` (CSS Transforms/Filter Effects/
 * Containment): transform, perspective, filter, backdrop-filter (prefixed
 * too), contain: paint/layout/strict/content, will-change naming one of
 * those, or a container-type. Properties an old engine lacks read as none.
 */
function establishesContainingBlock(s: CSSStyleDeclaration | null): boolean {
  if (s === null) return false;
  const x = s as unknown as Record<string, string | undefined>;
  return (
    isSet(x.transform) || isSet(x.webkitTransform) ||
    isSet(x.perspective) || isSet(x.webkitPerspective) ||
    isSet(x.filter) || isSet(x.webkitFilter) ||
    isSet(x.backdropFilter) || isSet(x.webkitBackdropFilter) ||
    hasKeyword(x.contain, ['paint', 'layout', 'strict', 'content']) ||
    hasKeyword(x.willChange, ['transform', 'perspective', 'filter', 'backdrop-filter', '-webkit-transform', '-webkit-filter']) ||
    (x.containerType !== undefined && x.containerType !== null && x.containerType !== '' && x.containerType !== 'normal')
  );
}

/** Invisible by its own computed style (visibility inherits, so this already covers hidden ancestors). */
function isInvisible(s: CSSStyleDeclaration | null): boolean {
  return s !== null && (s.visibility === 'hidden' || s.visibility === 'collapse');
}

function isZeroOpacity(s: CSSStyleDeclaration | null): boolean {
  if (s === null || s.opacity === undefined || s.opacity === '') return false;
  const n = parseFloat(s.opacity);
  return Number.isFinite(n) && n <= 0;
}

function toRect(left: number, top: number, right: number, bottom: number): PruneRect {
  return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function intersectRects(x: PruneRect, y: PruneRect): PruneRect {
  return toRect(Math.max(x.left, y.left), Math.max(x.top, y.top), Math.min(x.right, y.right), Math.min(x.bottom, y.bottom));
}

/** Longer than any real computed `clip` / `clip-path` value worth parsing. */
const MAX_CLIP_VALUE_LENGTH = 128;

/** A computed length in px (`12px`, `0`) → number, or null for anything else. */
function pxLength(token: string): number | null {
  if (token === '0') return 0;
  if (token.length < 3 || token.slice(-2) !== 'px') return null;
  const n = Number(token.slice(0, -2));
  return Number.isFinite(n) ? n : null;
}

/** The inside of `name( … )` split on whitespace/commas, or null. Short, capped input only. */
function functionArgs(value: string, name: string): string[] | null {
  if (value.length > MAX_CLIP_VALUE_LENGTH || value.slice(0, name.length + 1).toLowerCase() !== `${name}(`) return null;
  const close = value.indexOf(')');
  if (close === -1) return null;
  const inner = value.slice(name.length + 1, close).trim();
  return inner === '' ? [] : inner.split(/[\s,]+/);
}

/** `clip: rect(t, r, b, l)` (offsets from the border box's top-left; `auto` = that edge) → the region, or null. */
function clipRectRegion(value: string, r: PruneRect): PruneRect | null {
  const args = functionArgs(value.trim(), 'rect');
  if (args === null || args.length !== 4) return null;
  const at = (k: number, auto: number): number | null => (args[k] === 'auto' ? auto : pxLength(args[k]!));
  const t = at(0, 0);
  const rt = at(1, r.width);
  const b = at(2, r.height);
  const l = at(3, 0);
  if (t === null || rt === null || b === null || l === null) return null;
  return toRect(r.left + l, r.top + t, r.left + rt, r.top + b);
}

/** `clip-path: inset(t r b l [round …])` (px or %, CSS shorthand expansion) → the region, or null. */
function insetRegion(value: string, r: PruneRect): PruneRect | null {
  const t = value.trim();
  const round = t.toLowerCase().indexOf(' round ');
  const args = functionArgs(round === -1 ? t : `${t.slice(0, round)})`, 'inset');
  if (args === null || args.length < 1 || args.length > 4) return null;
  const parts = args.length === 1 ? [args[0], args[0], args[0], args[0]]
    : args.length === 2 ? [args[0], args[1], args[0], args[1]]
      : args.length === 3 ? [args[0], args[1], args[2], args[1]]
        : args;
  const len = (token: string | undefined, basis: number): number | null => {
    if (token === undefined) return null;
    if (token.slice(-1) === '%') {
      const n = Number(token.slice(0, -1));
      return Number.isFinite(n) ? (n / 100) * basis : null;
    }
    return pxLength(token);
  };
  const top = len(parts[0], r.height);
  const right = len(parts[1], r.width);
  const bottom = len(parts[2], r.height);
  const left = len(parts[3], r.width);
  if (top === null || right === null || bottom === null || left === null) return null;
  return toRect(r.left + left, r.top + top, r.right - right, r.bottom - bottom);
}

/**
 * The region CSS clipping leaves visible of an element and everything it
 * paints (codex r8 F1), or null when it is not clipped: `clip: rect()` on an
 * absolutely/fixed positioned box, and `clip-path` (`-webkit-` too, Chrome
 * 53). `inset()` is evaluated; any other shape, or a value that does not
 * parse, clips to the border box (fail closed outside it). A zero-area region
 * clips everything — the sr-only / visually-hidden patterns.
 */
function cssClipRegion(s: CSSStyleDeclaration, r: PruneRect): PruneRect | null {
  const x = s as unknown as Record<string, string | undefined>;
  const border = toRect(r.left, r.top, r.right, r.bottom);
  let region: PruneRect | null = null;
  if (s.position === 'absolute' || s.position === 'fixed') {
    const clip = x.clip;
    if (clip !== undefined && clip !== null && clip !== '' && clip !== 'auto') region = clipRectRegion(clip, r) ?? border;
  }
  const path = isSet(x.clipPath) ? x.clipPath : isSet(x.webkitClipPath) ? x.webkitClipPath : undefined;
  if (path !== undefined) {
    const shape = insetRegion(path, r) ?? border;
    region = region === null ? shape : intersectRects(region, shape);
  }
  return region;
}

/**
 * The clip `el` imposes on its descendants: `outer` narrowed by its CSS
 * clip / clip-path region, then, per clipping axis (overflow, or paint
 * containment on both), to its padding box (border box minus borders).
 * Inline boxes do not clip by overflow — except an atomic one (an <svg>
 * root, which clips its content to its viewport even when display:inline);
 * display:contents and display:none boxes do not clip at all.
 */
function clipFor(outer: PruneRect, r: PruneRect, s: CSSStyleDeclaration | null, atomic = false): PruneRect {
  if (s === null || s.display === 'contents' || s.display === 'none') return outer;
  const region = cssClipRegion(s, r);
  if (region !== null) outer = intersectRects(outer, region);
  if (s.display === 'inline' && !atomic) return outer;
  // Paint containment clips to the overflow clip edge (the padding box) on
  // both axes whatever `overflow` says (CSS Containment §3.3).
  const paint = hasKeyword((s as unknown as Record<string, string | undefined>).contain, ['paint', 'strict', 'content']);
  const x = paint || clipsAxis(s.overflowX);
  const y = paint || clipsAxis(s.overflowY);
  if (!x && !y) return outer;
  let { left, top, right, bottom } = outer;
  if (x) {
    left = Math.max(left, r.left + num(s.borderLeftWidth));
    right = Math.min(right, r.right - num(s.borderRightWidth));
  }
  if (y) {
    top = Math.max(top, r.top + num(s.borderTopWidth));
    bottom = Math.min(bottom, r.bottom - num(s.borderBottomWidth));
  }
  return toRect(left, top, right, bottom);
}

/** Per-line client rects, as PruneRects. */
function clientRects(list: ArrayLike<PruneRect>): PruneRect[] {
  const out: PruneRect[] = [];
  for (let i = 0; i < list.length; i++) out.push(list[i] as PruneRect);
  return out;
}

export function defaultFragmentsOf(el: Element): PruneRect[] {
  return clientRects(el.getClientRects());
}

export function defaultTextRectsOf(text: Node): PruneRect[] {
  const doc = text.ownerDocument;
  if (doc === null || typeof doc.createRange !== 'function') return [];
  const range = doc.createRange();
  range.selectNodeContents(text);
  return typeof range.getClientRects === 'function' ? clientRects(range.getClientRects()) : [];
}

/**
 * One line fragment of unseen inline content: an empty inline-block of the
 * fragment's width that adds no height to its line (its margin box is
 * zero-tall, bottom on the text bottom), so the line keeps its own height.
 */
function fragmentStyle(r: PruneRect): string {
  return important([
    'display:inline-block', 'box-sizing:border-box', `width:${px(r.width)}`, `height:${px(r.height)}`,
    'min-width:0', 'min-height:0', 'max-width:none', 'max-height:none',
    `margin:${spx(-r.height)} 0 0 0`, 'padding:0', 'border:0', 'vertical-align:text-bottom', 'visibility:hidden',
  ]);
}

function isBlankText(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0c && c !== 0x0d) return false;
  }
  return true;
}

export function pruneSnapshot(root: SnParent, deps: PruneDeps): PruneResult {
  const result: PruneResult = { masked: false, changed: false, hiddenIds: new Set(), pruned: 0 };
  const withhold = makeWithhold(result);
  const { width: vw, height: vh } = deps.viewport;
  const VIEWPORT = toRect(0, 0, vw, vh);
  /**
   * A box with positive width AND height that overlaps `clip` with positive
   * area (an empty clip overlaps nothing). A zero-width or zero-height box —
   * a `scaleX(0)` / `scaleY(0)` panel, a 0-height wrapper — shows nothing
   * itself (codex r9 F1); its descendants are still judged on their own.
   */
  const overlaps = (r: PruneRect, clip: PruneRect): boolean =>
    r.width > 0 && r.height > 0 &&
    clip.right > clip.left && clip.bottom > clip.top &&
    r.right > clip.left && r.bottom > clip.top && r.left < clip.right && r.top < clip.bottom;
  /** Pruned placeholders' effective margins, for their pruned ancestors' collapse probe. */
  const prunedFlow = new WeakMap<SnElement, PrunedFlow>();
  const zeroed = new WeakSet<SnElement>();
  /** Next id for nodes the pruner adds (fragment placeholders); found on first use. */
  let nextId = 0;
  const freshId = (): number => {
    if (nextId === 0) {
      let max = 0;
      const ids: SnNode[] = [root];
      while (ids.length > 0) {
        const n = ids.pop() as SnNode;
        if (n.id > max) max = n.id;
        if (n.type === SN_ELEMENT || n.type === SN_DOCUMENT) for (const c of n.childNodes) ids.push(c);
      }
      nextId = max + 1;
    }
    return nextId++;
  };
  /** A rect-list read that fails closed to `fallback`; an empty list means no box. */
  const rectsSafe = (read: () => PruneRect[], fallback: PruneRect[]): PruneRect[] => {
    try {
      return read();
    } catch {
      return fallback;
    }
  };
  /** Line-fragment placeholders, a <br> between fragments so each keeps its own line. */
  const fragmentNodes = (rects: PruneRect[]): SnNode[] => {
    const out: SnNode[] = [];
    for (const r of rects) {
      if (out.length > 0) out.push({ type: SN_ELEMENT, id: freshId(), tagName: 'br', attributes: {}, childNodes: [] });
      out.push({ type: SN_ELEMENT, id: freshId(), tagName: 'span', attributes: { style: fragmentStyle(r) }, childNodes: [] });
    }
    return out;
  };

  const liveElement = (node: SnElement): Element | null => {
    const live = deps.nodeFor(node.id);
    return live !== null && live.nodeType === 1 ? (live as Element) : null;
  };

  /** A frame inheriting its parent's clips and fading (pass-through: no box judged). */
  const frame = (node: SnParent, mode: Mode, live: Element | null, rect: PruneRect | null, parent: Frame | null): Frame => ({
    node, mode, live, rect, style: undefined,
    maskText: parent?.maskText ?? false,
    hideText: false,
    blankText: false,
    closedSelect: false,
    svgSkip: parent?.svgSkip ?? false,
    svgHidden: false,
    faded: parent?.faded ?? false,
    seen: false,
    clip: parent?.clip ?? VIEWPORT,
    absClip: parent?.absClip ?? VIEWPORT,
    fixedClip: parent?.fixedClip ?? VIEWPORT,
    index: 0, kept: [], anyVisible: false, carry: null,
  });

  /**
   * Judges a boxed frame's own visibility and the clips it hands its
   * descendants, from its ONE computed-style read.
   */
  const judgeBox = (f: Frame, parent: Frame, atomic = false): void => {
    const s = styleOnce(f);
    const rect = f.rect as PruneRect;
    const position = s?.position;
    const incoming = position === 'fixed' ? parent.fixedClip : position === 'absolute' ? parent.absClip : parent.clip;
    f.faded = parent.faded || isZeroOpacity(s);
    const invisible = f.faded || isInvisible(s);
    f.hideText = invisible;
    // CSS clip / clip-path hides the element's OWN box too, not only its
    // descendants: an sr-only wrapper is unseen even though its box is on screen.
    const region = s !== null && s.display !== 'contents' && s.display !== 'none' ? cssClipRegion(s, rect) : null;
    f.seen = !invisible && overlaps(rect, region === null ? incoming : intersectRects(incoming, region));
    f.clip = clipFor(incoming, rect, s, atomic);
    // A transform/filter/containment box is the containing block of absolute
    // AND fixed descendants, so its clip reaches them; position alone only
    // captures absolute ones.
    const block = establishesContainingBlock(s);
    // The clip region paints over positioned descendants too.
    f.absClip = isPositioned(s) || block ? f.clip : region === null ? parent.absClip : intersectRects(parent.absClip, region);
    f.fixedClip = block ? f.clip : region === null ? parent.fixedClip : intersectRects(parent.fixedClip, region);
  };

  const styleOnce = (f: Frame): CSSStyleDeclaration | null => {
    if (f.style === undefined) f.style = f.live === null ? null : deps.styleOf(f.live);
    return f.style;
  };

  /**
   * The margin on `side` of a block placeholder replacing `node`: its own
   * margin combined (max positive + most negative) with the chain of first
   * (last) in-flow descendant margins that collapsed through it. Bounded.
   */
  const collapsedMargin = (node: SnElement, s: CSSStyleDeclaration, side: 'top' | 'bottom'): number => {
    const own = num(side === 'top' ? s.marginTop : s.marginBottom);
    let pos = Math.max(0, own);
    let neg = Math.min(0, own);
    const add = (m: number): void => {
      pos = Math.max(pos, m);
      neg = Math.min(neg, m);
    };
    if (!collapsesThrough(s, side)) return own;
    let children = node.childNodes;
    let reads = 0;
    let steps = 0;
    for (let depth = 0; depth < COLLAPSE_MAX_DEPTH; depth++) {
      let next: SnNode[] | null = null;
      const n = children.length;
      for (let k = 0; k < n && next === null; k++) {
        if (++steps > COLLAPSE_MAX_STEPS) return pos + neg;
        const child = children[side === 'top' ? k : n - 1 - k] as SnNode;
        if (child.type === SN_TEXT) {
          if (isBlankText(child.textContent)) continue;
          return pos + neg; // line content separates the margins
        }
        if (child.type !== SN_ELEMENT) continue;
        const recorded = prunedFlow.get(child);
        let cs: CSSStyleDeclaration | null;
        if (recorded !== undefined) {
          cs = recorded.style;
        } else {
          if (++reads > COLLAPSE_MAX_READS) return pos + neg;
          const live = liveElement(child);
          cs = live === null ? null : deps.styleOf(live);
        }
        if (cs === null) return pos + neg;
        if (isOutOfFlow(cs)) continue;
        if (!BLOCK_LEVEL.has(cs.display)) return pos + neg;
        if (recorded !== undefined) {
          add(side === 'top' ? recorded.top : recorded.bottom); // already includes its own chain
          return pos + neg;
        }
        add(num(side === 'top' ? cs.marginTop : cs.marginBottom));
        if (!collapsesThrough(cs, side)) return pos + neg;
        next = child.childNodes;
      }
      if (next === null) return pos + neg;
      children = next;
    }
    return pos + neg;
  };

  /** An unseen SVG resource loads nothing: its URL attributes are withheld. */
  const stripUrlAttrs = (node: SnElement): void => {
    const next: Record<string, SnAttributeValue> = {};
    for (const key of Object.keys(node.attributes)) {
      if (SVG_URL_ATTRS.indexOf(key.toLowerCase()) === -1) next[key] = node.attributes[key] as SnAttributeValue;
    }
    withhold(node, { attributes: next });
  };

  /**
   * Slotted light-DOM content (codex r7 F1). rrweb serializes a host's light
   * children under the host, but they RENDER inside the shadow tree, at their
   * assigned <slot>: their real (composed-tree) ancestors are the slot and its
   * ancestors up to the host. Those are walked here — following re-projection
   * (a slot itself slotted) and shadow-root hosts — and folded into one
   * verdict per slot: any sensitive ancestor masks the content, any
   * display:none / visibility:hidden / opacity:0 ancestor hides it, and every
   * ancestor's clip narrows where it can be seen. Cached per slot; depth
   * capped (deeper fails closed: hidden). Absent `assignedSlot` (pre-v1
   * engines): not slotted.
   */
  interface SlotVerdict {
    sensitive: boolean;
    hidden: boolean;
    clip: PruneRect;
  }
  const slotVerdicts = new Map<Element, SlotVerdict>();
  const assignedSlotOf = (n: Node | null): Element | null => {
    if (n === null) return null;
    try {
      const slot = (n as Node & { assignedSlot?: Element | null }).assignedSlot;
      return slot === undefined || slot === null ? null : slot;
    } catch {
      return null;
    }
  };
  const composedParent = (el: Element): Element | null => {
    const slot = assignedSlotOf(el);
    if (slot !== null) return slot;
    if (el.parentElement !== null) return el.parentElement;
    const root = el.parentNode as (Node & { host?: Element }) | null;
    return root !== null && root.nodeType === 11 && root.host !== undefined ? root.host : null;
  };
  const slotVerdict = (n: Node | null): SlotVerdict | null => {
    const slot = assignedSlotOf(n);
    if (slot === null || n === null) return null;
    const cached = slotVerdicts.get(slot);
    if (cached !== undefined) return cached;
    const stop = n.parentElement; // the host: its own context is the serialized parent's
    const verdict: SlotVerdict = { sensitive: false, hidden: false, clip: VIEWPORT };
    let a: Element | null = slot;
    let depth = 0;
    while (a !== null && a !== stop) {
      if (++depth > MAX_SLOT_DEPTH) {
        verdict.hidden = true;
        break;
      }
      if (sensitiveSafe(a)) verdict.sensitive = true;
      const st = deps.styleOf(a);
      if (st !== null && (st.display === 'none' || isZeroOpacity(st) || isInvisible(st))) verdict.hidden = true;
      verdict.clip = clipFor(verdict.clip, deps.rectOf(a), st);
      a = composedParent(a);
    }
    slotVerdicts.set(slot, verdict);
    return verdict;
  };
  const intersect = intersectRects;
  /** The parent context a slotted child is judged in: its slot's verdict folded in. */
  const throughSlot = (parent: Frame, v: SlotVerdict): Frame => ({
    ...parent,
    clip: intersect(parent.clip, v.clip),
    absClip: intersect(parent.absClip, v.clip),
    fixedClip: intersect(parent.fixedClip, v.clip),
    faded: parent.faded || v.hidden,
    hideText: parent.hideText || v.hidden,
  });

  /** `deps.isSensitive`, failing closed: a check that throws never unmasks. */
  const sensitiveSafe = (el: Element): boolean => {
    try {
      return deps.isSensitive(el);
    } catch {
      return true;
    }
  };

  /** A blocked sensitive element (rrweb `rr_width`/`rr_height`) → black same-box placeholder, no class. */
  const maskBlocked = (node: SnElement, live: Element | null, parent: Frame): Verdict => {
    result.masked = true;
    collectIds(node, result.hiddenIds);
    withhold(node, { childNodes: [] });
    const fallback = (w: string, h: string): string =>
      important(['display:inline-block', `width:${w}`, `height:${h}`, 'background:#000']);
    if (live === null) {
      withhold(node, { attributes: { style: fallback(lengthAttr(node.attributes.rr_width), lengthAttr(node.attributes.rr_height)) } });
      return 'hidden';
    }
    const rect = deps.rectOf(live);
    const style = deps.styleOf(live);
    const size = deps.sizeOf(live, rect);
    withhold(node, {
      attributes: {
        style: style !== null
          ? placeholderStyle(style, size, true, { top: num(style.marginTop), bottom: num(style.marginBottom) })
          : fallback(px(size.width), px(size.height)),
      },
    });
    return overlaps(rect, parent.clip) && !parent.faded ? 'visible' : 'hidden';
  };

  /**
   * SVG content. Definitions (and everything in them) are rendered only by
   * reference: never judged. A leaf (a path, a shape) carries no text and is
   * not judged either, so icon-heavy pages pay no extra reads. Any other
   * element — a group, a <text>, an <a> — gets the same visibility rules as
   * HTML from one computed-style read: display:none hides the subtree (its
   * definitions survive), visibility/opacity mask its text; a <text> whose
   * box misses the clip (the SVG viewport, the screen) is hidden too.
   */
  const enterSvgContent = (node: SnElement, tag: string, live: Element | null, parent: Frame): Frame => {
    const f = frame(node, 'svgContent', live, null, parent);
    f.hideText = parent.hideText;
    if (SVG_DEFS.has(tag) || (parent.mode === 'svg' && !parent.seen)) f.svgSkip = true;
    if (SVG_NON_RENDERED.has(tag)) {
      withhold(node, { childNodes: [] });
      return f;
    }
    if (f.svgSkip || live === null) return f;
    // Resource-bearing elements (<image>, <use>, <feImage>, anything with an
    // href/src) are judged whatever their children; other leaves cost nothing.
    const resource = SVG_RESOURCE_LEAVES.has(tag) || SVG_URL_ATTRS.some((name) => hasOwnAttr(node, name));
    if (node.childNodes.length === 0 && !resource) return f;
    const s = styleOnce(f);
    f.faded = parent.faded || isZeroOpacity(s);
    f.hideText = f.faded || isInvisible(s);
    const none = s !== null && s.display === 'none';
    // An unseen resource loads nothing — withheld before definition retention
    // is computed, so a hidden <use> keeps no symbol alive.
    if (resource && (none || f.hideText || !overlaps(deps.rectOf(live), parent.clip))) stripUrlAttrs(node);
    if (none) {
      f.svgHidden = true;
    } else if (tag === 'text') {
      f.svgHidden = !overlaps(deps.rectOf(live), parent.clip);
    }
    return f;
  };

  /**
   * Pre-order step for one element child: either an immediate verdict (no
   * children to walk, or handled whole) or a frame to walk its children.
   */
  const enter = (node: SnElement, outer: Frame): Verdict | Frame => {
    const tag = node.tagName.toLowerCase();
    if (REMOVE.has(tag)) return 'remove';
    if (hasOwn(node.attributes, SKIP_ATTR) && node.attributes[SKIP_ATTR] === 'true') return 'remove';
    const live = liveElement(node);
    if (live !== null && live.getAttribute(SKIP_ATTR) === 'true') return 'remove';
    // Slotted content is judged in its composed-tree context (codex r7 F1).
    const slot = slotVerdict(live);
    const parent = slot === null ? outer : throughSlot(outer, slot);
    if (slot !== null && slot.sensitive) return maskBlocked(node, live, parent);
    if (hasOwn(node.attributes, 'rr_width')) return maskBlocked(node, live, parent);
    const inherit = parent.maskText;
    if (parent.mode === 'head' || tag === 'head') return frame(node, 'head', live, null, parent);
    // The registry's document-level scan (which rrweb blocks at serialization)
    // cannot see into shadow roots, nor elements marked after it ran: judge
    // every element itself. Boxed → black box; a display:contents wrapper has
    // no box, so its bare text is masked and its boxed children blocked here.
    // Only a wrapper that would be judged below can carry the text mask; any
    // other sensitive element (svg/select content, html/body…) is boxed.
    const sensitive = live !== null && (inherit || sensitiveSafe(live));
    let sensitiveStyle: CSSStyleDeclaration | null = null;
    if (sensitive) {
      sensitiveStyle = deps.styleOf(live);
      const judgedHere =
        parent.mode !== 'svg' && parent.mode !== 'svgContent' && parent.mode !== 'selectContent' && !parent.closedSelect &&
        !ALWAYS_VISIBLE.has(tag) && !NEVER_PRUNE.has(tag) && tag !== 'svg';
      if (sensitiveStyle === null || sensitiveStyle.display !== 'contents' || !judgedHere) return maskBlocked(node, live, parent);
    }
    if (parent.mode === 'svg' || parent.mode === 'svgContent') return enterSvgContent(node, tag, live, parent);
    if (parent.closedSelect || parent.mode === 'selectContent') {
      const inSelect = frame(node, 'selectContent', live, null, parent);
      inSelect.hideText = parent.hideText;
      inSelect.blankText = true;
      stripContentAttrs(node, withhold, ['label']); // an option/optgroup `label` is displayed text
      if (tag === 'option' && live !== null && (live as HTMLOptionElement).selected === true) {
        // Shown in the closed box: keep it selected (rrweb drops `selected`
        // for masked inputs) and show the masked value in its place.
        node.attributes.selected = true;
        let first: SnNode | undefined;
        for (const child of node.childNodes) if (child.type === SN_TEXT) { first = child; break; }
        if (first !== undefined && first.type === SN_TEXT) {
          withhold(first, { textContent: MASK_PLACEHOLDER });
          withhold(node, { childNodes: [first] });
        }
        inSelect.blankText = false;
      }
      return inSelect;
    }
    if (ALWAYS_VISIBLE.has(tag)) {
      // html/body are never pruned; their opacity/visibility still hides content.
      const always = frame(node, 'always', live, null, parent);
      const s = styleOnce(always);
      always.faded = parent.faded || isZeroOpacity(s);
      always.hideText = always.faded || isInvisible(s);
      return always;
    }
    if (NEVER_PRUNE.has(tag)) return 'hidden';
    if (live === null) {
      // No box to judge: pass everything through, and treat its bare text as
      // its parent's (a hidden parent's live-less child is conservatively hidden).
      const passThrough = frame(node, 'transparent', null, null, parent);
      passThrough.hideText = parent.hideText;
      return passThrough;
    }
    const rect = deps.rectOf(live);
    if (tag === 'svg') {
      const svg = frame(node, 'svg', live, rect, parent);
      judgeBox(svg, parent, true);
      return svg;
    }
    const judged = frame(node, 'judge', live, rect, parent);
    if (sensitiveStyle !== null) judged.style = sensitiveStyle;
    judgeBox(judged, parent);
    if (tag === 'select' && isClosedSelect(live)) {
      // Pin the measured box: blanked options would otherwise narrow it.
      judged.closedSelect = true;
      const size = deps.sizeOf(live, rect);
      const pin = important(['box-sizing:border-box', `width:${px(size.width)}`, `height:${px(size.height)}`]);
      const own = hasOwn(node.attributes, 'style') ? node.attributes.style : undefined;
      node.attributes.style = typeof own === 'string' && own !== '' ? `${pin};${own}` : pin;
    }
    if (sensitive) {
      // A sensitive display:contents wrapper (the only kind that gets here)
      // cannot be blocked: it has no box. Its BARE text would still ship —
      // mask it character-for-character (ruling 6).
      judged.maskText = true;
      result.masked = true;
    }
    return judged;
  };

  /** Carried definition SVGs become zero-size, keeping only namespace declarations. */
  const zeroSize = (svg: SnElement): SnElement => {
    if (zeroed.has(svg)) return svg;
    zeroed.add(svg);
    const attrs: Record<string, SnAttributeValue> = { width: '0', height: '0', style: ZERO_SVG };
    for (const key of ['xmlns', 'xmlns:xlink']) {
      if (hasOwn(svg.attributes, key)) attrs[key] = svg.attributes[key] as SnAttributeValue;
    }
    withhold(svg, { attributes: attrs });
    return svg;
  };

  /** Replaces `node` with a placeholder hosting the subtree's carried SVG definitions. */
  const prune = (f: Frame, parent: Frame | undefined): Verdict => {
    const node = f.node as SnElement;
    const live = f.live as Element;
    const rect = f.rect as PruneRect;
    const style = styleOnce(f);
    result.pruned++;
    collectIds(node, result.hiddenIds);
    const carried = f.carry ?? [];
    let css: string;
    if (style === null || style.display === 'none') {
      css = style === null && carried.length > 0 ? OUT_OF_FLOW_CARRIER : DISPLAY_NONE;
      prunedFlow.set(node, { style, top: 0, bottom: 0 });
    } else if (style.position === 'absolute' || style.position === 'fixed') {
      // Out of flow: takes no space. display:none unless it must host carried
      // definitions (which display:none would disable) — then a zero-size box.
      css = carried.length > 0 ? OUT_OF_FLOW_CARRIER : DISPLAY_NONE;
      prunedFlow.set(node, { style, top: 0, bottom: 0 });
    } else {
      // In flow (floats included: they take space). A flex/grid item is a
      // formatting-context root, so nothing collapses through it.
      const parentStyle = parent !== undefined ? styleOnce(parent) : null;
      const isItem = parentStyle !== null && FLEX_OR_GRID.has(parentStyle.display);
      const margins = isItem
        ? { top: num(style.marginTop), bottom: num(style.marginBottom) }
        : { top: collapsedMargin(node, style, 'top'), bottom: collapsedMargin(node, style, 'bottom') };
      css = placeholderStyle(style, deps.sizeOf(live, rect), false, margins);
      prunedFlow.set(node, { style, top: margins.top, bottom: margins.bottom });
    }
    withhold(node, { attributes: { style: css }, childNodes: carried.map(zeroSize) });
    return 'hidden';
  };

  /**
   * An unseen inline element is kept — inline boxes span line fragments, so
   * no single same-box placeholder fits — but its content is not: children
   * become one empty placeholder per measured line fragment (padding and
   * border folded into them), plus any carried SVG definitions.
   */
  const blankInline = (f: Frame): void => {
    const node = f.node as SnElement;
    if (node.childNodes.length === 0) return; // nothing to blank (a void element, an input): keep its box as is
    const live = f.live as Element;
    const rect = f.rect as PruneRect;
    result.pruned++;
    for (const child of node.childNodes) collectIds(child, result.hiddenIds);
    // Layout, not visibility: a zero-width line box still holds its line height.
    const fallback = rect.width + rect.height > 0 ? [rect] : [];
    const measured = rectsSafe(() => (deps.fragmentsOf ?? defaultFragmentsOf)(live), fallback);
    const fragments = measured.length > 0 ? measured : fallback;
    withhold(node, { childNodes: [...(f.carry ?? []).map(zeroSize), ...fragmentNodes(fragments)] });
    const own = hasOwn(node.attributes, 'style') ? node.attributes.style : undefined;
    const fold = important(['padding:0', 'border:0']);
    node.attributes.style = typeof own === 'string' && own !== '' ? `${own};${fold}` : fold;
  };

  /**
   * Bare text of an element whose own box is not seen (a display:contents
   * element has none; its text lays out in the parent's lines) is judged per
   * text node, whatever its siblings are: a visible child keeps the element,
   * never its other text. Each text child none of whose line boxes meets the
   * clip is replaced by fragment placeholders. Text already masked
   * (invisible, sensitive) is left as is.
   */
  const blankUnseenText = (f: Frame): void => {
    if (f.hideText || f.maskText) return;
    const node = f.node as SnElement;
    let changed = false;
    const next: SnNode[] = [];
    for (const child of node.childNodes) {
      if (child.type !== SN_TEXT || isBlankText(child.textContent)) {
        next.push(child);
        continue;
      }
      const live = deps.nodeFor(child.id);
      // No live text to measure: it cannot be shown to be seen.
      const rects = live === null ? [] : rectsSafe(() => (deps.textRectsOf ?? defaultTextRectsOf)(live), []);
      if (rects.some((r) => overlaps(r, f.clip))) {
        next.push(child);
        continue;
      }
      changed = true;
      result.hiddenIds.add(child.id);
      for (const n of fragmentNodes(rects)) next.push(n);
    }
    if (changed) {
      result.pruned++;
      withhold(node, { childNodes: next });
    }
  };

  /** Post-order step: the frame's children are final; decide its own verdict. */
  const finish = (f: Frame, parent: Frame | undefined): Verdict => {
    switch (f.mode) {
      case 'root':
      case 'transparent':
        return f.anyVisible ? 'visible' : 'hidden';
      case 'always':
        return 'visible';
      case 'svgContent':
        if (f.svgHidden) {
          // Its definitions may still be referenced from visible content.
          const node = f.node as SnElement;
          collectIds(node, result.hiddenIds);
          withhold(node, { childNodes: svgDefinitions(node, withhold) });
          result.pruned++;
        }
        return 'hidden';
      case 'head':
      case 'selectContent':
        return 'hidden';
      default:
        break;
    }
    const node = f.node as SnElement;
    if (f.seen) return 'visible';
    if (f.mode === 'svg') {
      const defs = svgDefinitions(node, withhold);
      if (defs.length > 0) {
        // Kept for its definitions only; claims no visibility, so an off-screen
        // screen holding an icon with a clipPath id is still pruned (it
        // re-homes this SVG under its placeholder). Everything else in it is
        // withheld — and hidden: nothing focused in it may be named.
        const keptDefs = new Set<SnNode>(defs);
        for (const child of node.childNodes) if (!keptDefs.has(child)) collectIds(child, result.hiddenIds);
        withhold(node, { childNodes: defs });
        f.carry = [node];
        return 'keep';
      }
      return prune(f, parent);
    }
    if (f.anyVisible) {
      blankUnseenText(f);
      return 'visible';
    }
    const style = styleOnce(f);
    // Inline boxes span line fragments and display:contents has no box, so
    // neither can be replaced by a same-box placeholder. <svg> roots and
    // replaced elements (img, video, …) are atomic boxes even when inline, so
    // they are pruned to an inline-block of the same size (rulings 8, S20).
    if (style !== null && (style.display === 'contents' || (style.display === 'inline' && !isReplaced(node)))) {
      stripContentAttrs(node, withhold);
      if (style.display === 'inline') blankInline(f);
      else blankUnseenText(f);
      return 'hidden';
    }
    return prune(f, parent);
  };

  const settle = (parent: Frame, child: SnNode, verdict: Verdict, childFrame: Frame | null): void => {
    if (verdict === 'remove') return;
    parent.kept.push(child);
    if (verdict === 'visible') {
      // No ancestor of a visible node is pruned, so its carried definitions stay put.
      parent.anyVisible = true;
      return;
    }
    const carry = childFrame?.carry;
    if (carry === null || carry === undefined || carry.length === 0) return;
    if (parent.carry === null) parent.carry = carry;
    else for (const svg of carry) parent.carry.push(svg);
  };

  const stack: Frame[] = [frame(root, 'root', null, null, null)];
  while (stack.length > 0) {
    const top = stack[stack.length - 1] as Frame;
    if (top.index < top.node.childNodes.length) {
      const child = top.node.childNodes[top.index++] as SnNode;
      if (child.type === SN_ELEMENT) {
        const entered = enter(child, top);
        if (typeof entered === 'string') settle(top, child, entered, null);
        else stack.push(entered);
      } else if (child.type === SN_DOCUMENT) {
        stack.push(frame(child, 'transparent', null, null, top));
      } else {
        if (child.type === SN_TEXT && (top.blankText || top.maskText || top.hideText) && !isBlankText(child.textContent)) {
          withhold(child, { textContent: top.blankText ? '' : child.textContent.replace(/\S/g, '•') });
        } else if (child.type === SN_TEXT && !isBlankText(child.textContent)) {
          // Bare text slotted into a shadow tree: masked when its slot is
          // sensitive, hidden or clips it away (codex r7 F1).
          const liveText = deps.nodeFor(child.id);
          const v = slotVerdict(liveText);
          if (v !== null) {
            const clip = intersect(top.clip, v.clip);
            const unseen =
              v.sensitive || v.hidden || top.faded ||
              !rectsSafe(() => (deps.textRectsOf ?? defaultTextRectsOf)(liveText as Node), []).some((r) => overlaps(r, clip));
            if (unseen) {
              if (v.sensitive) result.masked = true;
              withhold(child, { textContent: child.textContent.replace(/\S/g, '•') });
            }
          }
        }
        top.kept.push(child);
      }
      continue;
    }
    top.node.childNodes = top.kept; // only script/noscript/base/SDK chrome were left out — never page content
    stack.pop();
    const parent = stack[stack.length - 1];
    const verdict = finish(top, parent);
    if (parent !== undefined) settle(parent, top.node, verdict, top);
  }
  dropUnreferencedDefinitions(root, withhold);
  if (result.masked || result.pruned > 0) result.changed = true;
  return result;
}

// ── SVG definitions: kept only when referenced ──────────────────────────────

/** Adds every `#id` that `url(…)` occurrences in `text` point at (raw and decoded). Linear. */
function addUrlRefs(text: string, into: Set<string>): void {
  let pos = 0;
  for (;;) {
    const u = text.indexOf('url(', pos);
    if (u === -1) return;
    const close = text.indexOf(')', u + 4);
    if (close === -1) return;
    const inner = text.slice(u + 4, close);
    const hash = inner.lastIndexOf('#');
    if (hash !== -1) addRef(inner.slice(hash + 1), into);
    pos = close + 1;
  }
}

function addRef(raw: string, into: Set<string>): void {
  let end = raw.length;
  while (end > 0 && /[\s'"]/.test(raw.charAt(end - 1))) end--;
  const id = raw.slice(0, end);
  if (id === '') return;
  into.add(id);
  try {
    into.add(decodeURIComponent(id));
  } catch {
    /* not percent-encoded */
  }
}

function addNodeRefs(node: SnElement, into: Set<string>): void {
  for (const key of Object.keys(node.attributes)) {
    const value = node.attributes[key];
    if (typeof value !== 'string') continue;
    const lower = key.toLowerCase();
    if (lower === 'href' || lower === 'xlink:href') {
      const t = value.trim();
      const hash = t.indexOf('#');
      if (hash !== -1) addRef(t.slice(hash + 1), into); // `#id`, or rrweb's absolutized same-document form
    }
    if (value.indexOf('url(') !== -1) addUrlRefs(value, into);
  }
}

interface DefUnit {
  node: SnElement;
  parent: SnParent;
  ids: string[];
  refs: Set<string>;
}

/**
 * An SVG definition (a child of <defs>, or a symbol / clipPath / mask /
 * gradient / pattern / filter / marker anywhere) renders only where visible
 * content references it, so one nothing references is dropped whole; a
 * referenced one loses bare text that never renders (outside text/tspan/
 * textPath/style). References come from every attribute and stylesheet
 * outside definitions, then from kept definitions in turn. Iterative.
 */
function dropUnreferencedDefinitions(root: SnParent, withhold: Withhold): void {
  const units: DefUnit[] = [];
  const outsideRefs = new Set<string>();
  type Item = { node: SnNode; parent: SnParent | null; unit: DefUnit | null; inDefs: boolean };
  const stack: Item[] = [{ node: root, parent: null, unit: null, inDefs: false }];
  while (stack.length > 0) {
    const { node, parent, unit, inDefs } = stack.pop() as Item;
    if (node.type === SN_TEXT) {
      if (node.isStyle === true || (parent !== null && parent.type === SN_ELEMENT && parent.tagName.toLowerCase() === 'style')) {
        addUrlRefs(node.textContent, unit?.refs ?? outsideRefs);
      }
      continue;
    }
    if (node.type !== SN_ELEMENT && node.type !== SN_DOCUMENT) continue;
    let own = unit;
    let childInDefs = false;
    if (node.type === SN_ELEMENT) {
      const tag = node.tagName.toLowerCase();
      if (own === null && node.isSVG === true && parent !== null && tag !== 'style' && (inDefs || (SVG_DEFS.has(tag) && tag !== 'defs'))) {
        own = { node, parent, ids: [], refs: new Set() };
        units.push(own);
      }
      if (own === null && node.isSVG === true && tag === 'defs') {
        childInDefs = true;
        // Bare text directly in <defs> never renders.
        withhold(node, { childNodes: node.childNodes.filter((c) => c.type !== SN_TEXT || isBlankText(c.textContent)) });
      }
      if (own !== null) {
        const id = hasOwn(node.attributes, 'id') ? node.attributes.id : undefined;
        if (typeof id === 'string' && id !== '') own.ids.push(id);
      }
      addNodeRefs(node, own?.refs ?? outsideRefs);
    }
    for (let i = node.childNodes.length - 1; i >= 0; i--) {
      stack.push({ node: node.childNodes[i] as SnNode, parent: node, unit: own, inDefs: childInDefs });
    }
  }
  if (units.length === 0) return;

  // Closure: a kept definition's own references keep more definitions.
  const byId = new Map<string, DefUnit[]>();
  for (const u of units) for (const id of u.ids) {
    const list = byId.get(id);
    if (list === undefined) byId.set(id, [u]);
    else list.push(u);
  }
  const kept = new Set<DefUnit>();
  const pending: string[] = [];
  outsideRefs.forEach((id) => pending.push(id));
  const seenIds = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop() as string;
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    for (const u of byId.get(id) ?? []) {
      if (kept.has(u)) continue;
      kept.add(u);
      u.refs.forEach((r) => pending.push(r));
    }
  }

  const dropFrom = new Map<SnParent, Set<SnNode>>();
  for (const u of units) {
    if (kept.has(u)) {
      dropStrayText(u.node, withhold);
      continue;
    }
    const set = dropFrom.get(u.parent);
    if (set === undefined) dropFrom.set(u.parent, new Set([u.node]));
    else set.add(u.node);
  }
  dropFrom.forEach((drop, parent) => {
    withhold(parent, { childNodes: parent.childNodes.filter((c) => !drop.has(c)) });
  });
}

/** Removes bare text outside text-rendering SVG elements from a kept definition. Iterative. */
function dropStrayText(def: SnElement, withhold: Withhold): void {
  const stack: SnElement[] = [def];
  while (stack.length > 0) {
    const el = stack.pop() as SnElement;
    const hostsText = SVG_TEXT_HOSTS.has(el.tagName.toLowerCase());
    const next: SnNode[] = [];
    for (const child of el.childNodes) {
      if (child.type === SN_TEXT && !hostsText && !isBlankText(child.textContent)) continue;
      next.push(child);
      if (child.type === SN_ELEMENT) stack.push(child);
    }
    withhold(el, { childNodes: next });
  }
}

