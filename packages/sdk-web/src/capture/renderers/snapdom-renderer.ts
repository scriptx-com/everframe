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

/** Live-DOM attribute on a scrolled element: `<token>|<id>|<scrollLeft>|<scrollTop>`. */
export const SCROLLER_ATTR = 'data-everframe-scroller';
/** Live-DOM attribute on a scrolled element's element child: `<token>|<id>|<transform>`. */
export const SCROLL_ATTR = 'data-everframe-scroll';
/** Live-DOM attribute on an inline `position:absolute` descendant: `<token>|<json>`. */
export const SCROLL_ABS_ATTR = 'data-everframe-scroll-abs';

const ALL_SCROLL_ATTRS = [SCROLLER_ATTR, SCROLL_ATTR, SCROLL_ABS_ATTR] as const;

/** Per inline-absolute descendant: its original inline offsets + every scrolled ancestor. */
interface AbsTag {
  top: string;
  left: string;
  /** [scroller id, scrollLeft, scrollTop, 1 when that scroller's snapDOM offset is wrong for it]. */
  s: Array<[number, number, number, 0 | 1]>;
}

/**
 * snapDOM 3.2.0 restores nested scroll ITSELF (its internal `xo` pass, run in
 * the clone step before any `afterClone` plugin): for every scrolled element
 * except the capture root it moves all of the clone's children into an
 * `all:unset` wrapper div carrying `transform: translate(-left, -top)`, and
 * adds `+left`/`+top` to the inline `left`/`top` of every descendant whose
 * INLINE style says `position: absolute|fixed` (to keep elements anchored
 * outside the scroller in place). That is right for in-flow content, but the
 * counter-offset is wrong for an absolute element whose containing block is
 * the scroller or lies inside it — that element must scroll with the content,
 * yet ends up rendered unscrolled.
 *
 * Exactly one restoration per scroller:
 * - where the clone shows snapDOM's wrapper, snapDOM's shift is kept and the
 *   plugin only reverts the counter-offset on inline-absolute descendants
 *   whose containing block is the scroller or inside it;
 * - where it does not (a future snapDOM that stops wrapping, a non-HTML
 *   clone), the plugin falls back to its own restoration, mirroring
 *   modern-screenshot's restoreScrollPosition: each element child gets its
 *   fully composed transform (`translate(-left, -top)` followed by the child's
 *   live computed transform, so class transforms survive). Only the classic
 *   `transform` property is used (`translate` is missing on Chrome 79 / webOS 6).
 *
 * Each capture stamps its tags with a unique token. The clone plugin applies
 * only its own token's tags and strips foreign ones from the CLONE (a tag left
 * on the live DOM by an abandoned, never-settled capture must not shift
 * anything); cleanup removes only live tags still carrying its token, so a
 * late settle of an abandoned capture cannot strip a newer capture's tags.
 *
 * Limitations: direct text-node children of a scroller are not shifted on the
 * fallback path; the containing block is approximated as the nearest ancestor
 * with a non-static position or a transform.
 */
function tagScrollState(root: HTMLElement, token: string): HTMLElement[] {
  const tagged: HTMLElement[] = [];
  const skip = new Set<Element>([root, document.documentElement, document.body]);
  const all = Array.from(root.querySelectorAll<HTMLElement>('*'));
  const scrollers = new Map<Element, [number, number, number]>();
  for (const el of all) {
    if (skip.has(el)) continue;
    const left = el.scrollLeft;
    const top = el.scrollTop;
    if (left === 0 && top === 0) continue;
    const id = scrollers.size;
    scrollers.set(el, [id, left, top]);
    el.setAttribute(SCROLLER_ATTR, `${token}|${id}|${left}|${top}`);
    tagged.push(el);
    for (const child of Array.from(el.children) as HTMLElement[]) {
      const computed = getComputedStyle(child).transform;
      const shift = `translate(${-left}px, ${-top}px)`;
      const transform = computed && computed !== 'none' ? `${shift} ${computed}` : shift;
      child.setAttribute(SCROLL_ATTR, `${token}|${id}|${transform}`);
      tagged.push(child);
    }
  }
  if (scrollers.size === 0) return tagged;
  for (const el of all) {
    if (el.style?.position !== 'absolute') continue;
    const cb = containingBlock(el, root);
    const s: AbsTag['s'] = [];
    for (let a = el.parentElement; a && a !== root; a = a.parentElement) {
      const info = scrollers.get(a);
      if (!info) continue;
      const wrong = cb !== null && (cb === a || a.contains(cb)) ? 1 : 0;
      s.push([info[0], info[1], info[2], wrong]);
    }
    if (!s.some((entry) => entry[3] === 1)) continue;
    const tag: AbsTag = { top: el.style.top, left: el.style.left, s };
    el.setAttribute(SCROLL_ABS_ATTR, `${token}|${JSON.stringify(tag)}`);
    tagged.push(el);
  }
  return tagged;
}

