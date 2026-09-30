// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Viewport pruning (spec §Privacy and masking): a TV report must not carry
// content the user never saw — RN-web keeps previous screens mounted — yet the
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
// read per judged element, computed style read only when a verdict needs it
// (plus a bounded margin-collapse probe per block placeholder), and no layout
// reads at all inside head or SVG content. LAZY (tv-snapshot chunk).
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
}

export interface PruneResult {
  masked: boolean;
  hiddenIds: Set<number>;
  pruned: number;
}

/**
 * - `visible`: intersects the viewport (itself or a descendant) — ancestors stay.
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
 * - `judge`: an element with a live box — pruned when neither it nor any
 *   descendant intersects the viewport.
 */
type Mode = 'root' | 'transparent' | 'always' | 'head' | 'svg' | 'svgContent' | 'judge';

interface Frame {
  node: SnParent;
  mode: Mode;
  live: Element | null;
  rect: PruneRect | null;
  /** Computed style, read at most once (undefined = not read yet). */
  style: CSSStyleDeclaration | null | undefined;
  /** Mask bare text in this subtree (inside a sensitive display:contents wrapper). */
  maskText: boolean;
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
  const intersects = (r: PruneRect): boolean =>
    r.width + r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
  /** Pruned placeholders' effective margins, for their pruned ancestors' collapse probe. */
  const prunedFlow = new WeakMap<SnElement, PrunedFlow>();
  const zeroed = new WeakSet<SnElement>();

  const liveElement = (node: SnElement): Element | null => {
    const live = deps.nodeFor(node.id);
    return live !== null && live.nodeType === 1 ? (live as Element) : null;
  };

  const frame = (node: SnParent, mode: Mode, live: Element | null, rect: PruneRect | null, maskText: boolean): Frame => ({
    node, mode, live, rect, style: undefined, maskText, index: 0, kept: [], anyVisible: false, carry: null,
  });

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

  /** A blocked sensitive element (rrweb `rr_width`/`rr_height`) → black same-box placeholder, no class. */
  const maskBlocked = (node: SnElement, live: Element | null): Verdict => {
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
    return intersects(rect) ? 'visible' : 'hidden';
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
    if (hasOwn(node.attributes, 'rr_width')) return maskBlocked(node, live);
    const inherit = parent.maskText;
    if (parent.mode === 'head' || tag === 'head') return frame(node, 'head', live, null, inherit);
    if (parent.mode === 'svg' || parent.mode === 'svgContent') return frame(node, 'svgContent', live, null, inherit);
    if (ALWAYS_VISIBLE.has(tag)) return frame(node, 'always', live, null, inherit);
    if (NEVER_PRUNE.has(tag)) return 'hidden';
    if (live === null) return frame(node, 'transparent', null, null, inherit);
    const rect = deps.rectOf(live);
    if (tag === 'svg') return frame(node, 'svg', live, rect, inherit);
    const judged = frame(node, 'judge', live, rect, inherit);
    if (!inherit && deps.isSensitive(live)) {
      // A sensitive display:contents wrapper cannot be blocked (it has no box);
      // the registry blocks its element children. Its BARE text would still
      // ship — mask it character-for-character (ruling 6).
      const style = styleOnce(judged);
      if (style !== null && style.display === 'contents') {
        judged.maskText = true;
        result.masked = true;
      }
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
        return 'hidden';
      default:
        break;
    }
    const node = f.node as SnElement;
    if (intersects(f.rect as PruneRect)) return 'visible';
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

  const stack: Frame[] = [frame(root, 'root', null, null, false)];
  while (stack.length > 0) {
    const top = stack[stack.length - 1] as Frame;
    if (top.index < top.node.childNodes.length) {
      const child = top.node.childNodes[top.index++] as SnNode;
      if (child.type === SN_ELEMENT) {
        const entered = enter(child, top);
        if (typeof entered === 'string') settle(top, child, entered, null);
        else stack.push(entered);
      } else if (child.type === SN_DOCUMENT) {
        stack.push(frame(child, 'transparent', null, null, top.maskText));
      } else {
        if (top.maskText && child.type === SN_TEXT) child.textContent = child.textContent.replace(/\S/g, '•');
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

