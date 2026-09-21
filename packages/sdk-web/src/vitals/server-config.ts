// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Module-level box for the server-driven vitals gate (spec 2026-09-01,
// Session Vitals). Written by adapter.ts's applyLiveConfig (one-shot after
// the first successful GET /api/config, then every periodic refresh); read
// by vitals/index.ts's setupVitals(), which subscribes to react to a
// mid-session enable/disable flip. Copy of branding/server-config.ts's
// pattern — see its header for why the subscribers exist (a config landing
// between evaluations must trigger a fresh one).
//
// The type is declared inline rather than imported from `@traceitx/sdk-core`
// (unlike BrandingServerConfig): this box always holds a fully-defaulted pair
// (adapter.ts applies the per-field leniency BEFORE writing here — old
// servers that omit both fields still produce `{ vitalsEnabled: false,
// vitalsSampleRate: 1 }`), so there is no "raw server shape" worth sharing.
export interface VitalsServerConfig {
  vitalsEnabled: boolean;
  vitalsSampleRate: number;
}

let _serverConfig: VitalsServerConfig | undefined;
const _subs = new Set<() => void>();

export function __setVitalsServerConfig(cfg: VitalsServerConfig | undefined): void {
  // Deep compare via stringify — the block is two short fields with a stable
  // key order; a false-positive "changed" would only cost one redundant
  // notify.
  const changed = JSON.stringify(_serverConfig) !== JSON.stringify(cfg);
  _serverConfig = cfg;
  if (changed) for (const fn of _subs) fn();
}

export function __getVitalsServerConfig(): VitalsServerConfig | undefined {
  return _serverConfig;
}

export function __subscribeVitalsServerConfig(fn: () => void): () => void {
  _subs.add(fn);
  return () => {
    _subs.delete(fn);
  };
}
