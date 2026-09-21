// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import type { FocusedNode } from '@traceitx/protocol';

const DISPLAYNAME_ATTR = 'data-traceitx-display-name';

/**
 * Build component path from the focused element up to the root by reading
 * data-traceitx-display-name on each ancestor (Phase-1 plugin reserved attribute).
 *
 * Protocol contract (PAY-02): componentPath is a single string like
 * 'App > CheckoutScreen > CouponInput > TextField' — root-to-leaf.
 */
function buildComponentPath(el: Element): string {
  const names: string[] = [];
  let cursor: Element | null = el;
  while (cursor && cursor !== document.documentElement) {
    const name = cursor.getAttribute(DISPLAYNAME_ATTR);
    if (name) names.unshift(name);
    cursor = cursor.parentElement;
  }
  return names.join(' > ');
}

/**
 * Build the DOM-index path from the focused element back up to <body>.
 * Each entry is the element's index among its parent's children.
 */
function buildIndexPath(el: Element): number[] {
  const path: number[] = [];
  let cursor: Element | null = el;
  while (cursor && cursor.parentElement && cursor !== document.body) {
    const parentEl: Element = cursor.parentElement;
    const idx = Array.prototype.indexOf.call(parentEl.children, cursor);
    if (idx >= 0) path.unshift(idx);
    cursor = parentEl;
  }
  return path;
}

export function captureFocusedNode(): FocusedNode | null {
  if (typeof document === 'undefined') return null;
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  const path = buildIndexPath(el);
  const componentPath = buildComponentPath(el);
  // Source detection: programmatic by default since the SDK can't reliably know whether
  // the focus arrived via mouse / keyboard / remote / touch without instrumenting input
  // events. Plan 06 (reporter UI trigger) can override via captureControl when invoked
  // from a known input source.
  const fn: FocusedNode = {
    path,
    componentPath,
    source: 'programmatic',
  };
  // Cursor — when the element has a getBoundingClientRect, take its top-left as the
  // cursor anchor for AI-readable spatial context.
  if (typeof el.getBoundingClientRect === 'function') {
    const r = el.getBoundingClientRect();
    fn.cursor = { x: r.x, y: r.y };
  }
  return fn;
}
