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
  /**
   * How long to wait for a previous, still-running snapDOM capture before
   * giving up with SnapdomBusyError (default 0: fail at once). See
   * renderViewportWithSnapdom.
   */
  busyWaitMs?: number;
}

/** Scroll state of one scrolled element, read from the live DOM. */
interface ScrollerState {
  left: number;
  top: number;
  /**
   * Per live element child: the full transform its clone gets (the scroll
   * translate composed with the child's own individual transforms and
   * computed transform), or null when the child does not scroll with the
   * content (see childShift).
   */
  children: Map<Element, ChildShift | null>;
  /** Absolute descendants re-pinned on the clone (see rebaseAbsoluteDescendants). */
  rebase: Map<Element, Rebase>;
}

interface ChildShift {
  transform: string;
  /** The child's individual translate/rotate/scale were folded into `transform`: reset them on the clone. */
  foldedIndividual: boolean;
}

/** Border-box geometry (CSS px) relative to the new containing block's padding box. */
interface Rebase {
  top: number;
  left: number;
  width: number;
  height: number;
}

const INDIVIDUAL = (cs: CSSStyleDeclaration): Record<'translate' | 'rotate' | 'scale', string | undefined> => {
  const r = cs as unknown as Record<string, string | undefined>;
  return { translate: r.translate, rotate: r.rotate, scale: r.scale };
};

