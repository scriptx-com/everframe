// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';

/**
 * Branding vars for the shadow-root mount.
 *
 * In the React path the resolved `--everframe-*` values are spread onto the portal
 * root as inline styles. Inside a shadow tree that is not enough: layers that
 * portal separately (the annotate overlay, toasts) are siblings, not children,
 * of the modal, so the vars have to sit on the shadow HOST where they cascade
 * to everything inside.
 *
 * Entitlement is decided upstream in use-theme-vars.ts and is unchanged here —
 * this module only decides WHERE resolved vars are written.
 */
let themeHost: HTMLElement | null = null;
let lastApplied: string[] = [];

/** Register the shadow host. `null` on teardown. */
export function __setThemeHost(el: HTMLElement | null): void {
  themeHost = el;
  lastApplied = [];
}

/** The registered host, or `null` in the React (portal-root) path. */
export function getThemeHost(): HTMLElement | null {
  return themeHost;
}

/**
 * Write `vars` onto `host`, removing any var set by the previous call that is
 * absent now — otherwise a downgrade (paid → free, or a theme field cleared)
 * would leave the old accent colour stranded on the element forever.
 */
export function applyThemeVarsToHost(
  host: HTMLElement,
  vars: Record<string, string>,
): void {
  if (!host?.style) return;
  for (const name of lastApplied) {
    if (!(name in vars)) host.style.removeProperty(name);
  }
  for (const [name, value] of Object.entries(vars)) {
    host.style.setProperty(name, value);
  }
  lastApplied = Object.keys(vars);
}
