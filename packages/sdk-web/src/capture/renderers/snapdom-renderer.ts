// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import { isCanvasBlank } from '../blank-check.js';

/**
 * Primary screenshot renderer (2026-09-29 benchmark, design doc
 * 2026-09-29-web-screenshot-capture-design.md): 2-25x faster than
 * modern-screenshot on desktop, no blank rasters where modern-screenshot
 * produced them, and `fast: false` yields to the page about once per frame
 * so the capture deadline can actually fire.
 *
 * `clip: 'viewport'` makes snapDOM prune off-screen styling and inlining and
 * return a viewport-sized canvas, which replaces the modern-screenshot
 * path's own pruning pre-pass, off-screen image skipping and clone-drift
 * crop. `filterMode: 'remove'` matches what modern-screenshot's filter did:
 * a filtered node contributes no layout box (videos are already
 * `display: none` behind their stand-ins; SDK chrome is portaled).
 */
export interface SnapdomRenderOptions {
  /** Effective (already capped) device pixel ratio for the output. */
  pixelRatio: number;
  /** Keep-predicate — false drops the node from the capture. */
  filter: (node: Node) => boolean;
}

/** Live scroll state of one scrolled element, captured before snapDOM starts. */
interface ScrollerState {
  left: number;
  top: number;
  /**
   * Per live element child: the full transform its clone gets (the scroll
   * translate composed with the child's own computed transform), or null
   * when the child does not scroll with the content (see childShift).
   */
  children: Map<Element, string | null>;
}

/**
 * Whether an element's computed style makes it the containing block of its
 * absolutely positioned descendants: a non-static position, or any of the
 * other containing-block creators (transform, perspective, filter,
 * backdrop-filter, layout/paint containment, container queries, and
 * will-change naming one of those).
 */
export function establishesAbsoluteContainingBlock(cs: CSSStyleDeclaration): boolean {
  if (cs.position && cs.position !== 'static') return true;
  return establishesFixedContainingBlock(cs);
}

/** The subset that also captures `position: fixed` descendants. */
function establishesFixedContainingBlock(cs: CSSStyleDeclaration): boolean {
  const set = (v: string | undefined): boolean => !!v && v !== 'none' && v !== 'normal';
  if (set(cs.transform) || set(cs.perspective) || set(cs.filter)) return true;
  // The individual transform properties create a containing block just like
  // `transform`, while the computed `transform` stays 'none'.
  const individual = cs as unknown as Record<string, string | undefined>;
  if (set(individual.translate) || set(individual.rotate) || set(individual.scale)) return true;
  const backdrop =
    (cs as unknown as Record<string, string | undefined>).backdropFilter ??
    (cs as unknown as Record<string, string | undefined>).webkitBackdropFilter;
  if (set(backdrop)) return true;
  const contain = cs.contain ?? '';
  if (/\b(layout|paint|strict|content)\b/.test(contain)) return true;
  const containerType = (cs as unknown as Record<string, string | undefined>).containerType ?? '';
  if (containerType && containerType !== 'normal') return true;
  const willChange = cs.willChange ?? '';
  return /\b(transform|translate|rotate|scale|perspective|filter|backdrop-filter|contain|position)\b/.test(willChange);
}

/**
 * The clone transform for one element child of a scrolled element, or null
 * when it must stay put:
 * - fixed / sticky children are re-placed by snapDOM itself from their LIVE
 *   rects (its freezeViewportPositioned pass), so they already show where the
 *   user saw them;
 * - an absolute child whose containing block is outside the scroller does
 *   not move when the scroller scrolls.
 */
function childShift(child: Element, scroller: CSSStyleDeclaration, left: number, top: number): string | null {
  const cs = getComputedStyle(child);
  const pos = cs.position;
  if (pos === 'fixed' || pos === 'sticky' || pos === '-webkit-sticky') return null;
  if (pos === 'absolute' && !establishesAbsoluteContainingBlock(scroller)) return null;
  const shift = `translate(${-left}px, ${-top}px)`;
  return cs.transform && cs.transform !== 'none' ? `${shift} ${cs.transform}` : shift;
}

