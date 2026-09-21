// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { resolveThemeVars } from './theme.js';
import { __getBrandingServerConfig, __subscribeBrandingServerConfig } from './server-config.js';
import { __getInlineReporterTheme, __subscribeInlineReporterTheme } from './inline-theme.js';
import { getThemeHost, applyThemeVarsToHost } from './theme-host.js';

/**
 * Resolved --txx-* overrides for the current branding state, or {} when the
 * server has not confirmed paid entitlement (fail closed to the default
 * look). Subscribes to BOTH boxes so a config read landing mid-open re-themes
 * the window without waiting for an unrelated re-render.
 */
export function useReporterThemeVars(): Record<string, string> {
  const server = useSyncExternalStore(
    __subscribeBrandingServerConfig,
    __getBrandingServerConfig,
    () => undefined,
  );
  const inline = useSyncExternalStore(
    __subscribeInlineReporterTheme,
    __getInlineReporterTheme,
    () => undefined,
  );
  const vars = useMemo(() => resolveThemeVars(server, inline), [server, inline]);

  // Mirror onto the shadow host (if one is registered) so portalled layers
  // that are siblings of the modal — not children — still inherit the vars.
  // Inert when no host is registered, which keeps the React portal-root path
  // byte-identical.
  useEffect(() => {
    const host = getThemeHost();
    if (host) applyThemeVarsToHost(host, vars);
  }, [vars]);

  return vars;
}
