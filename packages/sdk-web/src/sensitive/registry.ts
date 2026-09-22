// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import type { Rect } from '@traceitx/sdk-core';

/**
 * Registry of "sensitive" elements — pixels under their bounding rects are blanked at
 * capture time (PRIV-02 / PRIV-03). Two API surfaces feed this registry:
 *   1. data-traceitx-sensitive HTML attribute — DOM scan at snapshot time
 *   2. addRef(el) — programmatic add, either directly (the framework-free path
 *      `@traceitx/web` exports as `sensitiveRegistry`) or through
 *      `@traceitx/react`'s <Sensitive>{children}</Sensitive> wrapper, which is
 *      a JSX shell over the same call.
 *
 * NOT a feed: `useTraceItX().markSensitive(ref)`. sdk-core's method of that
 * name is a no-op and has never reached this registry; it is listed here only
 * so the next reader does not go looking for the wiring.
 *
 * Snapshot returns absolute-positioned (window-coordinate) rects from getBoundingClientRect.
 * Zero-size rects (display:none, unmounted) are skipped — they leak no pixels and would
 * pollute the canvas mask plan downstream (plan 06).
 */
interface SensitiveRegistry {
  addRef(el: Element): void;
  removeRef(el: Element): void;
  snapshot(): Rect[];
  /**
   * Element-level counterpart of `snapshot()`. Returns the actual DOM nodes
   * (not rects) so callers can mask the content directly on the live DOM
   * before capture, avoiding the coordinate-transform fragility of post-
   * capture rect painting. Dedup semantics match `snapshot()`.
   */
  snapshotElements(): Element[];
  __clearForTesting(): void;
}

export const SENSITIVE_ATTR = 'data-traceitx-sensitive';

function isContentsBox(el: Element): boolean {
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
    return false;
  }
  try {
    return window.getComputedStyle(el).display === 'contents';
  } catch {
    return false;
  }
}

/**
 * Apply an inline-style mask to each element so the captured PNG renders them
 * as solid-black boxes — content is invisible and the element's layout box is
 * preserved (no reflow, no layout shift). Returns a callback that restores
 * the original `style` attribute on every element it touched. Call it in a
 * `finally` block around your capture pipeline so a thrown capture still
 * restores the live DOM.
 *
 * Why this approach: post-capture rect painting requires converting viewport
 * CSS pixels → root-relative device pixels, and the math is brittle (subpixel
 * rounding, font-metric drift between the live DOM and the cloned
 * render, modal-open layout shifts). Masking on the live DOM lets the capture
 * library handle the coordinate transform natively — the masked element ends
 * up at the right spot in the PNG by construction.
 *
 * Visual flash risk: the SDK is invoked while the reporter modal is open. The
 * modal backdrop is `position: fixed; inset: 0` at the topmost z-index, so any
 * brief paint of the underlying DOM is hidden from the user.
 */
export function applyDomMask(elements: Element[]): () => void {
  const restores: Array<() => void> = [];
  // Hex black for everything that has a visible surface. Using `!important`
  // here is necessary because customer apps often have `!important` rules on
  // typography or input chrome that would otherwise outrank inline style.
  const maskStyle = [
    'background-color: #000 !important',
    'background-image: none !important',
    'color: transparent !important',
    '-webkit-text-fill-color: transparent !important',
    'text-shadow: none !important',
    'border-color: #000 !important',
    'caret-color: transparent !important',
    // Hide background-image-derived content like avatars, charts etc.
    // `filter` on its own would tint child elements too; combine with
    // background-color to render a solid block.
  ].join('; ');
  for (const el of elements) {
    const html = el as HTMLElement;
    if (typeof html.setAttribute !== 'function') continue;
    const prevStyleAttr = html.getAttribute('style');
    const merged = prevStyleAttr ? `${prevStyleAttr}; ${maskStyle}` : maskStyle;
    try {
      html.setAttribute('style', merged);
    } catch {
      continue;
    }
    restores.push(() => {
      try {
        if (prevStyleAttr === null) html.removeAttribute('style');
        else html.setAttribute('style', prevStyleAttr);
      } catch {
        /* swallow — element may have been removed mid-capture */
      }
    });
  }
  return () => {
    for (const r of restores) r();
  };
}

function rectFromEl(el: Element): Rect | null {
  if (typeof el.getBoundingClientRect !== 'function') return null;
  // `<Sensitive>` defaults to `display: contents` so the wrapper generates no
  // layout box. Per spec its bounding rect should be 0x0, but some browsers
  // (observed on mobile Safari) return the rect of the FIRST inline fragment
  // instead — which silently truncates multi-line block children's mask
  // coverage. Detect display:contents via getComputedStyle and ALWAYS take
  // the children-union path in that case, regardless of what
  // getBoundingClientRect reports.
  if (!isContentsBox(el)) {
    const own = el.getBoundingClientRect();
    if (own.width > 0 || own.height > 0) {
      return { x: own.x, y: own.y, width: own.width, height: own.height };
    }
  }
  // display:contents (or zero-size wrapper) — fallback chain:
  //   1. Union the direct children's own bounding rects. Accurate for block-
  //      level children (<p>, <div>, <input>): each child rect includes the
  //      FULL block box, all wrapped lines.
  //   2. Range.selectNodeContents — only reached if children are text-only
  //      with no Element wrappers. Range measures inline content boundaries,
  //      right for text but truncates multi-line block content.
  const childRect = unionChildRects(el);
  if (childRect !== null) return childRect;
  if (typeof document !== 'undefined' && typeof document.createRange === 'function') {
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const r = range.getBoundingClientRect();
      range.detach?.();
      if (r.width > 0 || r.height > 0) {
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }
    } catch {
      /* fall through — un-mounted / cross-doc nodes */
    }
  }
  return null;
}

