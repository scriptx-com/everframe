// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The Vega OS client. Every platform global it touches arrives through
// `VegaEnvironment`, so the whole capture → persist → deliver path runs in
// Node tests with fakes; src/index.ts wires the real globals.
import { createBreadcrumbBuffer, sha256Hex, type DeviceMetadata } from '@everframe/sdk-core';
import { captureKey, jsBundleFor, probeBundleId, stripBuildPath } from './bundle.js';
import {
  resolveConfig,
  type ResolvedConfig,
  type VegaBreadcrumb,
  type VegaCaptureOptions,
  type VegaConfig,
  type VegaUser,
} from './config.js';
import { createDeviceLink, type DeviceLink } from './device-link.js';
import {
  bindingsEqual,
  createGestureDetector,
  DEFAULT_TV_BINDING,
  resolveTvBinding,
  type GestureBinding,
  type GestureDetector,
} from './gesture-detector.js';
import { createGestureRecording, type GestureRecording } from './gesture-recording.js';
import { buildQuickCaptureEnvelope, buildVegaEnvelope } from './envelope.js';
import { extractFacts, isErrorValue, renderLabel, renderValue } from './error-facts.js';
import { uuidV4 } from './ids.js';
import {
  createOutbox,
  sameBinding,
  type Outbox,
  type OutboxBinding,
  type OutboxItem,
} from './outbox.js';
import { createLinkClient, helloDevice } from './link-client.js';
import { capturedToast, CAPTURE_FAILED, deviceLabel, DEVICE_UNLINKED } from './link-copy.js';
import { createLinkStore } from './link-store.js';
import { createNonce, linkScope, randomBytes, tokenFingerprint } from './link-token.js';
import {
  createOverlayStore,
  installRootWrapper,
  type AppRegistryLike,
  type HWEventLike,
  type OverlayStore,
} from './overlay.js';
import {
  CAPTURE_COOLDOWN_MS,
  CAPTURE_TOKEN_HEADER,
  decide,
  isArmed,
  isDeviceUnlinked,
  LINK_NONCE_HEADER,
  parseLinkPending,
  REPLIES_OPT_OUT_HEADER,
  type GestureInput,
} from './quick-capture.js';
import { fetchRemoteConfig, type RemoteConfig } from './remote-config.js';
import { keyAction, keyForVegaEvent } from './remote-keys.js';
import { sendReport, type FetchLike, type SendDeps } from './transport.js';
import { SDK_VERSION } from './version.js';
import { createReleaseHealth, HEALTH_OUTBOX_KEY, type AppStateLike } from './release-health.js';
import type { NativeExposurePointer } from '@everframe/protocol';

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
  /** Qualified React Native for Vega 0.72 lifecycle; absent means health is unavailable. */
  appState?: AppStateLike | undefined;
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
  /** React Native's `AppRegistry`, for the root wrapper; absent means no quick capture. */
  appRegistry?: AppRegistryLike | undefined;
  /** `globalThis.crypto`, read only for `getRandomValues` (Vega OS 1.1 has none). */
  crypto?: unknown;
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

/** Quick-capture internals: the root wrapper and tests call these, the public API does not. */
export interface QuickCaptureInternals {
  /** The capture gesture fired. */
  onGesture(): void;
  /** One remote key event from the root wrapper. */
  onRemoteKey(event: HWEventLike): void;
  gestureInput(): GestureInput;
  armed(): boolean;
  /** Re-reads `/api/config`. */
  refreshConfig(): void;
  /** For tests only. */
  quickCaptureParts(): {
    overlay?: OverlayStore;
    deviceLink?: DeviceLink;
    remote: RemoteConfig | null;
  };
}

/** What a live quick-capture upload carries besides the stored item. */
interface LiveUpload {
  /** The takeover nonce; set only on a linked device's live upload. */
  nonce?: string;
  /** The link generation when the capture was taken. */
  generation: number;
}

/** How long a fatal may hold RN's default handler (which aborts the JS thread). */
export const FATAL_HANDOFF_MS = 1500;
export const RETRY_DELAYS_MS = [2_000, 10_000, 60_000, 300_000] as const;
/** A linked device re-reads `/api/config` when it comes to the foreground, at most this often. */
export const FOREGROUND_REFRESH_MS = 10_000;
export const UNSUPPORTED_BINDING_WARNING =
  '[everframe] the capture gesture uses keys a Vega remote does not have; quick capture is off on this device';
