// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';

/**
 * Where Modal and Toast portal to.
 *
 * Both portalled to `document.body` unconditionally. That is correct while the
 * host is React and the stylesheet went into the document head, but a
 * framework-agnostic mount injects its CSS into a ShadowRoot — a portal to
 * `document.body` escapes that root and renders unstyled.
 *
 * A module-level slot rather than context: Modal and Toast render from several
 * roots (provider, companion, inbox) and threading a prop through each buys
 * nothing, since exactly one reporter UI is mounted at a time — the same
 * single-instance rule `contextSeam` already enforces for `open()`.
 */
let portalTarget: DocumentFragment | HTMLElement | null = null;

/** Set the portal root. Pass `null` to restore the `document.body` default. */
export function __setPortalTarget(target: DocumentFragment | HTMLElement | null): void {
  portalTarget = target;
}

/** Resolve the portal container. `null` under SSR, so callers early-return. */
export function resolvePortalTarget(): DocumentFragment | HTMLElement | null {
  if (portalTarget) return portalTarget;
  if (typeof document === 'undefined') return null;
  return document.body;
}
