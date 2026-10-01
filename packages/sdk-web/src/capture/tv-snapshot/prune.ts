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
// Also here, because this is the one pass that sees the LIVE element behind
// each serialized node: SDK chrome removal, blocked-sensitive black boxes, and
// bare text of sensitive display:contents wrappers.
//
// Runs on slow TV silicon over page-sized trees: one iterative post-order walk
// (no recursion — deep pages must not overflow the stack), at most one rect
// and one computed-style read per judged element (plus a bounded
// margin-collapse probe per block placeholder, and one line-fragment read per
// unseen inline element or unseen display:contents text), and no layout
// reads at all inside head or SVG content. LAZY (tv-snapshot chunk).
//
// Unseen inline content keeps its layout but not its content: an inline
// element (or display:contents text) that no line box of is seen keeps one
// empty inline-block per measured line fragment in place of its children.
//
// "Seen" means: the element's own box intersects the viewport INTERSECTED with
// every clip of an ancestor whose overflow is not visible (hidden, clip, auto,
// scroll — for a scroll container its padding box, so a rail item scrolled out
// of the rail is unseen), AND the element is not `visibility:hidden|collapse`
// nor `opacity:0` (itself or any ancestor — opacity does not inherit, so it is
// propagated). Clips follow the containing-block chain: an absolutely
// positioned box escapes the clips of non-positioned ancestors below its
// containing block, a fixed box escapes all of them. Bare text directly inside
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
  hiddenIds: Set<number>;
  pruned: number;
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
  /** This element or an ancestor has opacity:0 — every descendant is invisible. */
  faded: boolean;
  /** The element's own box is seen (see header). Judged/svg frames only. */
  seen: boolean;
  /** The visible region for in-flow/relative/sticky/float descendants. */
  clip: PruneRect;
  /** The visible region for absolutely positioned descendants (containing-block chain). */
  absClip: PruneRect;
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
/** Attributes of a kept off-screen inline element that carry text or URLs and have no layout effect. */
const CONTENT_ATTRS = new Set(['href', 'title', 'alt', 'placeholder']);
const BLOCK_LEVEL = new Set(['block', 'list-item', 'table', 'flex', 'grid', 'flow-root', '-webkit-box']);
const FLEX_OR_GRID = new Set(['flex', 'inline-flex', 'grid', 'inline-grid', '-webkit-box', '-webkit-inline-box']);
/** Margin-collapse probe bounds (S18): levels descended, style reads and nodes examined per side. */
const COLLAPSE_MAX_DEPTH = 8;
const COLLAPSE_MAX_READS = 16;
const COLLAPSE_MAX_STEPS = 64;

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
function scrubDefinition(def: SnElement): boolean {
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
    next.childNodes = kept;
  }
  return referenced;
}

/**
 * The id-referenceable definitions of an SVG subtree, outermost first, in
 * document order, each with its own subtree — every other element is dropped.
 * Iterative.
 */
function svgDefinitions(svg: SnElement): SnElement[] {
  const defs: SnElement[] = [];
  const stack: SnNode[] = svg.childNodes.slice().reverse();
  while (stack.length > 0) {
    const next = stack.pop() as SnNode;
    if (next.type !== SN_ELEMENT) continue;
    if (SVG_DEFS.has(next.tagName.toLowerCase())) {
      if (scrubDefinition(next)) defs.push(next);
      continue;
    }
    for (let i = next.childNodes.length - 1; i >= 0; i--) stack.push(next.childNodes[i] as SnNode);
  }
  return defs;
}

