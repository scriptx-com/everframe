// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import { STAND_IN_ATTR } from '../video-frames.js';

/**
 * Clone-side masking for the snapDOM path: the live page is never touched.
 *
 * Sensitivity is decided at MASK time, per clone node, from its live
 * SOURCE: a node is masked when its source or any source ancestor (crossing
 * shadow roots) is sensitive right now. So an element the app adds or
 * replaces while snapDOM's clone yields is caught, and so is a descendant
 * snapDOM lifted out of a sensitive ancestor (fixed/sticky clones are moved
 * to the capture root before `afterClone`).
 *
 * Each sensitive element's CLONE is replaced by an opaque black box with the
 * element's own box geometry (display, position, offsets, margins, size,
 * grid/flex placement, transform), so nothing reflows and nothing of the
 * element survives - no children, text, values, checked state,
 * pseudo-elements or background images. snapDOM synthesizes form controls
 * (checkbox/radio/select/range replacements) while it clones, i.e. before
 * `afterClone`; the replacement therefore removes whatever it produced. A
 * later snapDOM pass that pairs source and clone nodes (background inlining,
 * icon fonts) could still decorate the box, so `beforeRender` resets every
 * box to its pristine state once more.
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

/** Inline style of the black box standing in for `src` (null: the element renders no box). */
export function blackBoxCss(src: Element, clone: HTMLElement | null): string | null {
  const cs = getComputedStyle(src);
  if (cs.display === 'none' || cs.display === 'contents') return null;
  // Layout size (transforms excluded - the transform is copied below); SVG
  // elements have no offset size and fall back to their rect.
  const rect = src.getBoundingClientRect();
  const width = src instanceof HTMLElement ? src.offsetWidth : rect.width;
  const height = src instanceof HTMLElement ? src.offsetHeight : rect.height;
  const display = cs.display.startsWith('table')
    ? cs.display
    : cs.display.startsWith('inline')
      ? 'inline-block'
      : 'block';
  // snapDOM already re-placed fixed/sticky elements at their live rect as
  // absolute boxes (its freezeViewportPositioned pass): keep that placement.
  const lifted =
    clone?.style.position === 'absolute' && (cs.position === 'fixed' || cs.position.endsWith('sticky'));
  const individual = cs as unknown as Record<'translate' | 'rotate' | 'scale', string | undefined>;
  const decl: Array<[string, string]> = [
    ['display', display],
    ['position', lifted ? 'absolute' : cs.position],
    ['top', lifted ? clone!.style.top : cs.top],
    ['right', lifted ? 'auto' : cs.right],
    ['bottom', lifted ? 'auto' : cs.bottom],
    ['left', lifted ? clone!.style.left : cs.left],
    ['z-index', cs.zIndex],
    ['float', cs.cssFloat],
    ['clear', cs.clear],
    ['margin-top', lifted ? '0' : cs.marginTop],
    ['margin-right', lifted ? '0' : cs.marginRight],
    ['margin-bottom', lifted ? '0' : cs.marginBottom],
    ['margin-left', lifted ? '0' : cs.marginLeft],
    ['box-sizing', 'border-box'],
    ['width', lifted && clone!.style.width ? clone!.style.width : `${width}px`],
    ['height', lifted && clone!.style.height ? clone!.style.height : `${height}px`],
    ['min-width', '0'],
    ['min-height', '0'],
    ['max-width', 'none'],
    ['max-height', 'none'],
    ['flex', '0 0 auto'],
    ['align-self', cs.alignSelf],
    ['justify-self', cs.justifySelf],
    ['order', cs.order],
    ['grid-row-start', cs.gridRowStart],
    ['grid-row-end', cs.gridRowEnd],
    ['grid-column-start', cs.gridColumnStart],
    ['grid-column-end', cs.gridColumnEnd],
    ['vertical-align', cs.verticalAlign],
    // offset* sizes are unzoomed CSS px; the element's own zoom scales them
    // (snapDOM's frozen size for a lifted element is already the zoomed rect).
    ['zoom', lifted ? '1' : ((cs as unknown as { zoom?: string }).zoom ?? '')],
    // A lifted element's position already has snapDOM's frozen transform
    // baked in (translation into left/top, the rest in its inline
    // transform): reapplying the live transform would move the box twice.
    ['transform', lifted ? clone!.style.transform || 'none' : cs.transform],
    ['transform-origin', lifted ? clone!.style.transformOrigin || cs.transformOrigin : cs.transformOrigin],
    ['translate', lifted ? 'none' : (individual.translate ?? '')],
    ['rotate', lifted ? 'none' : (individual.rotate ?? '')],
    ['scale', lifted ? 'none' : (individual.scale ?? '')],
    ['border-radius', cs.borderRadius],
    ['visibility', cs.visibility],
    ['opacity', cs.opacity],
    ['padding', '0'],
    ['border', 'none'],
    ['overflow', 'hidden'],
    ['background', '#000'],
    ['color', 'transparent'],
    ['appearance', 'none'],
  ];
  return decl
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}:${v} !important`)
    .join(';');
}

interface CloneContext {
  clone?: Element | null | undefined;
  /** snapDOM's clone -> live source map (typed `unknown`; a Map in 3.2.0, populated before `afterClone`). */
  nodeMap?: unknown;
}

/** Black-out declarations layered over a detached source's snapshotted clone styles. */
const DETACHED_OVERRIDES = [
  'background:#000 !important',
  'background-image:none !important',
  'color:transparent !important',
  '-webkit-text-fill-color:transparent !important',
  'border-color:#000 !important',
  'box-shadow:none !important',
  'text-shadow:none !important',
  'overflow:hidden !important',
].join(';');

/**
 * Inline style for the span wrapping a sensitive `display:contents`
 * element's direct text. The text stays in place, so line breaking and every
 * following box are exactly as live, but its glyphs are transparent and each
 * line fragment is backed in black. (The characters remain only in the
 * transient in-memory clone; the shipped raster shows black.)
 */
const TEXT_MASK_CSS = [
  'color:transparent !important',
  '-webkit-text-fill-color:transparent !important',
  'background:#000 !important',
  'text-shadow:none !important',
  'text-decoration:none !important',
  'caret-color:transparent !important',
].join(';');

/** Direct children of a sensitive display:contents clone: mask text, drop generated nodes. */
function maskContentsChildren(
  clone: Element,
  src: Element,
  nodeMap: Map<Node, Node>,
  owned: WeakSet<Node>,
): void {
  // The span is unknown to snapDOM's style pass, so it carries the text's
  // live font explicitly - the masked run must advance exactly like the text.
  const cs = getComputedStyle(src);
  const css = [
    TEXT_MASK_CSS,
    `font-family:${cs.fontFamily} !important`,
    `font-size:${cs.fontSize} !important`,
    `font-weight:${cs.fontWeight} !important`,
    `font-style:${cs.fontStyle} !important`,
    `font-stretch:${cs.fontStretch} !important`,
    `font-variant:${cs.fontVariant} !important`,
    `letter-spacing:${cs.letterSpacing} !important`,
    `word-spacing:${cs.wordSpacing} !important`,
    `line-height:${cs.lineHeight} !important`,
    `text-transform:${cs.textTransform} !important`,
    `white-space:${cs.whiteSpace} !important`,
  ].join(';');
  for (const child of Array.from(clone.childNodes)) {
    if (owned.has(child)) {
      (child as HTMLElement).style.cssText = css;
      continue;
    }
    if (child.nodeType === 3) {
      if (!(child as Text).data.trim()) continue;
      const span = (clone.ownerDocument ?? document).createElement('span');
      span.style.cssText = css;
      owned.add(span);
      child.replaceWith(span);
      span.appendChild(child);
    } else if (child.nodeType === 1 && !nodeMap.has(child)) {
      // Synthesized by snapDOM (inlined pseudo-elements and the like): no
      // live source to judge, inside a sensitive wrapper - drop it.
      child.remove();
    }
  }
}

/** Nearest ancestor across shadow boundaries (a shadow root hands over to its host). */
function parentAcrossShadow(node: Node): Node | null {
  const parent = node.parentNode;
  if (parent && parent.nodeType === 11) return (parent as ShadowRoot).host ?? null;
  return parent;
}

/**
 * snapDOM plugin masking every clone node whose live source is sensitive at
 * mask time (`isTarget` on the source or any source ancestor). Runs in
 * `afterClone` and again in `beforeRender`, after snapDOM's later passes.
 */
export function createCloneMaskPlugin(isTarget: (el: Element) => boolean) {
  const boxes: Array<[HTMLElement, string, string | null]> = [];
  /** Masking spans this plugin inserted around text (kept, never re-judged as generated). */
  const owned = new WeakSet<Node>();
  let maskedRoot: HTMLElement | null = null;

  const mask = (ctx: CloneContext): void => {
    const root = ctx.clone as HTMLElement | null | undefined;
    if (!root || !(ctx.nodeMap instanceof Map)) return;
    const nodeMap = ctx.nodeMap as Map<Node, Node>;
    const memo = new Map<Node, boolean>();
    const sensitive = (node: Node | null): boolean => {
      if (!node) return false;
      const known = memo.get(node);
      if (known !== undefined) return known;
      let result = false;
      if (node.nodeType === 1) {
        const el = node as Element;
        result = safeIsTarget(isTarget, el);
        // A sensitive video never renders; its frame rides on the stand-in
        // inserted right after it.
        if (!result && el.hasAttribute?.(STAND_IN_ATTR)) {
          const video = el.previousElementSibling;
          result = video?.tagName === 'VIDEO' && sensitive(video);
        }
      }
      if (!result) result = sensitive(parentAcrossShadow(node));
      memo.set(node, result);
      return result;
    };
    const replaced = new Set<Node>();
    const insideReplaced = (node: Node): boolean => {
      for (let n = parentAcrossShadow(node); n; n = parentAcrossShadow(n)) {
        if (replaced.has(n)) return true;
      }
      return false;
    };
    for (const [cloneNode, src] of nodeMap) {
      if (cloneNode.nodeType !== 1 || src.nodeType !== 1 || !sensitive(src)) continue;
      const clone = cloneNode as HTMLElement;
      if (clone === root) {
        // The whole capture root is sensitive: nothing of it may render.
        root.replaceChildren();
        root.style.setProperty('background', '#000', 'important');
        maskedRoot = root;
        return;
      }
      // Already replaced, or inside a replaced ancestor (gone with it).
      if (!clone.parentNode || insideReplaced(clone)) continue;
      if (!(src as Element).isConnected) {
        // The app removed/replaced the source after snapDOM copied it: its
        // live geometry is gone, but the clone still carries the styles
        // snapDOM snapshotted (classes + inline). Keep those for the box.
        replaced.add(clone);
        const box = (clone.ownerDocument ?? document).createElement('div');
        const cls = clone.getAttribute('class');
        const css = `${clone.getAttribute('style') ?? ''};${DETACHED_OVERRIDES}`;
        if (cls) box.setAttribute('class', cls);
        box.style.cssText = css;
        clone.replaceWith(box);
        boxes.push([box, css, cls]);
        continue;
      }
      const css = blackBoxCss(src as Element, clone);
      if (css === null) {
        if (getComputedStyle(src as Element).display === 'none') {
          // Renders nothing.
          replaced.add(clone);
          clone.remove();
        } else {
          // display:contents renders only its children: element children are
          // masked on their own (their ancestor is sensitive); direct text and
          // generated (unmapped) children are handled here.
          maskContentsChildren(clone, src as Element, nodeMap, owned);
        }
        continue;
      }
      replaced.add(clone);
      const box = (clone.ownerDocument ?? document).createElement('div');
      box.style.cssText = css;
      clone.replaceWith(box);
      boxes.push([box, css, null]);
    }
  };

  return {
    name: 'everframe-clone-mask',
    afterClone(ctx: CloneContext): void {
      mask(ctx);
    },
    beforeRender(ctx?: CloneContext): void {
      // snapDOM's later passes may have decorated a box, and the page may
      // have changed since afterClone: reset every box, then mask again.
      for (const [box, css, cls] of boxes) {
        box.replaceChildren();
        for (const attr of Array.from(box.attributes)) box.removeAttribute(attr.name);
        if (cls) box.setAttribute('class', cls);
        box.style.cssText = css;
      }
      if (maskedRoot) {
        maskedRoot.replaceChildren();
        maskedRoot.style.setProperty('background', '#000', 'important');
        return;
      }
      if (ctx) mask(ctx);
    },
  };
}

/** A throwing predicate counts as sensitive: never unmask on an error. */
function safeIsTarget(isTarget: (el: Element) => boolean, el: Element): boolean {
  try {
    return isTarget(el);
  } catch {
    return true;
  }
}
