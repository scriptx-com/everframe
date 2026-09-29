// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';

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

/** Live-DOM attribute carrying `<token>|<transform>` to the snapDOM clone plugin. */
export const SCROLL_ATTR = 'data-everframe-scroll';

/**
 * snapDOM clones do not carry scroll offsets, so a scrolled nested container
 * would render from its top. Mirrors modern-screenshot's restoreScrollPosition:
 * every element child of a scrolled element is tagged on the live DOM with its
 * fully composed transform (`translate(-left, -top)` followed by the child's
 * live computed transform, so class/stylesheet transforms survive), and the
 * clone plugin assigns that string to the matching clone child's inline
 * transform. Only the classic `transform` property is used (the individual
 * `translate` property is missing on Chrome 79 / webOS 6).
 *
 * Each capture stamps its tags with a unique token and cleanup only removes
 * tags that still carry its token, so a late settle of an abandoned (deadline)
 * capture cannot strip a newer capture's tags. A snapDOM call that never
 * settles may leave inert tags until the next capture overwrites them.
 *
 * Limitations: direct text-node children of a scroller are not shifted;
 * position:sticky descendants and absolutely positioned descendants whose
 * containing block is outside the scroller are shifted with their parent.
 */
function tagScrolledChildren(root: HTMLElement, token: string): HTMLElement[] {
  const tagged: HTMLElement[] = [];
  const skip = new Set<Element>([root, document.documentElement, document.body]);
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    if (skip.has(el)) continue;
    const left = el.scrollLeft;
    const top = el.scrollTop;
    if (left === 0 && top === 0) continue;
    for (const child of Array.from(el.children) as HTMLElement[]) {
      const computed = getComputedStyle(child).transform;
      const shift = `translate(${-left}px, ${-top}px)`;
      const transform = computed && computed !== 'none' ? `${shift} ${computed}` : shift;
      child.setAttribute(SCROLL_ATTR, `${token}|${transform}`);
      tagged.push(child);
    }
  }
  return tagged;
}

const scrollRestorePlugin = {
  name: 'everframe-scroll-restore',
  afterClone(ctx: { clone?: Element | null }): void {
    const clone = ctx.clone;
    if (!clone) return;
    const tagged: Element[] = [];
    if (clone.hasAttribute(SCROLL_ATTR)) tagged.push(clone);
    tagged.push(...Array.from(clone.querySelectorAll(`[${SCROLL_ATTR}]`)));
    for (const el of tagged) {
      const value = el.getAttribute(SCROLL_ATTR) ?? '';
      const transform = value.slice(value.indexOf('|') + 1);
      const style = (el as HTMLElement).style;
      if (style && transform) style.transform = transform;
      el.removeAttribute(SCROLL_ATTR);
    }
  },
};

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

export async function renderViewportWithSnapdom(
  root: HTMLElement,
  opts: SnapdomRenderOptions,
): Promise<HTMLCanvasElement> {
  const { snapdom } = await import('@zumer/snapdom');
  const token = `${Date.now().toString(36)}-${(captureSeq++).toString(36)}`;
  const tagged = tagScrolledChildren(root, token);
  try {
    const capture = await snapdom(root, {
      ...(tagged.length > 0 ? { plugins: [scrollRestorePlugin] } : {}),
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
    return padToViewport(await capture.toCanvas(), opts.pixelRatio);
  } finally {
    for (const el of tagged) {
      if (el.getAttribute(SCROLL_ATTR)?.startsWith(`${token}|`)) el.removeAttribute(SCROLL_ATTR);
    }
  }
}
