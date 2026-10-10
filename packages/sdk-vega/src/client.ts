// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The Vega OS client. Every platform global it touches arrives through
// `VegaEnvironment`, so the whole capture → persist → deliver path runs in
// Node tests with fakes; src/index.ts wires the real globals.
import { createBreadcrumbBuffer, type DeviceMetadata } from '@everframe/sdk-core';
import { captureKey, jsBundleFor, probeBundleId, stripBuildPath } from './bundle.js';
import {
  resolveConfig,
  type ResolvedConfig,
  type VegaBreadcrumb,
  type VegaCaptureOptions,
  type VegaConfig,
  type VegaUser,
} from './config.js';
import { buildVegaEnvelope } from './envelope.js';
import { extractFacts, isErrorValue, renderLabel, renderValue } from './error-facts.js';
import { uuidV4 } from './ids.js';
import { createOutbox, type Outbox, type OutboxItem } from './outbox.js';
import { sendReport, type FetchLike } from './transport.js';
import { SDK_VERSION } from './version.js';

type GlobalHandler = (error: unknown, isFatal?: boolean) => void;

export interface ErrorUtilsLike {
  getGlobalHandler(): GlobalHandler | undefined | null;
  setGlobalHandler(handler: GlobalHandler): void;
}

export interface RejectionTrackerOptions {
  allRejections: boolean;
  onUnhandled: (id: number, rejection: unknown) => void;
  onHandled: (id: number) => void;
}

export interface HermesInternalLike {
  enablePromiseRejectionTracker?: (options: RejectionTrackerOptions) => void;
}

export interface VegaEnvironment {
  errorUtils: ErrorUtilsLike | undefined;
  hermes: HermesInternalLike | undefined;
  fetch: FetchLike | undefined;
  now: () => number;
  random: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  readDevice: (overrides: { model?: string; osVersion?: string }) => DeviceMetadata;
  /** A stack captured from inside this bundle, for the bundle id. */
  probeStack: () => string | undefined;
  /** React Native's `__DEV__`. */
  dev: boolean;
  warn: (message: string) => void;
}

export type RejectionStatus = 'observed' | 'unavailable' | 'disabled' | 'off';

export interface VegaStatus {
  /** `init` ran with a usable SDK key and `enabled` not false. */
  enabled: boolean;
  /** The running bundle's id, or null (Debug builds served by Metro have none). */
  bundleId: string | null;
  /** Whether unhandled promise rejections are observed. */
  rejections: RejectionStatus;
  /** Reports waiting for delivery. */
  pending: number;
}

export type Mechanism = 'errorutils' | 'unhandledrejection' | 'captureException';

export interface VegaClient {
  init(config: VegaConfig): void;
  captureException(error: unknown, options?: VegaCaptureOptions): void;
  setUser(user: VegaUser | null): void;
  addBreadcrumb(crumb: VegaBreadcrumb): void;
  flush(): Promise<void>;
  getStatus(): VegaStatus;
}

/** How long a fatal may hold RN's default handler (which aborts the JS thread). */
export const FATAL_HANDOFF_MS = 1500;
export const RETRY_DELAYS_MS = [2_000, 10_000, 60_000, 300_000] as const;
const AUTOMATIC_KEYS_MAX = 10;
const VALUE_KEYS_MAX = 5;
const HANDLED_KEYS_MAX = 10;
const VALUE_KEY = 'UnhandledValue:value-';
const SDK = { name: 'everframe-vega', version: SDK_VERSION, platform: 'vega', formFactor: 'tv' } as const;

const BREADCRUMB_KINDS = new Set(['navigation', 'tap', 'console', 'network', 'lifecycle', 'error', 'custom']);
const BREADCRUMB_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

/** Non-Error values have no frame: key them by their digit-insensitive value. */
function valueKey(message: string): string {
  const value = message.replace(/\d+/g, '#');
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 0x01000193);
  return `${VALUE_KEY}${(hash >>> 0).toString(16)}`;
}