/** Split on whitespace OUTSIDE parentheses: `calc(50% + 10px) 5px` -> 2 parts. */
function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value.trim()) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && /\s/.test(ch)) {
      if (current) parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * The individual transform properties (`translate`, `rotate`, `scale` - in
 * that order, per CSS Transforms 2) as transform functions; '' when all are
 * unset, null when a value has a shape this cannot map. Computed values:
 * translate `x [y [z]]`, rotate `angle` / `axis angle` / `x y z angle`,
 * scale `x [y [z]]`; components may be calc() expressions.
 */
export function individualTransformFunctions(values: {
  translate?: string | undefined;
  rotate?: string | undefined;
  scale?: string | undefined;
}): string | null {
  const set = (v: string | undefined): v is string => !!v && v !== 'none';
  const parts: string[] = [];
  if (set(values.translate)) {
    const t = splitTopLevel(values.translate);
    if (t.length < 1 || t.length > 3) return null;
    parts.push(t.length === 3 ? `translate3d(${t.join(', ')})` : `translate(${t.join(', ')})`);
  }
  if (set(values.rotate)) {
    const r = splitTopLevel(values.rotate);
    if (r.length === 1) parts.push(`rotate(${r[0]})`);
    else if (r.length === 2 && /^[xyz]$/i.test(r[0]!)) parts.push(`rotate${r[0]!.toUpperCase()}(${r[1]})`);
    else if (r.length === 4) parts.push(`rotate3d(${r.join(', ')})`);
    else return null;
  }
  if (set(values.scale)) {
    const sc = splitTopLevel(values.scale);
    if (sc.length < 1 || sc.length > 3) return null;
    parts.push(sc.length === 3 ? `scale3d(${sc.join(', ')})` : `scale(${sc.join(', ')})`);
  }
  return parts.join(' ');
}

/** Whether the engine accepts `value` as a transform (true when it cannot tell). */
function isValidTransform(value: string): boolean {
  try {
    return typeof CSS === 'undefined' || typeof CSS.supports !== 'function' || CSS.supports('transform', value);
  } catch {
    return true;
  }
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
function childShift(child: Element, scroller: CSSStyleDeclaration, left: number, top: number): ChildShift | null {
  const cs = getComputedStyle(child);
  const pos = cs.position;
  if (pos === 'fixed' || pos === 'sticky' || pos === '-webkit-sticky') return null;
  if (pos === 'absolute' && !establishesAbsoluteContainingBlock(scroller)) return null;
  // Effective matrix = translate · rotate · scale · transform. Left on the
  // clone, the individual properties would apply BEFORE (outside) our
  // injected scroll translate and scale/rotate it (scale:2 turns a -100px
  // scroll into -200px), so they are folded in after it and reset on the
  // clone - but only when the composed string is valid: a rejected transform
  // would drop the whole shift, so otherwise they are left untouched.
  const shift = `translate(${-left}px, ${-top}px)`;
  const own = cs.transform && cs.transform !== 'none' ? ` ${cs.transform}` : '';
  const individual = individualTransformFunctions(INDIVIDUAL(cs));
  if (individual) {
    const folded = `${shift} ${individual}${own}`;
    if (isValidTransform(folded)) return { transform: folded, foldedIndividual: true };
  }
  return { transform: `${shift}${own}`, foldedIndividual: false };
}

/** Nearest ancestor that is the containing block of an absolutely positioned `el`. */
function absoluteContainingBlock(el: Element): Element | null {
  for (let a = el.parentElement; a; a = a.parentElement) {
    if (establishesAbsoluteContainingBlock(getComputedStyle(a))) return a;
  }
  return null;
}

/**
 * A transform on a scroller's static child makes that child the containing
 * block of every absolute descendant that was anchored to the SCROLLER, so
 * those would re-anchor to the child and move by its offset. Their border
 * boxes are recorded here relative to the child's padding box and pinned on
 * the clone (top/left/width/height, margins zeroed) so the geometry is
 * unchanged; the child's scroll translate then moves them with the content,
 * exactly as live.
 */
function rebaseAbsoluteDescendants(scroller: Element, child: Element, out: Map<Element, Rebase>): void {
  if (!(child instanceof HTMLElement) || establishesAbsoluteContainingBlock(getComputedStyle(child))) return;
  for (const el of Array.from(child.querySelectorAll<HTMLElement>('*'))) {
    if (getComputedStyle(el).position !== 'absolute') continue;
    if (absoluteContainingBlock(el) !== scroller || el.offsetParent !== child.offsetParent) continue;
    out.set(el, {
      top: el.offsetTop - child.offsetTop - child.clientTop,
      left: el.offsetLeft - child.offsetLeft - child.clientLeft,
      width: el.offsetWidth,
      height: el.offsetHeight,
    });
  }
}

/** Live scroll state of `el` at scroll offset (left, top). */
function scrollerState(el: Element, left: number, top: number): ScrollerState {
  const scrollerStyle = getComputedStyle(el);
  const children = new Map<Element, ChildShift | null>();
  const rebase = new Map<Element, Rebase>();
  const scrollerIsBlock = establishesAbsoluteContainingBlock(scrollerStyle);
  for (const child of Array.from(el.children)) {
    const shift = childShift(child, scrollerStyle, left, top);
    children.set(child, shift);
    if (shift && scrollerIsBlock) rebaseAbsoluteDescendants(el, child, rebase);
  }
  return { left, top, children, rebase };
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
 * So the plugin undoes that pass wherever its wrapper is present in the
 * clone - found structurally, so a scroller that only started scrolling
 * while the capture yielded is normalized too - and restores each scroller
 * once, itself, mirroring modern-screenshot's restoreScrollPosition: every
 * element child's clone gets `translate(-left, -top)` composed with the
 * child's live transforms (class transforms survive; the classic `transform`
 * property carries it all, `translate` is missing on Chrome 79 / webOS 6).
 *
 * Clones are matched to their live originals through snapDOM's `ctx.nodeMap`
 * (clone -> source); the live DOM is never written to.
 *
 * Limitations: direct text-node children of a scroller are not shifted; an
 * absolute element deeper in a shifted child whose containing block is
 * OUTSIDE the scroller is shifted with that child.
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
    state.set(el, scrollerState(el, left, top));
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

/** The scroll offset snapDOM applied: parsed off its wrapper's `translate(-L px, -T px)`. */
function wrapperOffset(wrapper: HTMLElement): { left: number; top: number } | null {
  const m = /^translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)$/.exec(wrapper.style.transform.trim());
  return m ? { left: -Number(m[1]), top: -Number(m[2]) } : null;
}

/** Undo snapDOM's `xo` pass on one scroller clone: revert the counter-offsets it added, then unwrap. */
function undoSnapdomScroll(
  scrollerClone: Element,
  wrapper: HTMLElement,
  offset: { left: number; top: number },
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
      style.top = `${(parseFloat(style.top) || 0) - offset.top}px`;
      style.left = `${(parseFloat(style.left) || 0) - offset.left}px`;
    }
  }
  while (wrapper.firstChild) scrollerClone.insertBefore(wrapper.firstChild, wrapper);
  wrapper.remove();
}

/** Apply one scroller's restoration to its (unwrapped) clone. */
function restoreScroller(scrollerClone: Element, st: ScrollerState, nodeMap: Map<Node, Node>): void {
  const plain = `translate(${-st.left}px, ${-st.top}px)`;
  for (const child of Array.from(scrollerClone.children) as HTMLElement[]) {
    const src = nodeMap.get(child) as Element | undefined;
    // Unmapped children are snapDOM's own in-flow stand-ins (e.g. the
    // placeholder holding a frozen sticky element's slot): they scroll.
    const shift = src ? st.children.get(src) : { transform: plain, foldedIndividual: false };
    if (!shift || !child.style) continue;
    child.style.transform = shift.transform;
    if (shift.foldedIndividual) {
      child.style.setProperty('translate', 'none');
      child.style.setProperty('rotate', 'none');
      child.style.setProperty('scale', 'none');
    }
  }
  if (st.rebase.size === 0) return;
  for (const [clone, src] of nodeMap) {
    const box = st.rebase.get(src as Element);
    const style = (clone as HTMLElement).style;
    if (!box || !style) continue;
    style.top = `${box.top}px`;
    style.left = `${box.left}px`;
    style.right = 'auto';
    style.bottom = 'auto';
    style.width = `${box.width}px`;
    style.height = `${box.height}px`;
    style.boxSizing = 'border-box';
    style.margin = '0';
  }
}

