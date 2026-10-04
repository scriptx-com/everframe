// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

/** Explicit `appBuild` wins; otherwise the id a bundler plugin injected at build time. */
export function resolveAppBuild(configured: string | undefined): string | undefined {
  if (configured !== undefined) return configured;
  const injected = (globalThis as { __EVERFRAME_BUILD__?: unknown }).__EVERFRAME_BUILD__;
  if (!injected || typeof injected !== 'object') return undefined;
  const { buildId } = injected as { buildId?: unknown };
  if (
    typeof buildId !== 'string' ||
    buildId.length === 0 ||
    buildId.length > 200 ||
    buildId.trim().length === 0 ||
    /[\u0000\ud800-\udfff]/u.test(buildId)
  )
    return undefined;
  return buildId;
}
