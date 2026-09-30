// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import { STAND_IN_ATTR } from './video-frames.js';

/**
 * Second masking layer: paint the live viewport rects of everything
 * sensitive straight onto the rendered canvas, so nothing inside a sensitive
 * element's on-screen area can survive, whatever a renderer did with its
 * clone (duplicated nodes, strokes, slotted content, replaced elements).
 *
 * Read-only on the live page: rects come from getClientRects() and Range
 * rects; nothing is restyled.
 */

/** Mask targets plus the video stand-ins of sensitive videos (the video itself never renders). */
export function expandMaskTargets(targets: readonly Element[]): Element[] {
  const out = new Set<Element>(targets);
  for (const el of targets) {
    if (el.tagName !== 'VIDEO') continue;
    const next = el.nextElementSibling;
    if (next?.hasAttribute(STAND_IN_ATTR)) out.add(next);
  }
  return [...out];
}

export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Same safety inflation as the legacy rect painter (mask-paint.ts). */
const INFLATE_CSS_PX = 2;

/** The flattened (rendered) children of `node`: shadow trees and slot assignments followed. */
function renderedChildren(node: Element): Node[] {
  if (node.tagName === 'SLOT') {
    const assigned = (node as HTMLSlotElement).assignedNodes?.({ flatten: true }) ?? [];
    return assigned.length > 0 ? assigned : Array.from(node.childNodes);
  }
  const shadow = (node as HTMLElement).shadowRoot;
  return Array.from((shadow ?? node).childNodes);
}

/** A viewport-space clip box (edges; +-Infinity = unclipped on that side). */
interface Clip {
  l: number;
  t: number;
  r: number;
  b: number;
}

const UNCLIPPED: Clip = { l: -Infinity, t: -Infinity, r: Infinity, b: Infinity };

/** How far to grow rects on each side (CSS px). */
interface Grow {
  l: number;
  t: number;
  r: number;
  b: number;
}

const NO_GROW: Grow = { l: 0, t: 0, r: 0, b: 0 };

function pushRects(out: ViewportRect[], list: ArrayLike<DOMRect>, clip: Clip, grow: Grow = NO_GROW): void {
  for (let i = 0; i < list.length; i++) {
    const r = list[i]!;
    if (!(r.width > 0 && r.height > 0)) continue;
    const l = Math.max(r.left - grow.l, clip.l);
    const t = Math.max(r.top - grow.t, clip.t);
    const w = Math.min(r.left + r.width + grow.r, clip.r) - l;
    const h = Math.min(r.top + r.height + grow.b, clip.b) - t;
    if (w > 0 && h > 0) out.push({ x: l, y: t, width: w, height: h });
  }
}

/** overflow values that clip exactly at the box (`clip` may paint past it via overflow-clip-margin). */
const CLIPS = /^(hidden|auto|scroll|overlay)$/;

/**
 * The clip `el` imposes on its descendants, intersected with the one it is
 * under. Its border box is used (the padding box it really clips to is
 * inside it: over-masking by a border, never under-masking).
 */
function clipFor(el: Element, cs: CSSStyleDeclaration | null, outer: Clip): Clip {
  if (!cs) return outer;
  const clipX = CLIPS.test(cs.overflowX);
  const clipY = CLIPS.test(cs.overflowY);
  if (!clipX && !clipY) return outer;
  const r = el.getBoundingClientRect();
  return {
    l: clipX ? Math.max(outer.l, r.left) : outer.l,
    r: clipX ? Math.min(outer.r, r.left + r.width) : outer.r,
    t: clipY ? Math.max(outer.t, r.top) : outer.t,
    b: clipY ? Math.min(outer.b, r.top + r.height) : outer.b,
  };
}

/**
 * How far text paints past its line boxes on each side (CSS px): every
 * text-shadow's offset plus blur, and the text stroke. Those pixels are in
 * no client rect, and a shadow can sit far from its glyphs.
 */
function textInkOverflow(cs: CSSStyleDeclaration | null): Grow {
  if (!cs) return NO_GROW;
  const stroke = parseFloat(cs.getPropertyValue('-webkit-text-stroke-width')) || 0;
  const g = { l: stroke, t: stroke, r: stroke, b: stroke };
  const shadow = cs.getPropertyValue('text-shadow');
  if (shadow && shadow !== 'none') {
    // Colours first (their commas and numbers are not lengths), then one list per shadow.
    for (const one of shadow.replace(/[a-z-]*\([^)]*\)/gi, '').split(',')) {
      const [x = 0, y = 0, b = 0] = (one.match(/-?[\d.]+(?=px)/g) ?? []).map(Number);
      const blur = Math.abs(b);
      g.l = Math.max(g.l, blur - x);
      g.r = Math.max(g.r, blur + x);
      g.t = Math.max(g.t, blur - y);
      g.b = Math.max(g.b, blur + y);
    }
  }
  return g;
}

function styleOf(el: Element): CSSStyleDeclaration | null {
  try {
    return el.ownerDocument?.defaultView?.getComputedStyle(el) ?? null;
  } catch {
    return null;
  }
}

/**
 * Every rendered box and text run of `node` and its flattened subtree, each
 * clipped by the overflow clips between it and the sensitive element (the
 * sensitive element's own boxes are never clipped). An absolutely or fixed
 * positioned element may escape clips above it, so it drops them (fail
 * closed: larger, never smaller).
 */
