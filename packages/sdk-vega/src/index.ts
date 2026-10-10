// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// @everframe/vega — JavaScript crash and error reporting for Amazon Vega OS
// apps (React Native for Vega). Preview. No native module: uncaught errors
// come from ErrorUtils, promise rejections from Hermes' rejection tracker,
// reports wait in AsyncStorage and go to Everframe as JSON.
//
//   import AsyncStorage from '@amazon-devices/react-native-async-storage__async-storage';
//   import * as Everframe from '@everframe/vega';
//   Everframe.init({ sdkKey: 'evf_live_…', storage: AsyncStorage, appVersion: '1.4.0' });
//
// Call init() at the top of index.js, before AppRegistry.registerComponent.
// Native crashes, Hermes VM aborts and ANRs are not captured.
import { createVegaClient, type ErrorUtilsLike, type HermesInternalLike, type VegaStatus } from './client.js';
import type { VegaBreadcrumb, VegaCaptureOptions, VegaConfig, VegaUser } from './config.js';
import { readDevice } from './device.js';
import type { FetchLike } from './transport.js';

export type {
  AsyncStorageLike,
  BreadcrumbKind,
  VegaBreadcrumb,
  VegaCaptureOptions,
  VegaConfig,
  VegaUser,
} from './config.js';
export type { VegaStatus, RejectionStatus } from './client.js';
export { SDK_VERSION } from './version.js';

type VegaGlobal = typeof globalThis & {
  ErrorUtils?: ErrorUtilsLike;
  HermesInternal?: HermesInternalLike;
  __DEV__?: boolean;
};

const host = globalThis as VegaGlobal;

// Globals are read when init() runs, not when this module loads, so an import
// that happens to run before React Native's InitializeCore still works.
const client = createVegaClient({
  get errorUtils() {
    return host.ErrorUtils;
  },
  get hermes() {
    return host.HermesInternal;
  },
  get fetch() {
    return typeof host.fetch === 'function' ? (host.fetch.bind(host) as unknown as FetchLike) : undefined;
  },
  now: () => Date.now(),
  random: () => Math.random(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  readDevice,
  probeStack: () => new Error('everframe bundle probe').stack,
  get dev() {
    return host.__DEV__ === true;
  },
  warn: (message) => {
    try {
      console.warn(message);
    } catch {
      // Logging is best effort.
    }
  },
});

/** Start Everframe. Call once, at the top of index.js. Later calls are ignored. */
export function init(config: VegaConfig): void {
  client.init(config);
}

/** Report a caught error. `options` adds severity, a context label and metadata. */
export function captureException(error: unknown, options?: VegaCaptureOptions): void {
  client.captureException(error, options);
}

/** Attach a self-declared user to later reports. `null` clears it. */
export function setUser(user: VegaUser | null): void {
  client.setUser(user);
}

/** Add a breadcrumb (latest 100 are kept) to later reports. */
export function addBreadcrumb(crumb: VegaBreadcrumb): void {
  client.addBreadcrumb(crumb);
}

/** Resolves after pending reports were stored and one delivery attempt ran. */
export function flush(): Promise<void> {
  return client.flush();
}

/** What the SDK is doing: for support requests and tests, not for app logic. */
export function getStatus(): VegaStatus {
  return client.getStatus();
}
