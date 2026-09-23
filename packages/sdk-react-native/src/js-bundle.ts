// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { Platform } from 'react-native';
import type { JsBundleMetadata } from '@everframe/protocol';

export interface JsBundleConfig { buildId: string; bundleName: string }

/** Copy at installation: callers cannot retag code already loaded in this runtime. */
export function captureJsBundleMetadata(input: unknown): Readonly<JsBundleMetadata> | undefined {
  try {
    if (!(globalThis as { HermesInternal?: unknown }).HermesInternal) return undefined;
    const platform = Platform.OS;
    if (platform !== 'android' && platform !== 'ios') return undefined;
    if (!input || typeof input !== 'object') return undefined;
    const { buildId, bundleName } = input as JsBundleConfig;
    if (typeof buildId !== 'string' || buildId.length < 1 || buildId.length > 200 ||
        !/\S/u.test(buildId) || !/^(?:[^\u0000\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/u.test(buildId)) return undefined;
    if (typeof bundleName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(bundleName)) return undefined;
    return Object.freeze({ engine: 'hermes', platform, buildId, bundleName });
  } catch {
    return undefined;
  }
}
