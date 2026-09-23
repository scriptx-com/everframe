// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Module-level box for the server-driven branding block (spec 2026-08-25).
// Written by adapter.ts's applyLiveConfig (one-shot after the first
// successful GET /api/config, then every periodic refresh); read by the
// reporter UI (watermark gate in ReporterDialog, theme resolution in
// provider.tsx). Copy of companion/server-config.ts's pattern — see its
// header for why the subscribers exist (a config landing between renders
// must trigger its own re-render).
import type { BrandingServerConfig } from '@everframe/sdk-core';

let _serverConfig: BrandingServerConfig | undefined;
const _subs = new Set<() => void>();

export function __setBrandingServerConfig(cfg: BrandingServerConfig | undefined): void {
  // Deep compare via stringify — the block is tiny (≤9 short fields) and its
  // key order is stable (zod parse of a fixed schema); a false-positive
  // "changed" would only cost one redundant notify.
  const changed = JSON.stringify(_serverConfig) !== JSON.stringify(cfg);
  _serverConfig = cfg;
  if (changed) for (const fn of _subs) fn();
}

export function __getBrandingServerConfig(): BrandingServerConfig | undefined {
  return _serverConfig;
}

export function __subscribeBrandingServerConfig(fn: () => void): () => void {
  _subs.add(fn);
  return () => {
    _subs.delete(fn);
  };
}
