// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import { STAND_IN_ATTR } from '../video-frames.js';

/**
 * Clone-side masking for the snapDOM path: the live page is never touched.
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
    ['width', `${width}px`],
    ['height', `${height}px`],
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
    ['transform', cs.transform],
    ['transform-origin', cs.transformOrigin],
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

/** snapDOM plugin replacing the clones of `targets` (and everything inside them) with black boxes. */
export function createCloneMaskPlugin(targets: readonly Element[]) {
  const targetSet = new Set(targets);
  const boxes: Array<[HTMLElement, string]> = [];
  let maskedRoot: HTMLElement | null = null;
  return {
    name: 'everframe-clone-mask',
    afterClone(ctx: CloneContext): void {
      const root = ctx.clone as HTMLElement | null | undefined;
      if (!root || !(ctx.nodeMap instanceof Map) || targetSet.size === 0) return;
      const replaced = new Set<Node>();
      const insideReplaced = (node: Node): boolean => {
        let n: Node | null = node.parentNode;
        while (n) {
          if (replaced.has(n)) return true;
          n = n.parentNode ?? (n as ShadowRoot).host ?? null;
        }
        return false;
      };
      for (const [cloneNode, src] of ctx.nodeMap as Map<Node, Node>) {
        if (cloneNode.nodeType !== 1 || !targetSet.has(src as Element)) continue;
        const clone = cloneNode as HTMLElement;
        if (clone === root) {
          // The whole capture root is sensitive: nothing of it may render.
          root.replaceChildren();
          root.style.setProperty('background', '#000', 'important');
          maskedRoot = root;
          continue;
        }
        if (insideReplaced(clone)) continue; // gone with a masked ancestor
        const css = blackBoxCss(src as Element, clone);
        replaced.add(clone);
        if (css === null) {
          clone.remove();
          continue;
        }
        const box = (clone.ownerDocument ?? document).createElement('div');
        box.style.cssText = css;
        clone.replaceWith(box);
        boxes.push([box, css]);
      }
    },
    beforeRender(): void {
      for (const [box, css] of boxes) {
        box.replaceChildren();
        for (const attr of Array.from(box.attributes)) box.removeAttribute(attr.name);
        box.style.cssText = css;
      }
      if (maskedRoot) {
        maskedRoot.replaceChildren();
        maskedRoot.style.setProperty('background', '#000', 'important');
      }
    },
  };
}