function coverSubtree(node: Node, out: ViewportRect[], clip: Clip, excluded: (el: Element) => boolean): void {
  if (node.nodeType === 3) {
    // Text inherits along the flat tree: from its slot when it is slotted.
    const from = (node as Text).assignedSlot ?? node.parentElement;
    const grow = from ? textInkOverflow(styleOf(from)) : NO_GROW;
    const range = node.ownerDocument?.createRange?.();
    if (range && typeof range.getClientRects === 'function') {
      range.selectNodeContents(node);
      pushRects(out, range.getClientRects(), clip, grow);
    } else if (node.parentElement) {
      // No Range geometry (non-browser environments): the parent's boxes.
      pushRects(out, node.parentElement.getClientRects(), clip, grow);
    }
    return;
  }
  if (node.nodeType !== 1) return;
  const el = node as Element;
  if (excluded(el)) return; // the renderers never draw it
  const cs = styleOf(el);
  const own = cs && (cs.position === 'absolute' || cs.position === 'fixed') ? UNCLIPPED : clip;
  // Per line box for inline elements; nothing for display:contents / slots
  // (their children are covered below).
  pushRects(out, el.getClientRects(), own);
  // A sensitive video never renders; its frame is on the stand-in after it.
  if (el.tagName === 'VIDEO' && el.nextElementSibling?.hasAttribute(STAND_IN_ATTR)) {
    pushRects(out, el.nextElementSibling.getClientRects(), own);
  }
  const inner = clipFor(el, cs, own);
  for (const child of renderedChildren(el)) coverSubtree(child, out, inner, excluded);
}

/**
 * Viewport rects of every element under `root` (flattened tree: open shadow
 * roots and slot assignments followed) for which `isSensitive` holds, plus
 * everything rendered inside it. A sensitive root yields its full rect.
 * Subtrees `isExcluded` holds for (what the renderers leave out) are skipped.
 */
export function collectSensitiveRects(
  root: Element,
  isSensitive: (el: Element) => boolean,
  isExcluded: (el: Element) => boolean = () => false,
): ViewportRect[] {
  const out: ViewportRect[] = [];
  const judge = (el: Element): boolean => {
    try {
      return isSensitive(el);
    } catch {
      return true; // never unmask on an error
    }
  };
  const excluded = (el: Element): boolean => {
    try {
      return isExcluded(el);
    } catch {
      return false; // never unmask on an error
    }
  };
  const visit = (node: Node): void => {
    if (node.nodeType !== 1) return;
    const el = node as Element;
    // Excluded from the capture (the SDK's own chrome): nothing of it is
    // rendered, so nothing of it is painted over the page beneath.
    if (el !== root && excluded(el)) return;
    if (judge(el)) {
      if (el === root) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) out.push({ x: r.left, y: r.top, width: r.width, height: r.height });
      }
      coverSubtree(el, out, UNCLIPPED, (e) => e !== root && excluded(e));
      return;
    }
    for (const child of renderedChildren(el)) visit(child);
  };
  visit(root);
  return out;
}

/** True when the two rect lists differ by more than half a CSS pixel anywhere. */
export function rectsMoved(a: readonly ViewportRect[], b: readonly ViewportRect[]): boolean {
  if (a.length !== b.length) return true;
  return a.some(
    (r, i) =>
      Math.abs(r.x - b[i]!.x) > 0.5 ||
      Math.abs(r.y - b[i]!.y) > 0.5 ||
      Math.abs(r.width - b[i]!.width) > 0.5 ||
      Math.abs(r.height - b[i]!.height) > 0.5,
  );
}

/**
 * Where viewport content lands on a renderer's canvas: a viewport point
 * (x, y) in CSS px is drawn at ((x + dx) * ratio, (y + dy) * ratio). A
 * renderer that cannot place everything at one offset lists every candidate;
 * each rect is painted at all of them (fail closed).
 */
export interface CanvasOffset {
  dx: number;
  dy: number;
}

export const VIEWPORT_ALIGNED: readonly CanvasOffset[] = [{ dx: 0, dy: 0 }];

/**
 * Paint `rects` (viewport CSS px) opaque black on a canvas rendered at
 * `pixelRatio`, at every offset in `offsets`, each rect inflated by 2 CSS px;
 * the canvas clips. Returns false when there is something to paint but the
 * canvas has no 2d context (the caller must not ship it then).
 */
export function paintViewportRects(
  canvas: HTMLCanvasElement,
  rects: readonly ViewportRect[],
  pixelRatio: number,
  offsets: readonly CanvasOffset[] = VIEWPORT_ALIGNED,
): boolean {
  if (rects.length === 0) return true;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext('2d');
  } catch {
    return false;
  }
  if (!ctx) return false;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.fillStyle = '#000000';
  for (const { dx, dy } of offsets) {
    for (const r of rects) {
      // Outward-rounded device px: a fractional edge must not leave a
      // half-covered (anti-aliased) glyph column.
      const x0 = Math.floor((r.x + dx - INFLATE_CSS_PX) * pixelRatio);
      const y0 = Math.floor((r.y + dy - INFLATE_CSS_PX) * pixelRatio);
      const x1 = Math.ceil((r.x + dx + r.width + INFLATE_CSS_PX) * pixelRatio);
      const y1 = Math.ceil((r.y + dy + r.height + INFLATE_CSS_PX) * pixelRatio);
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
  }
  ctx.restore();
  return true;
}
