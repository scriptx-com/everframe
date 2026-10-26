// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// What a TV's own APIs say about the device and the app, on top of what its
// user agent says. Synchronous only: report and crash metadata are read on the
// submit path. Every probe is try/caught, and an API the TV lacks answers
// nothing.
import { webOsAppIdFromPath, type WebRuntimePlatform } from '@everframe/protocol';

export interface TvApiDevice {
  osVersion?: string;
  manufacturer?: string;
  model?: string;
  totalMemory?: number;
  runtimeVersions?: Record<string, string>;
}

type Probe = Record<string, unknown> | undefined;

function text(value: unknown, max = 100): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > 0 ? trimmed.slice(0, max) : undefined;
}

function call(target: Probe, name: string, ...args: unknown[]): unknown {
  try {
    const fn = target?.[name];
    return typeof fn === 'function'
      ? (fn as (...a: unknown[]) => unknown).apply(target, args)
      : undefined;
  } catch {
    return undefined;
  }
}

function prop(target: unknown, ...path: string[]): Probe {
  let node: unknown = target;
  try {
    for (const key of path) {
      if (node === null || (typeof node !== 'object' && typeof node !== 'function'))
        return undefined;
      node = (node as Record<string, unknown>)[key];
    }
  } catch {
    return undefined;
  }
  return node !== null && (typeof node === 'object' || typeof node === 'function')
    ? (node as Record<string, unknown>)
    : undefined;
}

/** Samsung's model: `webapis.productinfo` when the app loads webapis.js, else Tizen system info. */
export function tizenModel(win: unknown): string | undefined {
  const info = prop(win, 'webapis', 'productinfo');
  return (
    text(call(info, 'getRealModel')) ??
    text(call(info, 'getModel')) ??
    text(
      call(prop(win, 'tizen', 'systeminfo'), 'getCapability', 'http://tizen.org/system/model_name'),
    )
  );
}

/** `PalmSystem.deviceInfo`: a JSON string on every webOS TV, no webOSTV.js needed. */
function palmDeviceInfo(win: unknown): Record<string, unknown> | undefined {
  try {
    const raw = prop(win, 'PalmSystem')?.['deviceInfo'];
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function tvApiDevice(platform: WebRuntimePlatform, win: unknown): TvApiDevice {
  const out: TvApiDevice = {};
  switch (platform) {
    case 'tizen': {
      const model = tizenModel(win);
      if (model) out.model = model;
      const systeminfo = prop(win, 'tizen', 'systeminfo');
      const version = text(
        call(systeminfo, 'getCapability', 'http://tizen.org/feature/platform.version'),
        40,
      );
      if (version) out.osVersion = version;
      const memory = call(systeminfo, 'getTotalMemory');
      if (typeof memory === 'number' && Number.isSafeInteger(memory) && memory > 0)
        out.totalMemory = memory;
      break;
    }
    case 'webos': {
      const info = palmDeviceInfo(win);
      const model = text(info?.['modelName']);
      if (model) out.model = model;
      // The firmware's own numbering (webOS 24 reports 9.x), kept beside the
      // marketing release the user agent names.
      const platformVersion = text(info?.['platformVersion'], 40);
      if (platformVersion) out.runtimeVersions = { webosPlatform: platformVersion };
      break;
    }
    case 'vidaa': {
      const model = text(call(win as Probe, 'Hisense_GetModelName'));
      if (model) out.model = model;
      const brand = text(call(win as Probe, 'Hisense_GetBrand'));
      if (brand) out.manufacturer = brand;
      const firmware = text(call(win as Probe, 'Hisense_GetFirmWareVersion'), 128);
      if (firmware) out.runtimeVersions = { vidaaFirmware: firmware };
      break;
    }
    default:
      break;
  }
  return out;
}

/**
 * The TV's own app ID: Tizen's `appInfo.id`, webOS's `PalmSystem.identifier`
 * (or the packaged app's path). Undefined on every other runtime.
 */
export function tvAppIdentifier(
  platform: WebRuntimePlatform,
  win: unknown,
  pathname?: string,
): string | undefined {
  if (platform === 'tizen') {
    const app = call(prop(win, 'tizen', 'application'), 'getCurrentApplication');
    return text(prop(app, 'appInfo')?.['id'], 256);
  }
  if (platform === 'webos') {
    const palm = prop(win, 'PalmSystem');
    // `identifier` is `<appId> <processId>` on some firmware.
    const id = text(palm?.['identifier'], 256) ?? text(call(palm, 'getIdentifier'), 256);
    return id?.split(' ')[0] ?? webOsAppIdFromPath(pathname);
  }
  return undefined;
}