function cleanUser(user: VegaUser | null | undefined): VegaUser | null {
  if (!user || typeof user !== 'object') return null;
  const out: VegaUser = {};
  if (typeof user.id === 'string') out.id = user.id;
  if (typeof user.email === 'string') out.email = user.email;
  if (typeof user.displayName === 'string') out.displayName = user.displayName;
  return Object.keys(out).length > 0 ? out : null;
}

export function createVegaClient(env: VegaEnvironment): VegaClient {
  let config: ResolvedConfig | null = null;
  let phase: 'idle' | 'running' | 'disabled' = 'idle';
  let outbox: Outbox | undefined;
  let bundleId: string | undefined;
  let device: DeviceMetadata | undefined;
  let user: VegaUser | null = null;
  let rejections: RejectionStatus = 'off';
  const breadcrumbs = createBreadcrumbBuffer({ now: env.now });
  const automaticKeys = new Set<string>();
  const handledKeys = new Set<string>();
  const accepted = new WeakSet<object>();
  let capturing = false;
  const inFlight = new Set<string>();
  let draining: Promise<void> | undefined;
  const deliveries = new Set<Promise<void>>();
  let retryTimer: unknown;
  let failures = 0;
  /** Per report: no automatic attempt before this time (this launch only). */
  const notBefore = new Map<string, number>();

  function admit(mechanism: Mechanism, fatal: boolean, key: string, value: unknown): boolean {
    if (fatal) return true;
    if (mechanism === 'captureException') {
      if (typeof value === 'object' && value !== null && accepted.has(value)) return false;
      if (handledKeys.has(key) || handledKeys.size >= HANDLED_KEYS_MAX) return false;
      return true;
    }
    if (typeof value === 'object' && value !== null && accepted.has(value)) return false;
    if (automaticKeys.has(key) || automaticKeys.size >= AUTOMATIC_KEYS_MAX) return false;
    if (key.startsWith(VALUE_KEY)) {
      let spent = 0;
      automaticKeys.forEach((existing) => {
        if (existing.startsWith(VALUE_KEY)) spent++;
      });
      if (spent >= VALUE_KEYS_MAX) return false;
    }
    return true;
  }

  function remember(mechanism: Mechanism, key: string, value: unknown): void {
    (mechanism === 'captureException' ? handledKeys : automaticKeys).add(key);
    if (typeof value === 'object' && value !== null) accepted.add(value);
  }

  function buildItem(
    value: unknown,
    mechanism: Mechanism,
    fatal: boolean,
    options: VegaCaptureOptions | undefined,
  ): OutboxItem | undefined {
    if (!config || !device) return undefined;
    // Rejected non-Error values are often responses or request configs:
    // report their type, never their contents (same rule as the RN SDK).
    const labelled = mechanism === 'unhandledrejection' && !isErrorValue(value);
    const facts = extractFacts(value, labelled ? renderLabel : renderValue);
    const framesRaw = facts.framesRaw.map(stripBuildPath);
    const key = facts.exceptionType === 'UnhandledValue' && framesRaw.length === 0
      ? valueKey(facts.message)
      : captureKey(facts.exceptionType, framesRaw);
    if (!admit(mechanism, fatal, key, value)) return undefined;
    const reportId = uuidV4(env.random);
    const envelope = buildVegaEnvelope({
      reportId,
      occurredAt: new Date(env.now()).toISOString(),
      exceptionType: facts.exceptionType,
      message: facts.message,
      framesRaw,
      mechanism,
      fatal,
      handledOptions: mechanism === 'captureException' ? options : undefined,
      jsBundle: bundleId ? jsBundleFor(bundleId) : undefined,
      sdk: { ...SDK },
      app: config.app,
      device,
      breadcrumbs: breadcrumbs.snapshot(),
      user,
    });
    remember(mechanism, key, value);
    return { reportId, body: JSON.stringify(envelope), enqueuedAt: env.now(), attempts: 0, fatal };
  }

  const retryDelay = (): number =>
    RETRY_DELAYS_MS[Math.min(Math.max(failures, 1), RETRY_DELAYS_MS.length) - 1] ?? RETRY_DELAYS_MS[0];

  function scheduleRetry(): void {
    if (retryTimer !== undefined || phase !== 'running') return;
    retryTimer = env.setTimeout(() => {
      retryTimer = undefined;
      void drain();
    }, retryDelay());
  }

  /** One attempt for one item; the item stays stored until the server answers for good. */
  async function attempt(item: OutboxItem): Promise<'sent' | 'drop' | 'retry' | 'busy'> {
    if (inFlight.has(item.reportId)) return 'busy';
    if (!config || !outbox || !env.fetch) return 'retry';
    inFlight.add(item.reportId);
    try {
      const result = await sendReport(
        { fetch: env.fetch, setTimeout: env.setTimeout, clearTimeout: env.clearTimeout },
        config.ingestUrl,
        config.sdkKey,
        item.body,
      );
      if (result.outcome === 'retry') {
        failures++;
        notBefore.set(item.reportId, env.now() + retryDelay());
        await outbox.recordAttempt(item.reportId);
      } else {
        if (result.outcome === 'sent') failures = 0;
        notBefore.delete(item.reportId);
        await outbox.remove(item.reportId);
      }
      return result.outcome;
    } catch {
      return 'retry';
    } finally {
      inFlight.delete(item.reportId);
    }
  }

  /** `force` ignores the backoff (an explicit flush), never the in-flight guard. */
  function drain(force = false): Promise<void> {
    if (draining) return draining;
    const run = (async () => {
      if (!outbox) return;
      await outbox.ready;
      // Let live sends finish first so an item is never sent twice at once.
      await Promise.all(Array.from(deliveries));
      let retry = false;
      for (const item of await outbox.due()) {
        const waitUntil = notBefore.get(item.reportId);
        if (!force && waitUntil !== undefined && waitUntil > env.now()) {
          retry = true;
          continue;
        }
        if ((await attempt(item)) === 'retry') {
          retry = true;
          // The server or network is down; later items would fail the same way.
          break;
        }
      }
      if (retry) scheduleRetry();
    })();
    draining = run.catch(() => undefined).then(() => {
      draining = undefined;
    });
    return draining;
  }

  /** Persist first, then one live attempt. Resolves when both are done. */
  async function deliver(item: OutboxItem): Promise<void> {
    if (!outbox) return;
    await outbox.add(item);
    if ((await attempt(item)) === 'retry') {
      if (!item.fatal) scheduleRetry();
    } else if (outbox.size() > 0 && !item.fatal) {
      void drain();
    }
  }

  function capture(
    value: unknown,
    mechanism: Mechanism,
    fatal: boolean,
    options?: VegaCaptureOptions,
  ): Promise<void> | undefined {
    if (phase !== 'running' || capturing) return undefined;
    capturing = true;
    let item: OutboxItem | undefined;
    try {
      item = buildItem(value, mechanism, fatal, options);
    } catch {
      item = undefined;
    } finally {
      capturing = false;
    }
    if (!item) return undefined;
    const delivery: Promise<void> = deliver(item)
      .catch(() => undefined)
      .then(() => {
        deliveries.delete(delivery);
      });
    deliveries.add(delivery);
    return delivery;
  }

  function describeRejection(rejection: unknown): string {
    try {
      return isErrorValue(rejection)
        ? `${String((rejection as Error).name)}: ${String((rejection as Error).message)}`.slice(0, 200)
        : renderLabel(rejection).slice(0, 200);
    } catch {
      return '[unrenderable]';
    }
  }

  function installErrorHandler(): void {
    const errorUtils = env.errorUtils;
    if (!errorUtils || typeof errorUtils.setGlobalHandler !== 'function') return;
    let previous: GlobalHandler | undefined | null;
    try {
      previous = errorUtils.getGlobalHandler();
    } catch {
      previous = undefined;
    }
    const chain = (error: unknown, isFatal?: boolean) => {
      if (typeof previous === 'function') previous(error, isFatal);
    };
    errorUtils.setGlobalHandler((error: unknown, isFatal?: boolean) => {
      const fatal = isFatal === true;
      let work: Promise<void> | undefined;
      try {
        work = capture(error, 'errorutils', fatal);
      } catch {
        work = undefined;
      }
      if (!fatal || !work) {
        chain(error, isFatal);
        return;
      }
      // RN's default handler aborts the JS thread on Vega. Hold it until the
      // report is stored and one send was tried, never longer than the cap.
      let handedOff = false;
      let timer: unknown;
      const handOff = () => {
        if (handedOff) return;
        handedOff = true;
        env.clearTimeout(timer);
        chain(error, isFatal);
      };
      timer = env.setTimeout(handOff, FATAL_HANDOFF_MS);
      work.then(handOff, handOff);
    });
  }

  function installRejectionTracker(): void {
    if (!config?.captureUnhandledRejections) {
      rejections = 'disabled';
      return;
    }
    const enable = env.hermes?.enablePromiseRejectionTracker;
    if (typeof enable !== 'function') {
      rejections = 'unavailable';
      return;
    }
    try {
      // Replaces React Native's own tracker, which runs only in __DEV__ and
      // only warns. Release builds otherwise drop rejections silently.
      enable.call(env.hermes, {
        allRejections: true,
        onUnhandled: (_id, rejection) => {
          // The SDK's tracker replaces RN's development warning; keep one.
          if (env.dev) env.warn(`[everframe] unhandled promise rejection: ${describeRejection(rejection)}`);
          capture(rejection, 'unhandledrejection', false);
        },
        onHandled: () => undefined,
      });
      rejections = 'observed';
    } catch {
      rejections = 'unavailable';
    }
  }

  return {
    init(input) {
      if (phase !== 'idle') {
        if (env.dev) env.warn('[everframe] init() was already called; this call is ignored');
        return;
      }
      if (input?.enabled === false) {
        phase = 'disabled';
        return;
      }
      const resolved = resolveConfig(input);
      if (!resolved) {
        env.warn('[everframe] init() needs an sdkKey; Everframe is off');
        phase = 'disabled';
        return;
      }
      config = resolved;
      try {
        bundleId = probeBundleId(env.probeStack());
      } catch {
        bundleId = undefined;
      }
      try {
        device = env.readDevice(resolved.device);
      } catch {
        device = {
          os: 'Vega OS', osVersion: '', screenSize: { width: 0, height: 0 }, pixelRatio: 1, locale: 'und', timezone: 'UTC',
        };
      }
      if (!resolved.storage && env.dev) {
        env.warn('[everframe] no storage passed to init(); a crash that cannot be sent before the app stops is lost');
      }
      outbox = createOutbox({ storage: resolved.storage, now: env.now, warn: env.warn });
      phase = 'running';
      try {
        installErrorHandler();
      } catch {
        // A host whose ErrorUtils throws still gets captureException and replay.
      }
      installRejectionTracker();
      void drain();
    },
    captureException(error, options) {
      capture(error, 'captureException', false, options);
    },
    setUser(next) {
      user = cleanUser(next);
    },
    addBreadcrumb(crumb) {
      if (!crumb || typeof crumb.message !== 'string') return;
      try {
        breadcrumbs.add({
          kind: crumb.kind && BREADCRUMB_KINDS.has(crumb.kind) ? crumb.kind : 'custom',
          message: crumb.message,
          ...(crumb.level && BREADCRUMB_LEVELS.has(crumb.level) ? { level: crumb.level } : {}),
          ...(crumb.data && typeof crumb.data === 'object' ? { data: crumb.data } : {}),
        });
      } catch {
        // A breadcrumb is never worth an exception in the host.
      }
    },
    flush() {
      if (phase !== 'running') return Promise.resolve();
      return Promise.all(Array.from(deliveries)).then(() => drain(true));
    },
    getStatus() {
      return {
        enabled: phase === 'running',
        bundleId: bundleId ?? null,
        rejections,
        pending: outbox?.size() ?? 0,
      };
    },
  };
}
