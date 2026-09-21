// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Module-level box for the HOST's inline `theme` init option (branding spec
// 2026-08-25). Written by provider.tsx (mirroring config.theme on mount /
// change, cleared on unmount); read together with the server branding box by
// useReporterThemeVars. A box rather than prop-drilling because Modal is a
// shared primitive several dialogs render — same reasoning as
// companion/server-config.ts's header.
import type { ReporterTheme } from './theme.js';

let _inlineTheme: ReporterTheme | undefined;
const _subs = new Set<() => void>();

export function __setInlineReporterTheme(theme: ReporterTheme | undefined): void {
  const changed = JSON.stringify(_inlineTheme) !== JSON.stringify(theme);
  _inlineTheme = theme;
  if (changed) for (const fn of _subs) fn();
}

export function __getInlineReporterTheme(): ReporterTheme | undefined {
  return _inlineTheme;
}

export function __subscribeInlineReporterTheme(fn: () => void): () => void {
  _subs.add(fn);
  return () => {
    _subs.delete(fn);
  };
}