function stripContentAttrs(node: SnElement): void {
  const next: Record<string, SnAttributeValue> = {};
  for (const key of Object.keys(node.attributes)) {
    const lower = key.toLowerCase();
    if (CONTENT_ATTRS.has(lower) || lower.startsWith('aria-') || lower.startsWith('data-')) continue;
    next[key] = node.attributes[key] as SnAttributeValue;
  }
  node.attributes = next;
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

/**
 * The clip `el` imposes on its descendants: `outer` narrowed, per clipping
 * axis, to its padding box (border box minus borders). Inline and
 * display:contents boxes do not clip.
 */
function clipFor(outer: PruneRect, r: PruneRect, s: CSSStyleDeclaration | null): PruneRect {
  if (s === null || s.display === 'inline' || s.display === 'contents' || s.display === 'none') return outer;
  const x = clipsAxis(s.overflowX);
  const y = clipsAxis(s.overflowY);
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
  const result: PruneResult = { masked: false, hiddenIds: new Set(), pruned: 0 };
  const { width: vw, height: vh } = deps.viewport;
  const VIEWPORT = toRect(0, 0, vw, vh);
  /** A box with any extent that overlaps `clip` (an empty clip overlaps nothing). */
  const overlaps = (r: PruneRect, clip: PruneRect): boolean =>
    r.width + r.height > 0 &&
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
    faded: parent?.faded ?? false,
    seen: false,
    clip: parent?.clip ?? VIEWPORT,
    absClip: parent?.absClip ?? VIEWPORT,
    index: 0, kept: [], anyVisible: false, carry: null,
  });

  /**
   * Judges a boxed frame's own visibility and the clips it hands its
   * descendants, from its ONE computed-style read.
   */
  const judgeBox = (f: Frame, parent: Frame): void => {
    const s = styleOnce(f);
    const rect = f.rect as PruneRect;
    const position = s?.position;
    const incoming = position === 'fixed' ? VIEWPORT : position === 'absolute' ? parent.absClip : parent.clip;
    f.faded = parent.faded || isZeroOpacity(s);
    const invisible = f.faded || isInvisible(s);
    f.hideText = invisible;
    f.seen = !invisible && overlaps(rect, incoming);
    f.clip = clipFor(incoming, rect, s);
    f.absClip = isPositioned(s) ? f.clip : parent.absClip;
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
    node.childNodes = [];
    const fallback = (w: string, h: string): string =>
      important(['display:inline-block', `width:${w}`, `height:${h}`, 'background:#000']);
    if (live === null) {
      node.attributes = { style: fallback(lengthAttr(node.attributes.rr_width), lengthAttr(node.attributes.rr_height)) };
      return 'hidden';
    }
    const rect = deps.rectOf(live);
    const style = deps.styleOf(live);
    const size = deps.sizeOf(live, rect);
    node.attributes = {
      style: style !== null
        ? placeholderStyle(style, size, true, { top: num(style.marginTop), bottom: num(style.marginBottom) })
        : fallback(px(size.width), px(size.height)),
    };
    return overlaps(rect, parent.clip) && !parent.faded ? 'visible' : 'hidden';
  };

  /**
   * Pre-order step for one element child: either an immediate verdict (no
   * children to walk, or handled whole) or a frame to walk its children.
   */
  const enter = (node: SnElement, parent: Frame): Verdict | Frame => {
    const tag = node.tagName.toLowerCase();
    if (REMOVE.has(tag)) return 'remove';
    if (hasOwn(node.attributes, SKIP_ATTR) && node.attributes[SKIP_ATTR] === 'true') return 'remove';
    const live = liveElement(node);
    if (live !== null && live.getAttribute(SKIP_ATTR) === 'true') return 'remove';
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
    if (parent.mode === 'svg' || parent.mode === 'svgContent') return frame(node, 'svgContent', live, null, parent);
    if (parent.closedSelect || parent.mode === 'selectContent') {
      const inSelect = frame(node, 'selectContent', live, null, parent);
      inSelect.hideText = parent.hideText;
      inSelect.blankText = true;
      stripContentAttrs(node); // an option/optgroup `label` is displayed text
      if (hasOwn(node.attributes, 'label')) delete node.attributes.label;
      if (tag === 'option' && live !== null && (live as HTMLOptionElement).selected === true) {
        // Shown in the closed box: keep it selected (rrweb drops `selected`
        // for masked inputs) and show the masked value in its place.
        node.attributes.selected = true;
        let first: SnNode | undefined;
        for (const child of node.childNodes) if (child.type === SN_TEXT) { first = child; break; }
        if (first !== undefined && first.type === SN_TEXT) {
          first.textContent = MASK_PLACEHOLDER;
          node.childNodes = [first];
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
      judgeBox(svg, parent);
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
    svg.attributes = attrs;
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
    node.attributes = { style: css };
    node.childNodes = carried.map(zeroSize);
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
    const fallback = rect.width + rect.height > 0 ? [rect] : [];
    const measured = rectsSafe(() => (deps.fragmentsOf ?? defaultFragmentsOf)(live), fallback);
    const fragments = measured.length > 0 ? measured : fallback;
    node.childNodes = [...(f.carry ?? []).map(zeroSize), ...fragmentNodes(fragments)];
    const own = hasOwn(node.attributes, 'style') ? node.attributes.style : undefined;
    const fold = important(['padding:0', 'border:0']);
    node.attributes.style = typeof own === 'string' && own !== '' ? `${own};${fold}` : fold;
  };

  /**
   * An unseen display:contents element has no box of its own; its bare text
   * lays out in the parent's lines. Each text child none of whose line boxes
   * meets the clip is replaced by fragment placeholders. Text already masked
   * (invisible, sensitive) is left as is.
   */
  const blankContentsText = (f: Frame): void => {
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
      node.childNodes = next;
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
      case 'head':
      case 'svgContent':
      case 'selectContent':
        return 'hidden';
      default:
        break;
    }
    const node = f.node as SnElement;
    if (f.seen) return 'visible';
    if (f.mode === 'svg') {
      const defs = svgDefinitions(node);
      if (defs.length > 0) {
        // Kept for its definitions only; claims no visibility, so an off-screen
        // screen holding an icon with a clipPath id is still pruned (it
        // re-homes this SVG under its placeholder).
        node.childNodes = defs;
        f.carry = [node];
        return 'keep';
      }
      return prune(f, parent);
    }
    if (f.anyVisible) return 'visible';
    const style = styleOnce(f);
    // Inline boxes span line fragments and display:contents has no box, so
    // neither can be replaced by a same-box placeholder. <svg> roots and
    // replaced elements (img, video, …) are atomic boxes even when inline, so
    // they are pruned to an inline-block of the same size (rulings 8, S20).
    if (style !== null && (style.display === 'contents' || (style.display === 'inline' && !isReplaced(node)))) {
      stripContentAttrs(node);
      if (style.display === 'inline') blankInline(f);
      else blankContentsText(f);
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
        if (top.blankText && child.type === SN_TEXT) child.textContent = '';
        else if ((top.maskText || top.hideText) && child.type === SN_TEXT) child.textContent = child.textContent.replace(/\S/g, '•');
        top.kept.push(child);
      }
      continue;
    }
    top.node.childNodes = top.kept;
    stack.pop();
    const parent = stack[stack.length - 1];
    const verdict = finish(top, parent);
    if (parent !== undefined) settle(parent, top.node, verdict, top);
  }
  return result;
}

