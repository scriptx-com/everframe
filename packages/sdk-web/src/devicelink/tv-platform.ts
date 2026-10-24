// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Real-device quick capture (web TVs): which TV engine this page runs on and
// the debug rule. Eager and pure: no DOM access at import time. The device
// facts a link hello carries are collected in the lazy runtime
// (`quickcapture/hello-device.ts`); only their type lives here.
import { globalScope } from '../internal/global-scope.js';

export type TvPlatform = 'tizen' | 'webos';

export function currentUserAgent(): string {
  try {
    const nav = (globalScope() as { navigator?: { userAgent?: unknown } }).navigator;
    return nav && typeof nav.userAgent === 'string' ? nav.userAgent : '';
  } catch {
    return '';
  }
}

/**
 * `'tizen'` for a Samsung Tizen UA, `'webos'` for an LG webOS UA (`Web0S`,
 * `webOS` or `WebAppManager`), otherwise null. Desktop browsers, VIDAA and
 * TitanOS read as null and get none of the TV quick-capture machinery.
 */
export function detectTvPlatform(userAgent?: string): TvPlatform | null {
  const ua = typeof userAgent === 'string' ? userAgent : currentUserAgent();
  if (ua.indexOf('Tizen') !== -1) return 'tizen';
  if (ua.indexOf('Web0S') !== -1 || ua.indexOf('webOS') !== -1) return 'webos';
  if (ua.indexOf('WebAppManager') !== -1) return 'webos';
  return null;
}

/**
 * A web TV is a debug build only when the app sets `debugBuild: true`. The
 * loopback heuristic in `debug-build.ts` does not apply: hosted TV apps are
 * often served from a LAN or loopback address in production.
 */
export function quickCaptureDebug(config: { debugBuild?: boolean }): boolean {
  return config.debugBuild === true;
}

export interface HelloDevice {
  model: string;
  os: string;
  osVersion: string;
  appVersion: string;
  sdk: string;
  formFactor: 'tv';
}