const AUTOMATIC_KEYS_MAX = 10;
const VALUE_KEYS_MAX = 5;
const HANDLED_KEYS_MAX = 10;
const VALUE_KEY = 'UnhandledValue:value-';
const SDK = {
  name: 'everframe-vega',
  version: SDK_VERSION,
  platform: 'vega',
  formFactor: 'tv',
} as const;

const BREADCRUMB_KINDS = new Set([
  'navigation',
  'tap',
  'console',
  'network',
  'lifecycle',
  'error',
  'custom',
]);
const BREADCRUMB_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

/** Non-Error values have no frame: key them by their digit-insensitive value. */
function valueKey(message: string): string {
  const value = message.replace(/\d+/g, '#');
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 0x01000193);
  return `${VALUE_KEY}${(hash >>> 0).toString(16)}`;
}

/**
 * Where reports captured under `config` may go. The key is stored only as a
 * truncated, domain-separated SHA-256: enough to tell keys apart, never enough
 * to send with.
 */
export function outboxBinding(config: { ingestUrl: string; sdkKey: string }): OutboxBinding {
  return {
    endpoint: config.ingestUrl,
    keyHash: sha256Hex(`everframe-vega/outbox-key\n${config.sdkKey}`).slice(0, 32),
  };
}

function cleanUser(user: VegaUser | null | undefined): VegaUser | null {
  if (!user || typeof user !== 'object') return null;
  const out: VegaUser = {};
  if (typeof user.id === 'string') out.id = user.id;
  if (typeof user.email === 'string') out.email = user.email;
  if (typeof user.displayName === 'string') out.displayName = user.displayName;
  return Object.keys(out).length > 0 ? out : null;
}

