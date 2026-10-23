// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Real-device quick capture (web TVs): the device facts a link hello carries.
// Lazy chunk only. Every platform probe is try/caught.
import { globalScope } from '../internal/global-scope.js';
import { PKG_VERSION } from '../internal/version.js';
import { currentUserAgent, type HelloDevice, type TvPlatform } from '../devicelink/tv-platform.js';

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