/**
 * Union the bounding rects of `el`'s direct Element children. Returns null if
 * there are no Element children OR every child has a zero-size rect (e.g.,
 * itself `display: contents`). Recurses into nested display:contents wrappers
 * so wrapping <Sensitive><Sensitive><p/></Sensitive></Sensitive> still works.
 */
function unionChildRects(el: Element): Rect | null {
  let minLeft = Infinity;
  let minTop = Infinity;
  let maxRight = -Infinity;
  let maxBottom = -Infinity;
  let any = false;
  for (const child of Array.from(el.children)) {
    if (typeof (child as Element).getBoundingClientRect !== 'function') continue;
    const r = (child as Element).getBoundingClientRect();
    let left = r.left;
    let top = r.top;
    let right = r.right;
    let bottom = r.bottom;
    // Child is also display:contents — recurse so its own children's rects
    // bubble up. Without this, a doubly-wrapped Sensitive would leak pixels.
    if (r.width === 0 && r.height === 0) {
      const inner = unionChildRects(child as Element);
      if (inner === null) continue;
      left = inner.x;
      top = inner.y;
      right = inner.x + inner.width;
      bottom = inner.y + inner.height;
    }
    any = true;
    if (left < minLeft) minLeft = left;
    if (top < minTop) minTop = top;
    if (right > maxRight) maxRight = right;
    if (bottom > maxBottom) maxBottom = bottom;
  }
  if (!any) return null;
  return {
    x: minLeft,
    y: minTop,
    width: maxRight - minLeft,
    height: maxBottom - minTop,
  };
}

function createSensitiveRegistry(): SensitiveRegistry {
  const refs = new Set<Element>();

  return {
    addRef(el: Element) {
      refs.add(el);
    },
    removeRef(el: Element) {
      refs.delete(el);
    },
    snapshot(): Rect[] {
      const out: Rect[] = [];
      // (1) explicit refs (addRef, directly or via React's <Sensitive>)
      for (const el of refs) {
        const r = rectFromEl(el);
        if (r) out.push(r);
      }
      if (typeof document !== 'undefined') {
        // (2) data-traceitx-sensitive scan
        for (const el of Array.from(document.querySelectorAll(`[${SENSITIVE_ATTR}]`))) {
          if (refs.has(el)) continue; // dedupe — already covered by explicit refs
          const r = rectFromEl(el);
          if (r) out.push(r);
        }
        // (3) Auto-mask: `<input type="password">` — PRIV-01 default-deny.
        // Password inputs are NEVER captured as readable pixels even when the
        // app developer forgets to wrap them in <Sensitive>. The visible bullets
        // are arguably harmless, but the underlying value is in the cloned DOM
        // that the screenshot renderer sees, and some browsers render the masked text
        // (e.g. autofill flash) — blanking the rect is the only defence.
        for (const el of Array.from(
          document.querySelectorAll<HTMLInputElement>('input[type="password"]'),
        )) {
          if (refs.has(el)) continue;
          if (el.closest(`[${SENSITIVE_ATTR}]`) !== null) continue; // already covered
          const r = rectFromEl(el);
          if (r) out.push(r);
        }
      }
      return out;
    },
    snapshotElements(): Element[] {
      const out: Element[] = [];
      const seen = new Set<Element>();
      const add = (el: Element): void => {
        if (seen.has(el)) return;
        seen.add(el);
        // `<Sensitive>` defaults to `display: contents` — the wrapper renders
        // no box, so applying `background-color` to it has no visual effect.
        // Walk into the children (recursively) and mask the actual rendered
        // boxes instead.
        if (isContentsBox(el)) {
          for (const child of Array.from(el.children)) add(child);
          return;
        }
        out.push(el);
      };
      // (1) explicit refs
      for (const el of refs) add(el);
      if (typeof document !== 'undefined') {
        // (2) data-traceitx-sensitive scan
        for (const el of Array.from(document.querySelectorAll(`[${SENSITIVE_ATTR}]`))) {
          if (refs.has(el)) continue;
          add(el);
        }
        // (3) Auto-mask password inputs (PRIV-01)
        for (const el of Array.from(
          document.querySelectorAll<HTMLInputElement>('input[type="password"]'),
        )) {
          if (refs.has(el)) continue;
          if (el.closest(`[${SENSITIVE_ATTR}]`) !== null) continue;
          add(el);
        }
      }
      return out;
    },
    __clearForTesting() {
      refs.clear();
    },
  };
}

export const sensitiveRegistry: SensitiveRegistry = createSensitiveRegistry();