/**
 * snapDOM clones carry no scroll offsets. snapDOM 3.2.0 has its own nested
 * scroll pass (`xo`, run in the clone step before any `afterClone` plugin):
 * it moves every scrolled clone's children into one `all:unset;
 * display:inline-block` wrapper translated by the scroll offset, and adds
 * the offset back onto the inline `top`/`left` of every descendant whose
 * inline position is absolute (fixed ones are turned absolute too). That
 * breaks three ways: the counter-offset leaves absolute content anchored
 * inside the scroller unscrolled; the inline-block wrapper collapses flex and
 * grid layouts (a horizontal carousel stacks vertically); and the lost child
 * count trips snapDOM's later shrink pass (filterMode 'remove'), which sets
 * a stylesheet-sized scroller to `height:auto; overflow:visible`, spilling
 * its rows over the content below.
 *
 * So the plugin undoes that pass — unwraps the wrapper and reverts the
 * counter-offsets — and restores each scroller once, itself, mirroring
 * modern-screenshot's restoreScrollPosition: every element child's clone
 * gets `translate(-left, -top)` composed with the child's live computed
 * transform (class transforms survive; only the classic `transform` property
 * is used, `translate` is missing on Chrome 79 / webOS 6).
 *
 * All state lives in memory for this one capture and clones are matched to
 * their live originals through snapDOM's `ctx.nodeMap` (clone -> source), so
 * overlapping or abandoned captures cannot see or disturb each other and the
 * live DOM is never written to.
 *
 * Limitations: direct text-node children of a scroller are not shifted; an
 * absolute element deeper in a shifted child whose containing block is
 * outside the scroller is shifted with that child.
 */
function collectScrollState(root: HTMLElement): Map<Element, ScrollerState> {
  const state = new Map<Element, ScrollerState>();
  // Document scrolling is what snapDOM's viewport clip itself follows; every
  // other scrolled element - INCLUDING the capture root, e.g. a <body> that
  // scrolls on its own under `html { overflow: hidden }`, whose scroll
  // snapDOM's clip mode never restores - is restored here.
  const docScroller = document.scrollingElement ?? document.documentElement;
  const skip = new Set<Element>([document.documentElement, docScroller]);
  for (const el of [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))]) {
    if (skip.has(el)) continue;
    const left = el.scrollLeft;
    const top = el.scrollTop;
    if (left === 0 && top === 0) continue;
    const scrollerStyle = getComputedStyle(el);
    const children = new Map<Element, string | null>();
    for (const child of Array.from(el.children)) {
      children.set(child, childShift(child, scrollerStyle, left, top));
    }
    state.set(el, { left, top, children });
  }
  return state;
}

/** snapDOM's scroll wrapper: the scroller clone's sole child node, a style-only div it created. */
function snapdomScrollWrapper(scrollerClone: Element, nodeMap: Map<Node, Node>): HTMLElement | null {
  const only = scrollerClone.childNodes.length === 1 ? scrollerClone.firstChild : null;
  if (!(only instanceof HTMLElement) || only.tagName !== 'DIV' || nodeMap.has(only)) return null;
  if (only.attributes.length !== 1 || !only.hasAttribute('style')) return null;
  return only.style.willChange === 'transform' && only.style.transform.startsWith('translate(') ? only : null;
}

/** Undo snapDOM's `xo` pass on one scroller clone: revert the counter-offsets, then unwrap. */
function undoSnapdomScroll(
  scrollerClone: Element,
  wrapper: HTMLElement,
  st: ScrollerState,
  nodeMap: Map<Node, Node>,
): void {
  for (const el of Array.from(wrapper.querySelectorAll<HTMLElement>('*'))) {
    const style = el.style;
    if (!style || style.position !== 'absolute') continue;
    const src = nodeMap.get(el) as HTMLElement | undefined;
    if (src?.style?.position === 'absolute' && getComputedStyle(src).position === 'absolute') {
      // An inline-absolute original: snapDOM's counter-offset was the only
      // change to these two properties, so restore them verbatim (keeps `auto`).
      style.top = src.style.top;
      style.left = src.style.left;
    } else {
      style.top = `${(parseFloat(style.top) || 0) - st.top}px`;
      style.left = `${(parseFloat(style.left) || 0) - st.left}px`;
    }
  }
  while (wrapper.firstChild) scrollerClone.insertBefore(wrapper.firstChild, wrapper);
  wrapper.remove();
}

interface AfterCloneContext {
  clone?: Element | null | undefined;
  /** snapDOM's clone -> live source map (typed `unknown`; a Map in 3.2.0, populated before `afterClone`). */
  nodeMap?: unknown;
}

