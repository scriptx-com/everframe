// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';

/**
 * Resolve the focused element relative to `node`'s root.
 *
 * `document.activeElement` reports the shadow HOST for anything focused inside
 * a shadow tree, so a focus trap that compares against it never matches and
 * silently stops trapping — Tab escapes into the page behind the modal.
 * Measured: with a shadow-root button focused, `document.activeElement` is the
 * host `<div>` while `shadowRoot.activeElement` is the button.
 *
 * Returns `null` for a detached node (no document, nothing focused) so callers
 * can treat "unknown" and "nothing focused" identically.
 */
export function activeElementFor(node: Element): Element | null {
  const root = node.getRootNode();
  if (root instanceof ShadowRoot) return root.activeElement;
  if (typeof document === 'undefined') return null;
  if (root !== document) return null;
  return document.activeElement;
}

/**
 * Resolve the deepest focused element on the page, descending through shadow
 * boundaries.
 *
 * Codex round-3 finding 5 (P2). `activeElementFor(node)` answers a different
 * question — "what is focused inside NODE's root?" — which is exactly right
 * for a focus TRAP (the focused element is inside the modal, so inside the
 * modal's root) and exactly wrong for focus RESTORE: the element focused
 * before the reporter opened is normally in the HOST PAGE's light DOM, and
 * asking the reporter's shadow root about it returns `null`, so the modal's
 * cleanup restored focus to nothing at all.
 *
 * Descending is what makes one function correct for both worlds: with focus
 * in the light DOM, `document.activeElement` IS the answer and there is no
 * shadow root to descend into; with focus inside a shadow tree,
 * `document.activeElement` is that tree's host and each hop unwraps one
 * boundary. Nested shadow roots (a host page's own web components) resolve
 * the same way.
 */
export function deepActiveElement(): Element | null {
  if (typeof document === 'undefined') return null;
  let el: Element | null = document.activeElement;
  // Bounded: each hop enters a strictly deeper shadow tree, and a tree cannot
  // contain its own host, so this terminates on any real DOM.
  while (el?.shadowRoot?.activeElement) {
    el = el.shadowRoot.activeElement;
  }
  return el;
}
