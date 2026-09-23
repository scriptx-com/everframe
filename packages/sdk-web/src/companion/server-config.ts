// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Module-level box for the server-driven companion badge block (plan
// 2026-08-25). Written by adapter.ts's applyLiveConfig (one-shot after the
// first successful GET /api/config, then every periodic refresh); read by
// the companion singleton's badge-config resolution. Lives in its own
// module so adapter.ts does not need to import the companion singleton
// (no such dependency exists today) and so tests can drive it directly.
// Subscribers exist because CompanionBadge only re-renders on companion
// state changes — a config landing between them must trigger its own
// re-render or the override would wait for the next attach event.
import type { CompanionBadgeServerConfig } from '@everframe/sdk-core';

let _serverConfig: CompanionBadgeServerConfig | undefined;
const _subs = new Set<() => void>();

export function __setCompanionBadgeServerConfig(
  cfg: CompanionBadgeServerConfig | undefined,
): void {
  const changed = _serverConfig?.enabled !== cfg?.enabled
    || _serverConfig?.position !== cfg?.position
    || (_serverConfig === undefined) !== (cfg === undefined);
  _serverConfig = cfg;
  if (changed) for (const fn of _subs) fn();
}

export function __getCompanionBadgeServerConfig(): CompanionBadgeServerConfig | undefined {
  return _serverConfig;
}

export function __subscribeCompanionBadgeServerConfig(fn: () => void): () => void {
  _subs.add(fn);
  return () => { _subs.delete(fn); };
}
