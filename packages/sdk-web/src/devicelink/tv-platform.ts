// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Real-device quick capture (web TVs): which TV engine this page runs on, the
// debug rule, and the device facts a link hello carries. Eager and pure: no
// DOM access at import time, and every platform probe is try/caught.
import { globalScope } from '../internal/global-scope.js';
import { PKG_VERSION } from '../internal/version.js';

export type TvPlatform = 'tizen' | 'webos';

function currentUserAgent(): string {
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

const WEBOS_DEVICE_INFO_TIMEOUT_MS = 1_000;

function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') return 'unknown';
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0) return 'unknown';
  return trimmed.slice(0, max);
}

function tizenModel(win: unknown): string | null {
  try {
    const info = (win as { webapis?: { productinfo?: Record<string, unknown> } }).webapis
      ?.productinfo;
    if (!info) return null;
    for (const name of ['getRealModel', 'getModel']) {
      const fn = info[name];
      if (typeof fn !== 'function') continue;
      try {
        const v: unknown = (fn as () => unknown).call(info);
        if (typeof v === 'string' && v.trim().length > 0) return v;
      } catch {
        /* try the next probe */
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

interface WebOsDeviceInfo {
  modelName?: unknown;
  sdkVersion?: unknown;
}

function webOsDeviceInfo(win: unknown, timeoutMs: number): Promise<WebOsDeviceInfo | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: WebOsDeviceInfo | null): void => {
      if (done) return;
      done = true;
      resolve(v);
    };
    try {
      const webOS = (win as { webOS?: { deviceInfo?: unknown } }).webOS;
      const fn = webOS?.deviceInfo;
      if (typeof fn !== 'function') {
        finish(null);
        return;
      }
      setTimeout(() => finish(null), timeoutMs);
      (fn as (cb: (info: unknown) => void) => void).call(webOS, (info: unknown) => {
        try {
          finish(info && typeof info === 'object' ? (info as WebOsDeviceInfo) : null);
        } catch {
          finish(null);
        }
      });
    } catch {
      finish(null);
    }
  });
}

function tizenVersion(ua: string): string | null {
  const m = /Tizen[ /]?(\d+(?:\.\d+)*)/.exec(ua);
  return m ? m[1]! : null;
}

function webOsVersion(ua: string): string | null {
  const m = /webOS(?:\.TV)?[ /-]?(\d+(?:\.\d+)*)/i.exec(ua);
  return m ? m[1]! : null;
}

/**
 * Device facts for `POST /api/device-link/hello`. Never rejects. A missing
 * value becomes `'unknown'`; model, os, osVersion and appVersion are capped
 * at 100, 40, 40 and 64 characters.
 */
export async function collectHelloDevice(
  platform: TvPlatform,
  appVersion: string | undefined,
  env?: { userAgent?: string; win?: unknown; timeoutMs?: number },
): Promise<HelloDevice> {
  const ua = env?.userAgent ?? currentUserAgent();
  let win: unknown = env?.win;
  if (win === undefined) {
    try {
      win = globalScope();
    } catch {
      win = {};
    }
  }
  let model: string | null = null;
  let os: string;
  let osVersion: string | null = null;
  if (platform === 'tizen') {
    os = 'Tizen';
    model = tizenModel(win) ?? 'Samsung TV';
    osVersion = tizenVersion(ua);
  } else {
    os = 'webOS';
    const info = await webOsDeviceInfo(win, env?.timeoutMs ?? WEBOS_DEVICE_INFO_TIMEOUT_MS);
    const name = info?.modelName;
    model = typeof name === 'string' && name.trim().length > 0 ? name : 'LG TV';
    const sdkVersion = info?.sdkVersion;
    osVersion =
      typeof sdkVersion === 'string' && sdkVersion.trim().length > 0
        ? sdkVersion
        : webOsVersion(ua);
  }
  return {
    model: clean(model, 100),
    os: clean(os, 40),
    osVersion: clean(osVersion, 40),
    appVersion: clean(appVersion, 64),
    sdk: `web/${PKG_VERSION}`,
    formFactor: 'tv',
  };
}