/** Nearest ancestor that establishes an absolute containing block (approximation). */
function containingBlock(el: HTMLElement, root: HTMLElement): Element | null {
  for (let a = el.parentElement; a; a = a.parentElement) {
    const cs = getComputedStyle(a);
    if (cs.position !== 'static' || (cs.transform && cs.transform !== 'none')) return a;
    if (a === root) return null;
  }
  return null;
}

/** snapDOM's scroll wrapper: the scroller's sole child, an attribute-less (style-only) div. */
function hasSnapdomScrollWrapper(scroller: Element): boolean {
  const only = scroller.childNodes.length === 1 ? scroller.firstChild : null;
  if (!(only instanceof HTMLElement) || only.tagName !== 'DIV') return false;
  if (only.attributes.length !== 1 || !only.hasAttribute('style')) return false;
  return only.style.willChange === 'transform' && only.style.transform.startsWith('translate(');
}

/** Split `<token>|<rest>`; null when malformed. */
function splitTag(value: string | null): [string, string] | null {
  if (!value) return null;
  const bar = value.indexOf('|');
  return bar < 0 ? null : [value.slice(0, bar), value.slice(bar + 1)];
}

function createScrollRestorePlugin(token: string) {
  return {
    name: 'everframe-scroll-restore',
    afterClone(ctx: { clone?: Element | null }): void {
      const clone = ctx.clone;
      if (!clone) return;
      const selector = ALL_SCROLL_ATTRS.map((a) => `[${a}]`).join(',');
      const nodes: Element[] = clone.matches?.(selector) ? [clone] : [];
      nodes.push(...Array.from(clone.querySelectorAll(selector)));
      /** Own-token payload for `attr`, stripping the attribute from the clone either way. */
      const take = (el: Element, attr: string): string | null => {
        if (!el.hasAttribute(attr)) return null;
        const parts = splitTag(el.getAttribute(attr));
        el.removeAttribute(attr);
        return parts && parts[0] === token ? parts[1] : null;
      };

      const wrapped = new Set<number>();
      for (const el of nodes) {
        const payload = take(el, SCROLLER_ATTR);
        if (payload === null) continue;
        const id = Number(payload.split('|')[0]);
        if (hasSnapdomScrollWrapper(el)) wrapped.add(id);
      }
      for (const el of nodes) {
        const payload = take(el, SCROLL_ATTR);
        if (payload === null) continue;
        const bar = payload.indexOf('|');
        const id = Number(payload.slice(0, bar));
        const transform = payload.slice(bar + 1);
        const style = (el as HTMLElement).style;
        if (!wrapped.has(id) && style && transform) style.transform = transform;
      }
      for (const el of nodes) {
        const payload = take(el, SCROLL_ABS_ATTR);
        if (payload === null) continue;
        const style = (el as HTMLElement).style;
        if (!style || style.position !== 'absolute') continue;
        let tag: AbsTag;
        try {
          tag = JSON.parse(payload) as AbsTag;
        } catch {
          continue;
        }
        // Only scrollers snapDOM actually wrapped applied a counter-offset.
        const applied = tag.s.filter(([id]) => wrapped.has(id));
        if (!applied.some((entry) => entry[3] === 1)) continue;
        const kept = applied.filter((entry) => entry[3] === 0);
        const keptLeft = kept.reduce((sum, entry) => sum + entry[1], 0);
        const keptTop = kept.reduce((sum, entry) => sum + entry[2], 0);
        style.left = kept.length === 0 ? tag.left : `${(parseFloat(tag.left) || 0) + keptLeft}px`;
        style.top = kept.length === 0 ? tag.top : `${(parseFloat(tag.top) || 0) + keptTop}px`;
      }
    },
  };
}

let captureSeq = 0;

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
   * Window scroll (CSS px) read synchronously right before snapDOM started:
   * the viewport origin of this canvas. snapDOM yields while rendering, so a
   * scroll read after it settles may describe a different viewport.
   */
  scrollX: number;
  scrollY: number;
}

export async function renderViewportWithSnapdom(
  root: HTMLElement,
  opts: SnapdomRenderOptions,
): Promise<SnapdomRenderResult> {
  const { snapdom } = await import('@zumer/snapdom');
  const token = `${Date.now().toString(36)}-${(captureSeq++).toString(36)}`;
  const tagged = tagScrollState(root, token);
  const scrollX = typeof window !== 'undefined' ? window.scrollX || 0 : 0;
  const scrollY = typeof window !== 'undefined' ? window.scrollY || 0 : 0;
  try {
    const capture = await snapdom(root, {
      ...(tagged.length > 0 ? { plugins: [createScrollRestorePlugin(token)] } : {}),
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
    return { canvas: padToViewport(raw, opts.pixelRatio), blank, scrollX, scrollY };
  } finally {
    for (const el of tagged) {
      for (const attr of ALL_SCROLL_ATTRS) {
        if (el.getAttribute(attr)?.startsWith(`${token}|`)) el.removeAttribute(attr);
      }
    }
  }
}