interface AfterCloneContext {
  clone?: Element | null | undefined;
  /** snapDOM's clone -> live source map (typed `unknown`; a Map in 3.2.0, populated before `afterClone`). */
  nodeMap?: unknown;
}

function createScrollRestorePlugin(root: Element, state: Map<Element, ScrollerState>) {
  /** Restored scroller clones and their live used size, re-pinned in beforeRender. */
  const pinned: Array<[HTMLElement, { width: string; height: string }]> = [];
  return {
    name: 'everframe-scroll-restore',
    /**
     * snapDOM's shrink pass (filterMode 'remove') runs between afterClone and
     * beforeRender: it sees a source with more element children than its
     * clone - which a scroller still is when snapDOM lifted a position:fixed
     * child out of it - and sets the clone to `height:auto; overflow:visible`,
     * spilling its content over the page below. The scroller's live size and
     * clipping are put back here, after that pass.
     */
    beforeRender(): void {
      for (const [el, size] of pinned) {
        el.style.width = size.width;
        el.style.height = size.height;
        el.style.overflow = 'hidden';
      }
    },
    afterClone(ctx: AfterCloneContext): void {
      if (!ctx.clone || !(ctx.nodeMap instanceof Map)) return;
      const nodeMap = ctx.nodeMap as Map<Node, Node>;
      const todo: Array<[Element, ScrollerState]> = [];
      for (const [clone, src] of nodeMap) {
        if (clone.nodeType !== 1) continue;
        const el = clone as Element;
        let st = state.get(src as Element);
        const wrapper = snapdomScrollWrapper(el, nodeMap);
        if (wrapper) {
          const offset = wrapperOffset(wrapper) ?? {
            left: (src as Element).scrollLeft,
            top: (src as Element).scrollTop,
          };
          undoSnapdomScroll(el, wrapper, offset, nodeMap);
          // Scrolled only after the capture started: restore it at the offset
          // snapDOM used, with the child styles read now.
          st ??= scrollerState(src as Element, offset.left, offset.top);
        }
        if (st) todo.push([el, st]);
      }
      // A scrolled capture root whose clone snapDOM did not map.
      const rootState = state.get(root);
      if (rootState && !nodeMap.has(ctx.clone)) todo.push([ctx.clone, rootState]);
      for (const [el, st] of todo) {
        restoreScroller(el, st, nodeMap);
        const src = nodeMap.get(el) ?? (el === ctx.clone ? root : undefined);
        if (el instanceof HTMLElement && src instanceof Element) {
          const cs = getComputedStyle(src);
          pinned.push([el, { width: cs.width, height: cs.height }]);
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

/** A previous snapDOM capture is still running (see renderViewportWithSnapdom). */
export class SnapdomBusyError extends Error {}

/** The running snapDOM capture, settled only when snapDOM's own work has finished. */
let inflight: Promise<void> | null = null;

/**
 * snapDOM captures never overlap. snapDOM rewrites the LIVE page while it
 * clones (ellipsized text, scroll wrappers are read from it) and restores it
 * afterwards; two interleaved runs can restore each other's rewrites - e.g.
 * permanently truncate text. A capture therefore waits up to `busyWaitMs`
 * for a running one - including one its caller abandoned on the deadline,
 * which keeps running until snapDOM settles - and then fails with
 * SnapdomBusyError without starting snapDOM.
 */
export async function renderViewportWithSnapdom(
  root: HTMLElement,
  opts: SnapdomRenderOptions,
): Promise<SnapdomRenderResult> {
  const until = Date.now() + (opts.busyWaitMs ?? 0);
  while (inflight) {
    const remaining = until - Date.now();
    if (remaining <= 0) throw new SnapdomBusyError('a previous snapDOM capture is still running');
    const current = inflight;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, remaining);
      void current.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  // Claimed synchronously after the loop: no await between seeing the slot
  // free and taking it.
  const run = runSnapdom(root, opts);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  inflight = settled;
  void settled.then(() => {
    if (inflight === settled) inflight = null;
  });
  return run;
}

async function runSnapdom(root: HTMLElement, opts: SnapdomRenderOptions): Promise<SnapdomRenderResult> {
  const { snapdom } = await import('@zumer/snapdom');
  const scrollState = collectScrollState(root);
  const rootRect = root.getBoundingClientRect();
  try {
    const capture = await snapdom(root, {
      // Always installed: it also normalizes scrollers that start scrolling mid-capture.
      plugins: [createScrollRestorePlugin(root, scrollState)],
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
