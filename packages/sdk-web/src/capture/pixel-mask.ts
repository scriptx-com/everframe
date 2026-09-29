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

function pushRects(out: ViewportRect[], list: ArrayLike<DOMRect>): void {
  for (let i = 0; i < list.length; i++) {
    const r = list[i]!;
    if (r.width > 0 && r.height > 0) out.push({ x: r.left, y: r.top, width: r.width, height: r.height });
  }
}

/** Every rendered box and text run of `node` and its flattened subtree. */
function coverSubtree(node: Node, out: ViewportRect[]): void {
  if (node.nodeType === 3) {
    const range = node.ownerDocument?.createRange?.();
    if (range && typeof range.getClientRects === 'function') {
      range.selectNodeContents(node);
      pushRects(out, range.getClientRects());
    } else if (node.parentElement) {
      // No Range geometry (non-browser environments): the parent's boxes.
      pushRects(out, node.parentElement.getClientRects());
    }
    return;
  }
  if (node.nodeType !== 1) return;
  const el = node as Element;
  // Per line box for inline elements; nothing for display:contents / slots
  // (their children are covered below).
  pushRects(out, el.getClientRects());
  // A sensitive video never renders; its frame is on the stand-in after it.
  if (el.tagName === 'VIDEO' && el.nextElementSibling?.hasAttribute(STAND_IN_ATTR)) {
    pushRects(out, el.nextElementSibling.getClientRects());
  }
  for (const child of renderedChildren(el)) coverSubtree(child, out);
}

/**
 * Viewport rects of every element under `root` (flattened tree: open shadow
 * roots and slot assignments followed) for which `isSensitive` holds, plus
 * everything rendered inside it. A sensitive root yields its full rect.
 */
export function collectSensitiveRects(
  root: Element,
  isSensitive: (el: Element) => boolean,
): ViewportRect[] {
  const out: ViewportRect[] = [];
  const judge = (el: Element): boolean => {
    try {
      return isSensitive(el);
    } catch {
      return true; // never unmask on an error
    }
  };
  const visit = (node: Node): void => {
    if (node.nodeType !== 1) return;
    const el = node as Element;
    if (judge(el)) {
      if (el === root) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) out.push({ x: r.left, y: r.top, width: r.width, height: r.height });
      }
      coverSubtree(el, out);
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