function createScrollRestorePlugin(root: Element, state: Map<Element, ScrollerState>) {
  return {
    name: 'everframe-scroll-restore',
    afterClone(ctx: AfterCloneContext): void {
      if (!ctx.clone || !(ctx.nodeMap instanceof Map)) return;
      const nodeMap = ctx.nodeMap as Map<Node, Node>;
      const scrollers: Array<[Element, ScrollerState]> = [];
      for (const [clone, src] of nodeMap) {
        const st = state.get(src as Element);
        if (st && clone.nodeType === 1) scrollers.push([clone as Element, st]);
      }
      // A scrolled capture root whose clone snapDOM did not map.
      const rootState = state.get(root);
      if (rootState && !nodeMap.has(ctx.clone)) scrollers.push([ctx.clone, rootState]);
      for (const [scrollerClone, st] of scrollers) {
        const wrapper = snapdomScrollWrapper(scrollerClone, nodeMap);
        if (wrapper) undoSnapdomScroll(scrollerClone, wrapper, st, nodeMap);
        const plain = `translate(${-st.left}px, ${-st.top}px)`;
        for (const child of Array.from(scrollerClone.children) as HTMLElement[]) {
          const src = nodeMap.get(child) as Element | undefined;
          // Unmapped children are snapDOM's own in-flow stand-ins (e.g. the
          // placeholder holding a frozen sticky element's slot): they scroll.
          const transform = src ? st.children.get(src) : plain;
          if (transform && child.style) child.style.transform = transform;
        }
      }
    },
  };
}

/**
 * `clip: 'viewport'` sizes the canvas from documentElement.clientWidth/Height,
 * which EXCLUDES a classic (non-overlay) scrollbar. Callers - the reporter's
 * area-select math divides by innerWidth - expect exactly
 * innerWidth x innerHeight x ratio, as the old viewport crop produced. A
 * smaller canvas is copied onto a white canvas of that size at (0,0); an
 * equal or larger one (or no 2d context, e.g. jsdom) is returned unchanged.
 */
function padToViewport(canvas: HTMLCanvasElement, pixelRatio: number): HTMLCanvasElement {
  if (typeof window === 'undefined') return canvas;
  const targetW = Math.round(window.innerWidth * pixelRatio);
  const targetH = Math.round(window.innerHeight * pixelRatio);
  if (canvas.width >= targetW && canvas.height >= targetH) return canvas;
  const padded = document.createElement('canvas');
  padded.width = Math.max(targetW, canvas.width);
  padded.height = Math.max(targetH, canvas.height);
  const ctx = padded.getContext('2d');
  if (!ctx) return canvas;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, padded.width, padded.height);
  ctx.drawImage(canvas, 0, 0);
  return padded;
}

/** Viewport-sized snapDOM canvas plus its PRE-PADDING, PRE-MASK blank verdict. */
export interface SnapdomRenderResult {
  canvas: HTMLCanvasElement;
  /**
   * Whether the raw snapDOM raster was near-uniform, measured BEFORE
   * padToViewport adds a white scrollbar strip (a flat dark raster plus that
   * strip must still read as blank) and before any `maskPlan` painting.
   * An unavailable check (null) counts as not blank.
   */
  blank: boolean;
  /**
   * The capture root's viewport rect (CSS px), read synchronously right
   * before snapDOM started: where the root sits on this viewport-sized
   * canvas, so root-relative mask rects map onto it. snapDOM yields while
   * rendering, so a read after it settles may describe a different viewport.
   */
  rootLeft: number;
  rootTop: number;
}

export async function renderViewportWithSnapdom(
  root: HTMLElement,
  opts: SnapdomRenderOptions,
): Promise<SnapdomRenderResult> {
  const { snapdom } = await import('@zumer/snapdom');
  const scrollState = collectScrollState(root);
  const rootRect = root.getBoundingClientRect();
  try {
    const capture = await snapdom(root, {
      ...(scrollState.size > 0 ? { plugins: [createScrollRestorePlugin(root, scrollState)] } : {}),
      clip: 'viewport',
      fast: false,
      scale: 1,
      dpr: opts.pixelRatio,
      backgroundColor: '#ffffff',
      filter: (el: Element) => opts.filter(el),
      filterMode: 'remove',
      embedFonts: 'auto',
      // Clears snapDOM's per-element style snapshots on every capture (the
      // resource cache - fonts, images - is kept). Without it, a script edit
      // to an existing stylesheet rule (`rule.style.background = ...`) ships
      // the PREVIOUS capture's styling. Repeat-capture memoization is also
      // skipped today only because `filter` is a function - do not rely on
      // that; this flag is the explicit guarantee.
      invalidate: true,
    });
    const raw = await capture.toCanvas();
    const blank = isCanvasBlank(raw) === true;
    return {
      canvas: padToViewport(raw, opts.pixelRatio),
      blank,
      rootLeft: rootRect.left,
      rootTop: rootRect.top,
    };
  } finally {
    scrollState.clear();
  }
}
