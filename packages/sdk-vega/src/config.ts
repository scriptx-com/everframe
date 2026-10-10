// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

/**
 * The subset of AsyncStorage the SDK uses. On Vega OS pass the system module
 * `@amazon-devices/react-native-async-storage__async-storage`; any object with
 * these two methods works.
 */
export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null | undefined>;
  setItem(key: string, value: string): Promise<void>;
}

/** Self-declared user, shown on reports. Every field is a label, none is verified. */
export interface VegaUser {
  id?: string;
  email?: string;
  displayName?: string;
}

export type BreadcrumbKind = 'navigation' | 'tap' | 'console' | 'network' | 'lifecycle' | 'error' | 'custom';

export interface VegaBreadcrumb {
  /** Defaults to `custom`. */
  kind?: BreadcrumbKind;
  /** Cut to 2048 characters after redaction. */
  message: string;
  level?: 'debug' | 'info' | 'warn' | 'error';
  data?: Record<string, unknown>;
}

/** Details for a handled error. Metadata is flat: nested values are dropped. */
export interface VegaCaptureOptions {
  /** Defaults to `error`. */
  severity?: 'info' | 'warning' | 'error';
  /** A short label for where the error was caught, up to 256 characters. */
  context?: string;
  /** Up to 32 keys of strings, finite numbers, booleans or null. */
  metadata?: Record<string, string | number | boolean | null>;
}

export interface VegaConfig {
  /**
   * Per-app SDK key (`evf_live_…`; publishable, not secret). Every Everframe
   * SDK names this field `sdkKey`.
   */
  sdkKey: string;
  /**
   * Where reports wait until they are delivered. Without it a report lives
   * only in memory, so a crash whose send did not finish before the app
   * stopped is lost.
   */
  storage?: AsyncStorageLike;
  /** Shown on reports. Defaults to `Vega app`. */
  appName?: string;
  /** Your app's version, e.g. the manifest's `[package] version`. Defaults to `0.0.0`. */
  appVersion?: string;
  /** Optional build number or CI build id. */
  appBuild?: string;
  /** Ingest host. Defaults to `https://everframe.dev`. For self-testing only. */
  endpoint?: string;
  /** `false` turns the SDK off: no hooks, no storage, no network. Default `true`. */
  enabled?: boolean;
  /** Report promise rejections still unhandled after about 2 s. Default `true`. */
  captureUnhandledRejections?: boolean;
  /**
   * Device facts React Native for Vega does not expose to JavaScript, for
   * hosts that read them from `@amazon-devices/react-native-device-info`.
   */
  device?: { model?: string; osVersion?: string };
}

export const DEFAULT_ENDPOINT = 'https://everframe.dev';
export const DEFAULT_APP_NAME = 'Vega app';
export const DEFAULT_APP_VERSION = '0.0.0';

export interface ResolvedConfig {
  sdkKey: string;
  storage: AsyncStorageLike | undefined;
  app: { name: string; version: string; build?: string };
  ingestUrl: string;
  captureUnhandledRejections: boolean;
  device: { model?: string; osVersion?: string };
}

const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.slice(0, max) : undefined;

/** Returns null when the config cannot run (no SDK key). Never throws. */
export function resolveConfig(config: VegaConfig): ResolvedConfig | null {
  const sdkKey = text(config?.sdkKey, 512);
  if (!sdkKey) return null;
  const endpoint = (text(config.endpoint, 2048) ?? DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const build = text(config.appBuild, 200);
  const storage = config.storage;
  const usableStorage = storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function'
    ? storage
    : undefined;
  const model = text(config.device?.model, 256);
  const osVersion = text(config.device?.osVersion, 128);
  return {
    sdkKey,
    storage: usableStorage,
    app: {
      name: text(config.appName, 256) ?? DEFAULT_APP_NAME,
      version: text(config.appVersion, 128) ?? DEFAULT_APP_VERSION,
      ...(build ? { build } : {}),
    },
    ingestUrl: `${endpoint}/api/ingest`,
    captureUnhandledRejections: config.captureUnhandledRejections !== false,
    device: { ...(model ? { model } : {}), ...(osVersion ? { osVersion } : {}) },
  };
}
