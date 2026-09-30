// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Viewport pruning (spec §Privacy and masking): a TV report must not carry
// content the user never saw — RN-web keeps previous screens mounted — yet the
// recorded scroll offset must land on the same content, so LAYOUT GEOMETRY is
// preserved. Pruned nodes stay in their parent's child list (so :nth-child
// does not shift) as childless placeholders: in-flow → same box, margins,
// display, position and grid/flex placement, hidden; out-of-flow or
// display:none → display:none. Also here, because this is the one pass that
// sees the LIVE element behind each serialized node: SDK chrome removal,
// blocked-sensitive black boxes, and bare text of sensitive display:contents
// wrappers.
//
// Runs on slow TV silicon over page-sized trees: one iterative post-order walk
// (no recursion — deep pages must not overflow the stack), at most one rect
// read per judged element, computed style read only when a verdict needs it,
// and no layout reads at all inside head or SVG content. LAZY (tv-snapshot chunk).
import { SN_DOCUMENT, SN_ELEMENT, SN_TEXT, type SnElement, type SnNode, type SnParent } from './sn-types.js';

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

type Verdict = 'remove' | 'visible' | 'hidden';

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
}

const ALWAYS_VISIBLE = new Set(['html', 'body']);
const NEVER_PRUNE = new Set(['style', 'link', 'meta', 'title']);
const REMOVE = new Set(['script', 'noscript', 'base']);
const SKIP_ATTR = 'data-everframe-skip-capture';
/** Atomic-box (replaced) elements: pruned even when inline (ruling S20). */
const REPLACED = new Set(['img', 'video', 'canvas', 'picture', 'iframe', 'object', 'embed']);

function isReplaced(node: SnElement): boolean {
  const tag = node.tagName.toLowerCase();
  if (REPLACED.has(tag)) return true;
  if (tag !== 'input' || !hasOwn(node.attributes, 'type')) return false;
  return String(node.attributes.type).trim().toLowerCase() === 'image';
}

