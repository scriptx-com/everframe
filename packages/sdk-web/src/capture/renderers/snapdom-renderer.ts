// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
"use client";

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

/** Live-DOM attribute carrying a scroller's offset to the snapDOM clone plugin. */
export const SCROLL_ATTR = "data-everframe-scroll";

/**
 * snapDOM clones do not carry scroll offsets, so a scrolled nested container
 * would render from its top. Mirrors modern-screenshot's restoreScrollPosition:
 * scrollers are tagged on the live DOM, and the clone plugin shifts each
 * scroller's element children by the negative offset (composed before any
 * existing inline transform). Limitation: direct text-node children of a
 * scroller are not shifted.
 */
function tagScrolledDescendants(root: HTMLElement): HTMLElement[] {
  const tagged: HTMLElement[] = [];
  const skip = new Set<Element>([
    root,
    document.documentElement,
    document.body,
  ]);
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
    if (skip.has(el)) continue;
    if (el.scrollTop !== 0 || el.scrollLeft !== 0) {
      el.setAttribute(SCROLL_ATTR, `${el.scrollLeft},${el.scrollTop}`);
      tagged.push(el);
    }
  }
  return tagged;
}

const scrollRestorePlugin = {
  name: "everframe-scroll-restore",
  afterClone(ctx: { clone?: Element | null }): void {
    const clone = ctx.clone;
    if (!clone) return;
    const scrollers: Element[] = [];
    if (clone.hasAttribute(SCROLL_ATTR)) scrollers.push(clone);
    scrollers.push(...Array.from(clone.querySelectorAll(`[${SCROLL_ATTR}]`)));
    for (const el of scrollers) {
      const [left = 0, top = 0] = (el.getAttribute(SCROLL_ATTR) ?? "")
        .split(",")
        .map(Number);
      for (const child of Array.from(el.children)) {
        const style = (child as HTMLElement).style;
        if (!style) continue;
        style.transform = `translate(${-(left || 0)}px, ${-(top || 0)}px) ${
          style.transform
        }`.trim();
      }
      el.removeAttribute(SCROLL_ATTR);
    }
  },
};

export async function renderViewportWithSnapdom(
  root: HTMLElement,
  opts: SnapdomRenderOptions
): Promise<HTMLCanvasElement> {
  const { snapdom } = await import("@zumer/snapdom");
  const tagged = tagScrolledDescendants(root);
  try {
    const capture = await snapdom(root, {
      ...(tagged.length > 0 ? { plugins: [scrollRestorePlugin] } : {}),
      clip: "viewport",
      fast: false,
      scale: 1,
      dpr: opts.pixelRatio,
      backgroundColor: "#ffffff",
      filter: (el: Element) => opts.filter(el),
      filterMode: "remove",
      embedFonts: "auto",
    });
    return await capture.toCanvas();
  } finally {
    for (const el of tagged) el.removeAttribute(SCROLL_ATTR);
  }
}
