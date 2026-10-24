// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Fakes for the platform globals the Vega client reads: ErrorUtils,
// HermesInternal's rejection tracker, fetch and AsyncStorage.
import { z } from 'zod';
import { ReportEnvelope } from '@everframe/protocol';
import type {
  ErrorUtilsLike,
  HermesInternalLike,
  RejectionTrackerOptions,
  VegaEnvironment,
} from '../src/client.js';
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

export function vegaError(
  message: string,
  opts: { name?: string; fn?: string; line?: number } = {},
): Error {
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

export function createStorage(
  opts: { deferLoad?: boolean; initial?: OutboxItem[] } = {},
): FakeStorage {
  const data = new Map<string, string>();
  if (opts.initial) data.set(OUTBOX_KEY, JSON.stringify(opts.initial));
  let release: () => void = () => undefined;
  const loadGate = opts.deferLoad
    ? new Promise<void>((resolve) => (release = resolve))
    : Promise.resolve();
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
  method: string;
  headers: Record<string, string>;
  body: string;
  envelope: Record<string, any>;
  redirect?: string;
}

/** What a routed request answers. `status: 0` throws a network error. */
export interface RouteReply {
  status: number;
  body?: unknown;
  /** The response's final URL (a redirect); defaults to the request URL. */
  url?: string;
  /** Resolve this to let the reply through; never resolving hangs the request. */
  gate?: Promise<void>;
}

export type RouteHandler = RouteReply | RouteReply[] | ((req: SentRequest) => RouteReply);

interface Route {
  method: string;
  path: string | RegExp;
  reply: RouteHandler;
}

export interface FakeResponse {
  status: number;
  ok: boolean;
  url: string;
  text: () => Promise<string>;
}

export interface FakeFetch {
  (
    url: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body?: string;
      signal?: unknown;
      redirect?: 'error';
    },
  ): Promise<FakeResponse>;
  /** POSTs other than device-link calls: ingest and release health, as before. */
  requests: SentRequest[];
  /** Every request, in order, including `GET /api/config` and device-link calls. */
  all: SentRequest[];
  /** Status codes returned in order for unrouted POSTs; the last one repeats. `0` throws. */
  statuses: number[];
  /** Answer `method path` (exact path or a RegExp on the path) with `reply`. */
  route(method: string, path: string | RegExp, reply: RouteHandler): void;
}

function pathOf(url: string): string {
  return url.replace(/^[a-z]+:\/\/[^/]*/i, '').replace(/\?.*$/, '');
}

function parseBody(body: string | undefined): Record<string, any> {
  if (typeof body !== 'string' || body.length === 0) return {};
  try {
    return JSON.parse(body) as Record<string, any>;
  } catch {
    return {};
  }
}

export function createFetch(statuses: number[] = [200], order: string[] = []): FakeFetch {
  const routes: Route[] = [];
  const respond = async (url: string, reply: RouteReply): Promise<FakeResponse> => {
    if (reply.gate) await reply.gate;
    if (reply.status === 0) throw new TypeError('Network request failed');
    const text =
      reply.body === undefined
        ? ''
        : typeof reply.body === 'string'
          ? reply.body
          : JSON.stringify(reply.body);
    return {
      status: reply.status,
      ok: reply.status >= 200 && reply.status < 300,
      url: reply.url ?? url,
      text: async () => text,
    };
  };
  const fetch = (async (
    url: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body?: string;
      redirect?: 'error';
    },
  ) => {
    order.push('fetch');
    const method = (init.method ?? 'GET').toUpperCase();
    const path = pathOf(url);
    const request: SentRequest = {
      url,
      method,
      headers: init.headers,
      body: init.body ?? '',
      envelope: parseBody(init.body),
      ...(init.redirect ? { redirect: init.redirect } : {}),
    };
    fetch.all.push(request);
    const isLinkCall = path.startsWith('/api/device-link/');
    if (method === 'POST' && !isLinkCall) fetch.requests.push(request);
    const route = routes.find(
      (r) =>
        r.method === method && (typeof r.path === 'string' ? r.path === path : r.path.test(path)),
    );
    if (route) {
      let reply: RouteReply;
      if (typeof route.reply === 'function') reply = route.reply(request);
      else if (Array.isArray(route.reply))
        reply = route.reply.length > 1 ? route.reply.shift()! : route.reply[0]!;
      else reply = route.reply;
      return respond(url, reply);
    }
    if (method !== 'POST' || isLinkCall) return respond(url, { status: 404 });
    const status = fetch.statuses.length > 1 ? fetch.statuses.shift()! : fetch.statuses[0]!;
    return respond(url, { status });
  }) as FakeFetch;
  fetch.requests = [];
  fetch.all = [];
  fetch.statuses = statuses;
  fetch.route = (method, path, reply) => {
    routes.unshift({ method: method.toUpperCase(), path, reply });
  };
  return fetch;
}

export interface Harness {
  env: VegaEnvironment;
  errorUtils: FakeErrorUtils;
  hermes: FakeHermes;
  fetch: FakeFetch;
  warnings: string[];
}

export function createEnv(
  overrides: Partial<VegaEnvironment> & { statuses?: number[]; order?: string[] } = {},
): Harness {
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
  if (!result.success)
    throw new Error(`envelope rejected: ${JSON.stringify(result.error.issues, null, 2)}`);
}
