// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Fakes for the platform globals the Vega client reads: ErrorUtils,
// HermesInternal's rejection tracker, fetch and AsyncStorage.
import { z } from 'zod';
import { ReportEnvelope } from '@everframe/protocol';
import type { ErrorUtilsLike, HermesInternalLike, RejectionTrackerOptions, VegaEnvironment } from '../src/client.js';
import type { AsyncStorageLike } from '../src/config.js';
import { OUTBOX_KEY, type OutboxItem } from '../src/outbox.js';
import { readDevice } from '../src/device.js';

export const BUNDLE_ID = '9f2c4be1d07a5e3368c1b0f4a2d97e5c1b8a6f3d2e0c9b7a5f4e3d2c1b0a9f8e';
export const BUILD_DIR = '/Users/dev/projects/tv-app/build/lib/rn-bundles/Release';

/** A Hermes stack as Vega OS release builds print it. */
export function vegaStack(header: string, fn = 'onPress', line = 41237): string {
  return [
    header,
    `    at ${fn} (${BUILD_DIR}/${BUNDLE_ID}.bundle:${line}:24)`,
    `    at anonymous (${BUILD_DIR}/${BUNDLE_ID}.bundle:41250:9)`,
    '    at callTimer (node_modules/@amzn/react-native-kepler/Libraries/Core/Timers/JSTimers.js:248:14)',
  ].join('\n');
}

export function vegaError(message: string, opts: { name?: string; fn?: string; line?: number } = {}): Error {
  const error = new Error(message);
  if (opts.name) error.name = opts.name;
  error.stack = vegaStack(`${opts.name ?? 'Error'}: ${message}`, opts.fn, opts.line);
  return error;
}

export interface FakeStorage extends AsyncStorageLike {
  data: Map<string, string>;
  writes: string[];
  /** Resolves pending getItem calls (when created with `deferLoad`). */
  releaseLoad(): void;
  /** Never settle setItem (a storage that hangs under a fatal). */
  hangWrites: boolean;
  failWrites: boolean;
}

export function createStorage(opts: { deferLoad?: boolean; initial?: OutboxItem[] } = {}): FakeStorage {
  const data = new Map<string, string>();
  if (opts.initial) data.set(OUTBOX_KEY, JSON.stringify(opts.initial));
  let release: () => void = () => undefined;
  const loadGate = opts.deferLoad ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();
  const storage: FakeStorage = {
    data,
    writes: [],
    hangWrites: false,
    failWrites: false,
    releaseLoad: () => release(),
    async getItem(key) {
      await loadGate;
      return data.get(key) ?? null;
    },
    async setItem(key, value) {
      if (storage.hangWrites) return new Promise<void>(() => undefined);
      if (storage.failWrites) throw new Error('disk full');
      storage.writes.push(key);
      data.set(key, value);
    },
  };
  return storage;
}

export function stored(storage: FakeStorage): OutboxItem[] {
  const raw = storage.data.get(OUTBOX_KEY);
  return raw ? (JSON.parse(raw) as OutboxItem[]) : [];
}

export interface FakeErrorUtils extends ErrorUtilsLike {
  handler: ((error: unknown, isFatal?: boolean) => void) | undefined;
  previous: Array<{ error: unknown; isFatal: boolean | undefined; at: number }>;
}

export function createErrorUtils(order: string[] = []): FakeErrorUtils {
  const utils: FakeErrorUtils = {
    handler: undefined,
    previous: [],
    getGlobalHandler: () => (error: unknown, isFatal?: boolean) => {
      order.push('default-handler');
      utils.previous.push({ error, isFatal, at: Date.now() });
    },
    setGlobalHandler(handler) {
      utils.handler = handler;
    },
  };
  return utils;
}

export interface FakeHermes extends HermesInternalLike {
  options: RejectionTrackerOptions | undefined;
}

export function createHermes(): FakeHermes {
  const hermes: FakeHermes = {
    options: undefined,
    enablePromiseRejectionTracker(options) {
      hermes.options = options;
    },
  };
  return hermes;
}

export interface SentRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  envelope: Record<string, any>;
}

export interface FakeFetch {
  (url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<{ status: number }>;
  requests: SentRequest[];
  /** Status codes returned in order; the last one repeats. `0` throws a network error. */
  statuses: number[];
}

export function createFetch(statuses: number[] = [200], order: string[] = []): FakeFetch {
  const fetch = (async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    order.push('fetch');
    fetch.requests.push({ url, headers: init.headers, body: init.body, envelope: JSON.parse(init.body) });
    const status = fetch.statuses.length > 1 ? fetch.statuses.shift()! : fetch.statuses[0]!;
    if (status === 0) throw new TypeError('Network request failed');
    return { status };
  }) as FakeFetch;
  fetch.requests = [];
  fetch.statuses = statuses;
  return fetch;
}

export interface Harness {
  env: VegaEnvironment;
  errorUtils: FakeErrorUtils;
  hermes: FakeHermes;
  fetch: FakeFetch;
  warnings: string[];
}

export function createEnv(overrides: Partial<VegaEnvironment> & { statuses?: number[]; order?: string[] } = {}): Harness {
  const order = overrides.order ?? [];
  const errorUtils = createErrorUtils(order);
  const hermes = createHermes();
  const fetch = createFetch(overrides.statuses ?? [200], order);
  const warnings: string[] = [];
  let seed = 1;
  const env: VegaEnvironment = {
    errorUtils,
    hermes,
    fetch,
    now: () => Date.now(),
    // Deterministic but distinct report ids.
    random: () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    readDevice,
    probeStack: () => vegaStack('Error: everframe bundle probe', 'probe', 12),
    dev: false,
    warn: (message) => warnings.push(message),
    ...overrides,
  };
  return { env, errorUtils, hermes, fetch, warnings };
}

/** The server's parse: the protocol schema, strict at the envelope root. */
const Strict = (ReportEnvelope as unknown as z.ZodObject<z.ZodRawShape>).catchall(z.never());

export function expectValidEnvelope(envelope: unknown): void {
  const result = Strict.safeParse(envelope);
  if (!result.success) throw new Error(`envelope rejected: ${JSON.stringify(result.error.issues, null, 2)}`);
}