export function createVegaClient(env: VegaEnvironment): VegaClient & QuickCaptureInternals {
  let config: ResolvedConfig | null = null;
  let health: ReturnType<typeof createReleaseHealth> | undefined;
  let binding: OutboxBinding | undefined;
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
  const debug = (message: string) => {
    if (env.dev) env.warn(message);
  };
  // Quick capture (only when init() installed the root wrapper).
  let overlay: OverlayStore | undefined;
  let deviceLink: DeviceLink | undefined;
  let remote: RemoteConfig | null = null;
  let configSeq = 0;
  let configApplied = 0;
  let lastConfigAt = -Infinity;
  let gestureBusy = false;
  let detector: GestureDetector | undefined;
  /** The binding in effect; null when the app's binding uses keys Vega lacks. */
  let tvBinding: GestureBinding | null = DEFAULT_TV_BINDING;
  let warnedUnsupported = false;
  let recording: GestureRecording | undefined;
  /** Keys that went down during a recording; kept from the gesture until their up. */
  const heldThroughRecording = new Set<string>();
  let lastGestureAt = -Infinity;

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
    nativeExposure?: NativeExposurePointer,
  ): OutboxItem | undefined {
    if (!config || !device) return undefined;
    // Rejected non-Error values are often responses or request configs:
    // report their type, never their contents (same rule as the RN SDK).
    const labelled = mechanism === 'unhandledrejection' && !isErrorValue(value);
    const facts = extractFacts(value, labelled ? renderLabel : renderValue);
    const framesRaw = facts.framesRaw.map(stripBuildPath);
    const key =
      facts.exceptionType === 'UnhandledValue' && framesRaw.length === 0
        ? valueKey(facts.message)
        : captureKey(facts.exceptionType, framesRaw, facts.message);
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
      nativeExposure,
      handledOptions: mechanism === 'captureException' ? options : undefined,
      jsBundle: bundleId ? jsBundleFor(bundleId) : undefined,
      sdk: { ...SDK },
      app: config.app,
      device,
      breadcrumbs: breadcrumbs.snapshot(),
      user,
    });
    remember(mechanism, key, value);
    return {
      reportId,
      body: JSON.stringify(envelope),
      enqueuedAt: env.now(),
      attempts: 0,
      fatal,
      ...binding!,
    };
  }

  const retryDelay = (): number =>
    RETRY_DELAYS_MS[Math.min(Math.max(failures, 1), RETRY_DELAYS_MS.length) - 1] ??
    RETRY_DELAYS_MS[0];

  function scheduleRetry(): void {
    if (retryTimer !== undefined || phase !== 'running') return;
    retryTimer = env.setTimeout(() => {
      retryTimer = undefined;
      void drain();
    }, retryDelay());
  }

  function sendDeps(): SendDeps | undefined {
    return env.fetch
      ? { fetch: env.fetch, setTimeout: env.setTimeout, clearTimeout: env.clearTimeout }
      : undefined;
  }

  async function settle(item: OutboxItem, outcome: 'sent' | 'drop' | 'retry'): Promise<void> {
    if (!outbox) return;
    if (outcome === 'retry') {
      failures++;
      notBefore.set(item.reportId, env.now() + retryDelay());
      await outbox.recordAttempt(item.reportId);
    } else {
      if (outcome === 'sent') failures = 0;
      notBefore.delete(item.reportId);
      await outbox.remove(item.reportId);
    }
  }

  async function dropUnsent(item: OutboxItem): Promise<'drop'> {
    notBefore.delete(item.reportId);
    await outbox?.remove(item.reportId);
    return 'drop';
  }

  /**
   * A quick capture. A linked one goes out only while the device still holds
   * the token it was captured under, so a retry is never filed into the
   * shared inbox or under the next owner. `live` is set only for the upload
   * right after the gesture: only that one carries the takeover nonce and
   * shows a toast.
   */
  async function attemptQuickCapture(
    item: OutboxItem,
    live: LiveUpload | undefined,
  ): Promise<'sent' | 'drop' | 'retry' | 'wait'> {
    if (!config || !outbox) return 'retry';
    let token: string | null = null;
    if (item.linkFingerprint !== undefined) {
      if (!deviceLink) return dropUnsent(item);
      if (!deviceLink.isLoaded()) return 'wait';
      const current = deviceLink.current();
      if (!current || tokenFingerprint(current.token) !== item.linkFingerprint) {
        debug(
          '[everframe] dropped a quick capture taken under a device link this device no longer holds',
        );
        return dropUnsent(item);
      }
      token = current.token;
    }
    const headers: Record<string, string> = { [REPLIES_OPT_OUT_HEADER]: '1' };
    if (token) {
      headers[CAPTURE_TOKEN_HEADER] = token;
      if (live?.nonce) headers[LINK_NONCE_HEADER] = live.nonce;
    }
    const result = await sendReport(sendDeps()!, config.ingestUrl, config.sdkKey, item.body, {
      headers,
      readBody: true,
    });
    if (token && isDeviceUnlinked(result.status, result.body)) {
      // Nothing was stored. The token is dead: drop the capture, then the link.
      await dropUnsent(item);
      // A late 403 for a token a takeover already replaced leaves the new
      // link alone, and says nothing: the device is still linked.
      const wasCurrent = deviceLink?.current()?.token === token;
      await deviceLink?.forget(token);
      if (live && wasCurrent) overlay?.toast(DEVICE_UNLINKED);
      return 'drop';
    }
    await settle(item, result.outcome);
    if (result.outcome === 'sent' && live?.nonce && token && deviceLink) {
      const pending = parseLinkPending(result.body);
      // A reply to an upload made under an older link never starts a takeover.
      if (pending && deviceLink.generation() === live.generation)
        deviceLink.beginAttempt(pending.attemptId, pending.number, live.nonce);
    }
    if (result.outcome === 'drop' && live) overlay?.toast(CAPTURE_FAILED);
    return result.outcome;
  }

  /** One attempt for one item; the item stays stored until the server answers for good. */
  async function attempt(
    item: OutboxItem,
    live?: LiveUpload,
  ): Promise<'sent' | 'drop' | 'retry' | 'busy' | 'wait'> {
    if (inFlight.has(item.reportId)) return 'busy';
    if (!config || !outbox || !binding || !env.fetch) return 'retry';
    // Never send a report anywhere but where it was captured for, nor under
    // another key. The outbox already drops such reports; this guards the
    // send itself.
    if (!sameBinding(item, binding)) {
      debug(
        '[everframe] dropped a stored report captured for another SDK key or endpoint; it is not sent',
      );
      await outbox.remove(item.reportId);
      return 'drop';
    }
    inFlight.add(item.reportId);
    try {
      if (item.quickCapture === true) return await attemptQuickCapture(item, live);
      const result = await sendReport(
        { fetch: env.fetch, setTimeout: env.setTimeout, clearTimeout: env.clearTimeout },
        config.ingestUrl,
        config.sdkKey,
        item.body,
      );
      await settle(item, result.outcome);
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
        const outcome = await attempt(item);
        // A linked quick capture waiting for the stored link to load.
        if (outcome === 'wait') retry = true;
        if (outcome === 'retry') {
          retry = true;
          // The server or network is down; later items would fail the same way.
          break;
        }
      }
      if (retry) scheduleRetry();
    })();
    draining = run
      .catch(() => undefined)
      .then(() => {
        draining = undefined;
      });
    return draining;
  }

  /** Persist first, then one live attempt. Resolves when both are done. */
  async function deliver(item: OutboxItem, live?: LiveUpload): Promise<void> {
    if (!outbox) return;
    await outbox.add(item);
    const outcome = await attempt(item, live);
    if (outcome === 'retry' || outcome === 'wait') {
      if (!item.fatal) scheduleRetry();
    } else if (outbox.size() > 0 && !item.fatal) {
      void drain();
    }
  }

  function track(work: Promise<void>): Promise<void> {
    const delivery: Promise<void> = work
      .catch(() => undefined)
      .then(() => {
        deliveries.delete(delivery);
      });
    deliveries.add(delivery);
    return delivery;
  }

  function capture(
    value: unknown,
    mechanism: Mechanism,
    fatal: boolean,
    options?: VegaCaptureOptions,
  ): Promise<void> | undefined {
    if (phase !== 'running' || capturing) return undefined;
    // Withdraw even when a fatal arrives before the start write settles.
    const nativeExposure = fatal && mechanism === 'errorutils' ? health?.fatal() : undefined;
    capturing = true;
    let item: OutboxItem | undefined;
    try {
      item = buildItem(value, mechanism, fatal, options, nativeExposure);
    } catch {
      item = undefined;
    } finally {
      capturing = false;
    }
    if (!item) return undefined;
    return track(deliver(item));
  }

  function gestureInput(): GestureInput {
    const loaded = deviceLink?.isLoaded() === true;
    return {
      quickCaptureEnabled:
        phase === 'running' &&
        config?.quickCaptureEnabled === true &&
        remote?.quickCapture === true &&
        overlay?.mounted() === true &&
        loaded,
      linkingEnabled: deviceLink?.linkingEnabled() === true,
      linked: loaded && deviceLink?.current() != null,
      debugBuild: config?.app.debug === true,
    };
  }

  /** Builds, stores and sends one quick capture; the toast shows at once. */
  function captureQuick(): void {
    if (!config || !device || !binding || !deviceLink) return;
    const current = deviceLink.current();
    const generation = deviceLink.generation();
    const reportId = uuidV4(env.random);
    const envelope = buildQuickCaptureEnvelope({
      reportId,
      occurredAt: new Date(env.now()).toISOString(),
      sdk: { ...SDK },
      app: config.app,
      device,
      breadcrumbs: breadcrumbs.snapshot(),
      user,
    });
    const item: OutboxItem = {
      reportId,
      body: JSON.stringify(envelope),
      enqueuedAt: env.now(),
      attempts: 0,
      fatal: false,
      ...binding,
      quickCapture: true,
      ...(current ? { linkFingerprint: tokenFingerprint(current.token) } : {}),
    };
    overlay?.toast(capturedToast(current?.owner ?? null, deviceLabel(config.device.model)));
    const nonce = current
      ? createNonce((n) => randomBytes(n, { crypto: env.crypto, random: env.random, now: env.now }))
      : undefined;
    void track(deliver(item, { ...(nonce ? { nonce } : {}), generation }));
  }

  function onGesture(): void {
    if (gestureBusy || !deviceLink || !deviceLink.isLoaded()) return;
    const now = env.now();
    if (now - lastGestureAt < CAPTURE_COOLDOWN_MS) return;
    const choice = decide(gestureInput());
    if (!choice.capture && !choice.sendHello) return;
    lastGestureAt = now;
    gestureBusy = true;
    try {
      if (choice.capture) captureQuick();
      if (choice.sendHello) deviceLink.sendHello();
    } catch {
      // A gesture never throws into the host.
    } finally {
      gestureBusy = false;
    }
  }

  const gestureArmed = (): boolean => tvBinding !== null && isArmed(gestureInput());

  /**
   * The app's binding from a config reply. The detector is rebuilt only when
   * the binding changes by value, so a routine refresh never resets a press
   * in progress; a change drops the old detector and its pending hold.
   */
  function applyBinding(cfg: RemoteConfig): void {
    const resolved = resolveTvBinding(cfg.tvBinding);
    if (resolved.unsupported && !warnedUnsupported) {
      warnedUnsupported = true;
      debug(UNSUPPORTED_BINDING_WARNING);
    }
    if (bindingsEqual(resolved.binding, tvBinding)) return;
    tvBinding = resolved.binding;
    detector?.reset();
    detector = undefined;
  }

  /**
   * One remote key from the root wrapper. A disarmed device (every end user
   * of a release build that is not linked, an app with linking off, or a
   * binding this remote cannot press) does no work per key: no detector, no
   * timer. Keys are only observed, never consumed, so the app receives each
   * one exactly as before.
   */
  function onRemoteKey(event: HWEventLike): void {
    const rawType = event?.eventType;
    const keyId = typeof rawType === 'string' ? rawType : '';
    // Record on device: every key goes to the recording, none to the gesture.
    if (recording?.active()) {
      detector?.reset();
      const action = keyAction(event?.eventKeyAction);
      if (action === 'down') heldThroughRecording.add(keyId);
      else if (action === 'up') heldThroughRecording.delete(keyId);
      if (action) recording.onKey(keyForVegaEvent(rawType), action);
      return;
    }
    // A key still held from the recording is not a new press: its repeats
    // and its up never reach the gesture.
    if (heldThroughRecording.has(keyId)) {
      if (keyAction(event?.eventKeyAction) === 'up') heldThroughRecording.delete(keyId);
      return;
    }
    if (!gestureArmed() || !tvBinding) {
      detector?.reset();
      return;
    }
    const action = keyAction(event?.eventKeyAction);
    if (!action) return;
    const key = keyForVegaEvent(rawType);
    if (!detector) {
      const created = createGestureDetector(tvBinding, {
        now: env.now,
        setTimeout: env.setTimeout,
        clearTimeout: env.clearTimeout,
        // A hold that ends after its binding was replaced, or once a
        // recording started, does nothing.
        onFire: () => {
          if (detector === created && !recording?.active()) onGesture();
        },
      });
      detector = created;
    }
    detector.onKey(key, action);
  }

  function refreshConfig(): void {
    const deps = sendDeps();
    if (!config || !deviceLink || !deps || phase !== 'running') return;
    const link = deviceLink;
    const seq = ++configSeq;
    lastConfigAt = env.now();
    const sent = link.tokenForRequest();
    void fetchRemoteConfig(deps, config.apiBase, config.sdkKey, sent)
      .then((next) => {
        // A failure keeps what the last good reply said; an older reply never
        // overrides a newer one.
        if (!next || seq < configApplied) return;
        configApplied = seq;
        remote = next;
        link.applyConfig(sent, next);
        applyBinding(next);
      })
      .catch(() => undefined);
  }

  function startQuickCapture(resolved: ResolvedConfig): void {
    const registry = env.appRegistry;
    const deps = sendDeps();
    if (!registry || !deps) return;
    const store = createOverlayStore(env);
    installRootWrapper(registry, { store, onKey: (event) => onRemoteKey(event) });
    overlay = store;
    const linkClient = createLinkClient(deps, resolved.apiBase, resolved.sdkKey);
    deviceLink = createDeviceLink({
      store: createLinkStore(resolved.storage),
      client: linkClient,
      scope: linkScope(resolved.apiBase, resolved.sdkKey),
      presenter: store,
      device: helloDevice({
        model: resolved.device.model,
        osVersion: resolved.device.osVersion,
        appVersion: resolved.app.version,
      }),
      nonce: () =>
        createNonce((n) =>
          randomBytes(n, { crypto: env.crypto, random: env.random, now: env.now }),
        ),
      now: env.now,
      setTimeout: env.setTimeout,
      clearTimeout: env.clearTimeout,
      refreshConfig,
      onRecording: (request) => {
        recording?.onRequest(request);
        // A press in progress never completes into a capture during the window.
        if (recording?.active()) detector?.reset();
      },
      debug,
    });
    recording = createGestureRecording({
      client: linkClient,
      deviceLink,
      presenter: store,
      now: env.now,
      wallNow: env.now,
      setTimeout: env.setTimeout,
      clearTimeout: env.clearTimeout,
    });
    // The foreground throttle starts at init: the first config request is
    // already on its way once the link loads.
    lastConfigAt = env.now();
    void deviceLink.ready.then(() => {
      refreshConfig();
      // Linked captures stored by an earlier launch wait for the link.
      if (outbox && outbox.size() > 0) void drain();
    });
    try {
      env.appState?.addEventListener('change', (state) => {
        try {
          overlay?.setForeground(state === 'active');
          if (state !== 'active') {
            // A hold never spans the app leaving the screen.
            detector?.reset();
            heldThroughRecording.clear();
            return;
          }
          // Only a linked device re-reads: its link may have been revoked or
          // reassigned. End users' devices make one request per launch.
          if (!deviceLink?.current()) return;
          if (env.now() - lastConfigAt < FOREGROUND_REFRESH_MS) return;
          refreshConfig();
        } catch {
          // Never into the host.
        }
      });
    } catch {
      // No lifecycle events: the config is read once per launch.
    }
  }

  function describeRejection(rejection: unknown): string {
    try {
      return isErrorValue(rejection)
        ? `${String((rejection as Error).name)}: ${String((rejection as Error).message)}`.slice(
            0,
            200,
          )
        : renderLabel(rejection).slice(0, 200);
    } catch {
      return '[unrenderable]';
    }
  }

  function installErrorHandler(): boolean {
    const errorUtils = env.errorUtils;
    if (!errorUtils || typeof errorUtils.setGlobalHandler !== 'function') return false;
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
    return true;
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
          if (env.dev)
            env.warn(`[everframe] unhandled promise rejection: ${describeRejection(rejection)}`);
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
      const resolved = resolveConfig(input, env.dev);
      if (!resolved) {
        env.warn('[everframe] init() needs an sdkKey; Everframe is off');
        phase = 'disabled';
        return;
      }
      config = resolved;
      if (input.releaseHealth === false && resolved.storage) {
        try {
          void resolved.storage.setItem(HEALTH_OUTBOX_KEY, '[]').catch(() => undefined);
        } catch {}
      }
      try {
        bundleId = probeBundleId(env.probeStack());
      } catch {
        bundleId = undefined;
      }
      try {
        device = env.readDevice(resolved.device);
      } catch {
        device = {
          os: 'Vega OS',
          osVersion: '',
          screenSize: { width: 0, height: 0 },
          pixelRatio: 1,
          locale: 'und',
          timezone: 'UTC',
        };
      }
      if (!resolved.storage && env.dev) {
        env.warn(
          '[everframe] no storage passed to init(); a crash that cannot be sent before the app stops is lost',
        );
      }
      binding = outboxBinding(resolved);
      outbox = createOutbox({
        storage: resolved.storage,
        now: env.now,
        warn: env.warn,
        binding,
        debug,
      });
      phase = 'running';
      try {
        const observed = installErrorHandler();
        if (observed && resolved.releaseHealth && env.appState) {
          health = createReleaseHealth(
            env,
            resolved,
            { ...binding, endpoint: resolved.ingestUrl.replace(/\/ingest$/, '/release-health') },
            bundleId,
          );
        }
      } catch {
        // A host whose ErrorUtils throws still gets captureException and replay.
      }
      installRejectionTracker();
      if (resolved.quickCaptureEnabled) {
        try {
          startQuickCapture(resolved);
        } catch {
          // Quick capture failing to start leaves crash reporting untouched.
        }
      }
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
      return Promise.all(Array.from(deliveries)).then(async () => {
        await Promise.all([drain(true), health?.flush()]);
      });
    },
    getStatus() {
      return {
        enabled: phase === 'running',
        bundleId: bundleId ?? null,
        rejections,
        pending: outbox?.size() ?? 0,
      };
    },
    onGesture,
    onRemoteKey(event) {
      try {
        onRemoteKey(event);
      } catch {
        // Never into the host.
      }
    },
    gestureInput,
    armed: gestureArmed,
    refreshConfig,
    quickCaptureParts: () => ({
      ...(overlay ? { overlay } : {}),
      ...(deviceLink ? { deviceLink } : {}),
      remote,
    }),
  };
}
