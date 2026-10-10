// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Device context from React Native for Vega. Its `Platform.constants` carries
// only `keplerOSVariant`, `uiMode` and `reactNativeVersion` (no model or OS
// release), so those come from the host config when it has them.
import { Dimensions, PixelRatio, Platform } from 'react-native';
import type { DeviceMetadata } from '@everframe/sdk-core';

export const VEGA_OS_NAME = 'Vega OS';

function attempt<T>(read: () => T, fallback: T): T {
  try {
    const value = read();
    return value === undefined || value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

const finite = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;

export function readDevice(overrides: { model?: string; osVersion?: string } = {}): DeviceMetadata {
  const screen = attempt(() => Dimensions.get('screen') as { width?: unknown; height?: unknown }, {});
  const resolved = attempt(() => Intl.DateTimeFormat().resolvedOptions(), {} as Partial<Intl.ResolvedDateTimeFormatOptions>);
  const platformVersion = attempt(() => (Platform as { Version?: unknown }).Version, undefined);
  const osVersion =
    overrides.osVersion ??
    (typeof platformVersion === 'string' || typeof platformVersion === 'number' ? String(platformVersion) : '');
  return {
    os: VEGA_OS_NAME,
    osVersion,
    ...(overrides.model ? { model: overrides.model } : {}),
    screenSize: { width: Math.round(finite(screen.width, 0)), height: Math.round(finite(screen.height, 0)) },
    pixelRatio: finite(attempt(() => PixelRatio.get(), 1), 1),
    locale: typeof resolved.locale === 'string' && resolved.locale ? resolved.locale : 'und',
    timezone: typeof resolved.timeZone === 'string' && resolved.timeZone ? resolved.timeZone : 'UTC',
  };
}

/** `Platform.OS` on Vega OS is `kepler`. */
export function isVegaRuntime(): boolean {
  return attempt(() => Platform.OS as string, '') === 'kepler';
}
