// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { randomUUID } from 'node:crypto';
import type { StagedBuildPartial } from '@everframe/protocol';

export function generateBuildId(): string {
  return randomUUID();
}

export function deriveBundleName(platform: 'android' | 'ios'): string {
  return platform === 'android' ? 'index.android.bundle' : 'main.jsbundle';
}

/** Runs before every application module, so the id is readable from the first frame onward. */
export function identityModuleSource(partial: StagedBuildPartial): string {
  const value = JSON.stringify({
    buildId: partial.buildId,
    bundleName: partial.bundleName,
    platform: partial.platform,
  });
  return `globalThis.__EVERFRAME_BUILD__ = Object.freeze(${value});\n`;
}
