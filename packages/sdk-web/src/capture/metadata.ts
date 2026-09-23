// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import type { DeviceMetadata } from '@everframe/sdk-core';

/**
 * Parse OS + version from navigator.userAgent. Best-effort; UA strings are unreliable
 * but for AI-readable bug context this is good enough. Phase 6 hardening can adopt
 * UA-CH (User-Agent Client Hints) once chromium-only is acceptable.
 */
function parseUA(ua: string): { os: string; osVersion: string } {
  // iOS — must come BEFORE Mac OS X (iPad UA contains both 'iPad' and 'Mac OS X' in modern Safari)
  let m = ua.match(/iPhone OS (\d+[._]\d+(?:[._]\d+)?)/);
  if (m && m[1]) return { os: 'iOS', osVersion: m[1].replace(/_/g, '.') };
  m = ua.match(/iPad; CPU OS (\d+[._]\d+(?:[._]\d+)?)/);
  if (m && m[1]) return { os: 'iPadOS', osVersion: m[1].replace(/_/g, '.') };
  // Android — must come BEFORE Linux (Android UA contains 'Linux')
  m = ua.match(/Android (\d+(?:\.\d+)?)/);
  if (m && m[1]) return { os: 'Android', osVersion: m[1] };
  // macOS
  m = ua.match(/Mac OS X (\d+[._]\d+(?:[._]\d+)?)/);
  if (m && m[1]) return { os: 'macOS', osVersion: m[1].replace(/_/g, '.') };
  // Windows
  m = ua.match(/Windows NT (\d+\.\d+)/);
  if (m && m[1]) return { os: 'Windows', osVersion: m[1] };
  // Linux (catch-all desktop Linux after Android filtered out)
  if (/Linux/.test(ua)) return { os: 'Linux', osVersion: '' };
  return { os: 'unknown', osVersion: '' };
}

interface NavigatorWithConnection extends Navigator {
  connection?: { effectiveType?: string };
}

export function getDeviceMetadata(): DeviceMetadata {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  const { os, osVersion } = parseUA(ua);
  const meta: DeviceMetadata = {
    os,
    osVersion,
    screenSize: {
      width: typeof screen !== 'undefined' ? screen.width : 0,
      height: typeof screen !== 'undefined' ? screen.height : 0,
    },
    pixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio : 1,
    locale: typeof navigator !== 'undefined' ? navigator.language : 'en-US',
    timezone:
      typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC',
  };
  const connEffective = (navigator as NavigatorWithConnection).connection?.effectiveType;
  if (typeof connEffective === 'string') meta.network = connEffective;
  // Raw UA so triagers can disambiguate cases our regex-based OS parser
  // can't capture (browser engine + version, in-app webviews, etc.).
  if (ua.length > 0) meta.userAgent = ua;
  return meta;
}
