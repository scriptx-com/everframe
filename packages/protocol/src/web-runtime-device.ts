// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// What a web runtime's user agent says about the device it runs on. The web
// SDK starts from this and overwrites it with the TV's own APIs where they
// exist; the dashboard reads reports stored before the SDK did, so both read
// one parser.
import { detectWebRuntimePlatform, type WebRuntimePlatform } from './web-runtime-platform.js';

export interface WebRuntimeDevice {
  platform: WebRuntimePlatform;
  /** True for a TV runtime: Tizen, webOS, VIDAA, Titan OS, Vega, or a user agent that names a smart TV. */
  tv: boolean;
  os?: string;
  osVersion?: string;
  manufacturer?: string;
  model?: string;
  /** Browser engine versions, e.g. `{ chrome: '120.0.6099.270' }`. */
  runtimeVersions?: Record<string, string>;
}

const OS_NAME: Record<Exclude<WebRuntimePlatform, 'web'>, string> = {
  tizen: 'Tizen',
  webos: 'webOS',
  vidaa: 'VIDAA',
  titanos: 'Titan OS',
  vega: 'Vega OS',
};

const MANUFACTURER: Partial<Record<WebRuntimePlatform, string>> = {
  tizen: 'Samsung',
  webos: 'LG',
  vidaa: 'Hisense',
  vega: 'Amazon',
};

// LG publishes the Chromium each webOS TV release ships; the user agent names
// only the Chromium. Majors LG has not published stay unknown.
const WEBOS_BY_CHROMIUM: Record<number, string> = {
  38: '3',
  53: '4',
  68: '5',
  79: '6',
  87: '22',
  94: '23',
  108: '24',
  120: '25',
};

/** The webOS TV release that ships this Chromium major, when LG has published it. */
export function webOsVersionFromChromium(major: number): string | undefined {
  return WEBOS_BY_CHROMIUM[major];
}

/** A packaged webOS app's ID from its page path (`…/palm/applications/<id>/index.html`). */
export function webOsAppIdFromPath(path: string | null | undefined): string | undefined {
  const m = path ? /\/palm\/applications\/([^/]+)\//.exec(path) : null;
  return m?.[1];
}

function chromiumVersion(ua: string): string | undefined {
  // Tizen 6.5+ names its Chromium without the `Chrome/` token: `120.0.6099.5/9.0 TV Safari`.
  const m =
    /\b(?:Chrome|CriOS|HeadlessChrome)\/(\d+(?:\.\d+)*)/.exec(ua) ??
    /\)\s(\d+\.\d+\.\d+\.\d+)\/[\d.]+ TV Safari/.exec(ua);
  return m?.[1];
}

/** `HbbTV/1.5.1 (<capabilities>; <vendor>; <model>; …)` — the broadcast-TV UA convention. */
function hbbTvDevice(ua: string): { manufacturer?: string; model?: string } {
  const m = /HbbTV\/[\d.]+ \(([^)]*)\)/.exec(ua);
  if (!m) return {};
  const fields = m[1]!.split(';').map((f) => f.trim());
  const vendor = fields[1];
  const model = fields[2];
  return {
    ...(vendor ? { manufacturer: vendor } : {}),
    ...(model && !/^smart\s*tv$/i.test(model) ? { model } : {}),
  };
}

function nonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

/**
 * The device a web runtime's user agent describes. Desktop and mobile
 * browsers return only `platform: 'web'`, `tv: false` and their browser
 * engine: the browser's OS is read elsewhere and is not this parser's job.
 */
export function describeWebRuntimeDevice(userAgent: string | null | undefined): WebRuntimeDevice {
  const ua = userAgent ?? '';
  const platform = detectWebRuntimePlatform(ua);
  const chrome = chromiumVersion(ua);
  const out: WebRuntimeDevice = {
    platform,
    tv: platform !== 'web' || /\bSMART-?TV\b|\bSmartTV\b|\bHbbTV\//i.test(ua),
    ...(chrome ? { runtimeVersions: { chrome } } : {}),
  };
  if (platform === 'web') {
    // Fire TV and Fire tablet web views are still `web`, but the maker is known.
    const fire = /;\s*(AFT[A-Z0-9]+)[\s;)]/.exec(ua);
    if (fire) {
      out.tv = true;
      out.manufacturer = 'Amazon';
      out.model = fire[1]!;
    }
    return out;
  }

  out.os = OS_NAME[platform];
  const hbb = hbbTvDevice(ua);
  let m: RegExpExecArray | null;
  switch (platform) {
    case 'tizen':
      if ((m = /Tizen[ /]?(\d+(?:\.\d+)*)/.exec(ua))) out.osVersion = m[1]!;
      break;
    case 'webos': {
      const v = chrome ? webOsVersionFromChromium(Number(chrome.split('.')[0])) : undefined;
      if (v) out.osVersion = v;
      break;
    }
    case 'vidaa':
      if ((m = /VIDAA[/ ]?(\d+(?:\.\d+)*)/i.exec(ua))) out.osVersion = m[1]!;
      break;
    case 'titanos':
      if ((m = /TitanOS\/(\d+(?:\.\d+)*)/i.exec(ua))) out.osVersion = m[1]!;
      // NetTV-style `… (Philips, PUS7000) CE-HTML/…`.
      if ((m = /\(([^,()]+), ([^,()]+)\)\s*CE-HTML/.exec(ua))) {
        out.manufacturer = m[1]!.trim();
        out.model = m[2]!.trim();
      }
      break;
    case 'vega':
      // Vega OS web views: `(Linux; Kepler 2.0; AFTCA002 user/515; wv)`.
      if ((m = /\bKepler (\d+(?:\.\d+)*)/.exec(ua))) out.osVersion = m[1]!;
      if ((m = /;\s*(AFT[A-Z0-9]+)[\s;)]/.exec(ua))) out.model = m[1]!;
      break;
  }
  if (!out.model && nonEmpty(hbb.model)) out.model = hbb.model;
  // A maker the user agent names wins over the platform's usual one: VIDAA
  // also runs on Toshiba TVs, Tizen on some Bang & Olufsen sets.
  const manufacturer = out.manufacturer ?? hbb.manufacturer ?? MANUFACTURER[platform];
  if (manufacturer) out.manufacturer = manufacturer;
  return out;
}