function hasOwn(obj: object, key: string): boolean {
  // Object.hasOwn is missing on old TV Chromium.
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Layout size without transforms (offsetWidth/Height) — rect for SVG and non-HTML elements. */
export function defaultSizeOf(el: Element, rect: PruneRect): { width: number; height: number } {
  const html = el as HTMLElement;
  return typeof html.offsetWidth === 'number' && typeof html.offsetHeight === 'number'
    ? { width: html.offsetWidth, height: html.offsetHeight }
    : { width: rect.width, height: rect.height };
}

function px(n: number): string {
  return `${Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0}px`;
}

/** A numeric length from a serialized (page-reachable) attribute — never its raw text. */
function lengthAttr(value: unknown): string {
  return px(typeof value === 'number' ? value : parseFloat(String(value)));
}

function placeholderStyle(
  s: CSSStyleDeclaration,
  size: { width: number; height: number },
  fill: boolean,
): string {
  if (s.display === 'none') return 'display:none';
  const display =
    s.display === 'inline' || s.display === 'contents' ? 'inline-block' : s.display === 'list-item' ? 'block' : s.display;
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
    `margin:${s.marginTop} ${s.marginRight} ${s.marginBottom} ${s.marginLeft}`,
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
  return parts.join(';');
}

/** Adds the ids of `node` and its whole (current) subtree. Iterative. */
function collectIds(node: SnNode, into: Set<number>): void {
  const stack: SnNode[] = [node];
  while (stack.length > 0) {
    const next = stack.pop() as SnNode;
    into.add(next.id);
    if (next.type === SN_ELEMENT || next.type === SN_DOCUMENT) {
      for (const child of next.childNodes) stack.push(child);
    }
  }
}

/** Whether any element below `node` carries a non-empty id (SVG sprites, gradients). Iterative. */
function definesIds(node: SnElement): boolean {
  const stack: SnNode[] = node.childNodes.slice();
  while (stack.length > 0) {
    const next = stack.pop() as SnNode;
    if (next.type !== SN_ELEMENT) continue;
    const id = hasOwn(next.attributes, 'id') ? next.attributes.id : undefined;
    if (typeof id === 'string' && id !== '') return true;
    for (const child of next.childNodes) stack.push(child);
  }
  return false;
}

export function pruneSnapshot(root: SnParent, deps: PruneDeps): PruneResult {
  const result: PruneResult = { masked: false, hiddenIds: new Set(), pruned: 0 };
  const { width: vw, height: vh } = deps.viewport;
  const intersects = (r: PruneRect): boolean =>
    r.width + r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;

  const liveElement = (node: SnElement): Element | null => {
    const live = deps.nodeFor(node.id);
    return live !== null && live.nodeType === 1 ? (live as Element) : null;
  };

  const frame = (node: SnParent, mode: Mode, live: Element | null, rect: PruneRect | null, maskText: boolean): Frame => ({
    node, mode, live, rect, style: undefined, maskText, index: 0, kept: [], anyVisible: false,
  });

  const styleOnce = (f: Frame): CSSStyleDeclaration | null => {
    if (f.style === undefined) f.style = f.live === null ? null : deps.styleOf(f.live);
    return f.style;
  };

  /** A blocked sensitive element (rrweb `rr_width`/`rr_height`) → black same-box placeholder, no class. */
  const maskBlocked = (node: SnElement, live: Element | null): Verdict => {
    result.masked = true;
    collectIds(node, result.hiddenIds);
    node.childNodes = [];
    if (live === null) {
      node.attributes = {
        style: `display:inline-block;width:${lengthAttr(node.attributes.rr_width)};height:${lengthAttr(node.attributes.rr_height)};background:#000`,
      };
      return 'hidden';
    }
    const rect = deps.rectOf(live);
    const style = deps.styleOf(live);
    const size = deps.sizeOf(live, rect);
    node.attributes = {
      style: style !== null
        ? placeholderStyle(style, size, true)
        : `display:inline-block;width:${px(size.width)};height:${px(size.height)};background:#000`,
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

  /** Post-order step: the frame's children are final; decide its own verdict. */
  const finish = (f: Frame): Verdict => {
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
    const live = f.live as Element;
    const rect = f.rect as PruneRect;
    if (intersects(rect)) return 'visible';
    if (f.mode === 'svg') {
      if (definesIds(node)) return 'visible';
    } else if (f.anyVisible) {
      return 'visible';
    }
    const style = styleOnce(f);
    // Inline boxes span line fragments and display:contents has no box, so
    // neither can be replaced by a same-box placeholder. <svg> roots and
    // replaced elements (img, video, …) are atomic boxes even when inline, so
    // they are pruned to an inline-block of the same size (rulings 8, S20).
    if (
      f.mode === 'judge' &&
      style !== null &&
      (style.display === 'contents' || (style.display === 'inline' && !isReplaced(node)))
    ) {
      return 'hidden';
    }
    result.pruned++;
    collectIds(node, result.hiddenIds);
    const outOfFlow = style === null || style.display === 'none' || style.position === 'absolute' || style.position === 'fixed';
    node.attributes = { style: outOfFlow ? 'display:none' : placeholderStyle(style, deps.sizeOf(live, rect), false) };
    node.childNodes = [];
    return 'hidden';
  };

  const settle = (parent: Frame, child: SnNode, verdict: Verdict): void => {
    if (verdict === 'remove') return;
    if (verdict === 'visible') parent.anyVisible = true;
    parent.kept.push(child);
  };

  const stack: Frame[] = [frame(root, 'root', null, null, false)];
  while (stack.length > 0) {
    const top = stack[stack.length - 1] as Frame;
    if (top.index < top.node.childNodes.length) {
      const child = top.node.childNodes[top.index++] as SnNode;
      if (child.type === SN_ELEMENT) {
        const entered = enter(child, top);
        if (typeof entered === 'string') settle(top, child, entered);
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
    const verdict = finish(top);
    const parent = stack[stack.length - 1];
    if (parent !== undefined) settle(parent, top.node, verdict);
  }
  return result;
}
