// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Whether the browser has translated the page. Chrome's page translation marks
// the root element `translated-ltr` or `translated-rtl` and rewrites the text
// nodes under it, React's among them; React then fails to remove or insert a
// node it no longer finds ("NotFoundError: Failed to execute 'removeChild'").
// A crash records the mark so the dashboard can name that cause.

const TRANSLATED_CLASSES = ['translated-ltr', 'translated-rtl'] as const;

/** True when the root element carries a page-translation mark. Never throws. */
export function isPageTranslated(): boolean {
  try {
    if (typeof document === 'undefined') return false;
    const classes = document.documentElement?.classList;
    return classes !== undefined && TRANSLATED_CLASSES.some((name) => classes.contains(name));
  } catch {
    return false;
  }
}
