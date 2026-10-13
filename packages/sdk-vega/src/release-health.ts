// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import type {
  NativeExposurePointer,
  NativeReleaseHealthRecord,
  VegaReleaseHealthExposure,
} from '@everframe/protocol';
import type { VegaEnvironment } from './client.js';
import type { ResolvedConfig } from './config.js';
import { uuidV4 } from './ids.js';
import { createOutbox, type OutboxBinding } from './outbox.js';
import { sendReport } from './transport.js';
import { SDK_VERSION } from './version.js';

export interface AppStateLike {
  currentState: unknown;
  currentModuleStates?: unknown;
  addEventListener(
    event: 'change' | 'moduleChange',
    listener: (value: unknown) => void,
  ): { remove(): void };
}
export const HEALTH_OUTBOX_KEY = '@everframe/vega/release-health/v1';
export const HEALTH_MAX_ITEMS = 100;
const RETRY_MS = [2_000, 10_000, 60_000, 300_000];

/** Health has independent storage and delivery: it can never hold up crash persistence. */
export function createReleaseHealth(
  env: VegaEnvironment,
  config: ResolvedConfig,
  binding: OutboxBinding,
  bundleId: string | undefined,
) {
  const outbox = createOutbox({
    storage: config.storage,
    now: env.now,
    warn: env.warn,
    debug: () => undefined,
    binding,
    storageKey: HEALTH_OUTBOX_KEY,
    maxItems: HEALTH_MAX_ITEMS,
  });
  let draining: Promise<void> | undefined;
  let drainAgain = false;
  let timer: unknown;
  let failures = 0;
  let exposure: VegaReleaseHealthExposure | undefined;
  let pointer: NativeExposurePointer | undefined;
  let terminated = false;
  let observing = false;
  let moduleMode = false;
  const processLaunchId = uuidV4(env.random);
  const subscriptions: Array<{ remove(): void }> = [];

  function drain(force = false): Promise<void> {
    if (!observing) return Promise.resolve();
    if (timer !== undefined) {
      if (!force) return draining ?? Promise.resolve();
      env.clearTimeout(timer);
      timer = undefined;
    }
    drainAgain = true;
    if (draining) return draining;
    draining = (async () => {
      if (!env.fetch) return;
      do {
        drainAgain = false;
        for (const item of await outbox.due()) {
          const result = await sendReport(
            { fetch: env.fetch, setTimeout: env.setTimeout, clearTimeout: env.clearTimeout },
            binding.endpoint,
            config.sdkKey,
            item.body,
          );
          if (result.outcome === 'retry') {
            await outbox.recordAttempt(item.reportId);
            if (timer === undefined)
              timer = env.setTimeout(
                () => {
                  timer = undefined;
                  void drain();
                },
                RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)]!,
              );
            return;
          }
          failures = 0;
          await outbox.remove(item.reportId);
        }
      } while (drainAgain);
    })()
      .catch(() => undefined)
      .then(() => {
        draining = undefined;
      });
    return draining;
  }
  function enqueue(record: NativeReleaseHealthRecord): Promise<void> {
    return outbox.add({
      ...binding,
      reportId: record.recordId,
      body: JSON.stringify(record),
      enqueuedAt: env.now(),
      attempts: 0,
      fatal: false,
    });
  }
  function start(): void {
    if (exposure || terminated || !observing) return;
    const app = Object.freeze({
      version: config.app.version,
      build: config.app.build ?? null,
      debug: false,
    });
    // The health protocol has tighter text bounds than the report envelope. A bad
    // declared release is unknown, never silently truncated into another release.
    const valid = (value: string) =>
      value.length > 0 &&
      value.length <= 64 &&
      value.trim().length > 0 &&
      !/[\u0000-\u001f\ud800-\udfff]/u.test(value);
    if (!valid(app.version) || (app.build !== null && !valid(app.build))) return;
    const next: VegaReleaseHealthExposure = Object.freeze({
      exposureId: uuidV4(env.random),
      processLaunchId,
      startedAt: new Date(env.now()).toISOString(),
      platform: 'vega',
      sdkVersion: SDK_VERSION,
      app,
      loadedBuildId: bundleId ?? null,
      loadedBundleStatus: bundleId ? 'known' : 'unknown',
      subject: Object.freeze({ kind: 'anonymous' }),
      sessionPolicy: 'foreground-v1',
      coverage: Object.freeze({
        policy: 'vega-js-segment-v1',
        sampleRate: 1,
        priorQueueLosses: null,
        queueLossAccounting: 'unavailable',
      }),
    });
    exposure = next;
    void enqueue({
      schemaVersion: 5,
      recordId: uuidV4(env.random),
      exposure: next,
      capturedAt: next.startedAt,
      phase: 'start',
      sequence: 0,
      elapsedMs: 0,
    })
      .then(() => {
        // Never re-arm after a background or fatal while the storage load/write waited.
        if (exposure === next && !terminated)
          pointer = Object.freeze({
            exposureId: next.exposureId,
            processLaunchId,
            startedAt: next.startedAt,
            app,
            loadedBuildId: next.loadedBuildId,
            loadedBundleStatus: next.loadedBundleStatus,
          });
        void drain();
      })
      .catch(() => undefined);
  }
  function end(reason: 'background' | 'sdk_stop'): void {
    const previous = exposure;
    pointer = undefined;
    exposure = undefined;
    if (!previous) return;
    const now = Math.max(env.now(), Date.parse(previous.startedAt));
    void enqueue({
      schemaVersion: 5,
      recordId: uuidV4(env.random),
      exposure: previous,
      capturedAt: new Date(now).toISOString(),
      phase: 'end',
      sequence: 1,
      elapsedMs: Math.min(31 * 86_400_000, now - Date.parse(previous.startedAt)),
      outcome: 'completed',
      endReason: reason,
    })
      .then(() => drain())
      .catch(() => undefined);
  }
  function observe(value: unknown): void {
    if (value === 'active') start();
    else if (value === 'background') end('background');
  }
  function observeModules(value: unknown): void {
    if (!Array.isArray(value)) return;
    moduleMode = true;
    if (value.some((item) => item?.module_state === 'active')) observe('active');
    else if (value.length > 0 && value.every((item) => item?.module_state === 'background'))
      observe('background');
  }
  try {
    const state = env.appState!;
    subscriptions.push(state.addEventListener('moduleChange', observeModules));
    subscriptions.push(
      state.addEventListener('change', (value) => {
        observeModules(state.currentModuleStates);
        if (!moduleMode) observe(value);
      }),
    );
    observing = true;
    observeModules(state.currentModuleStates);
    if (!moduleMode) observe(state.currentState);
  } catch {
    // A partially installed observer must never produce a monitored denominator.
    terminated = true;
    observing = false;
    pointer = undefined;
    exposure = undefined;
    for (const subscription of subscriptions) {
      try {
        subscription.remove();
      } catch {}
    }
  }
  void drain();
  return {
    fatal(): NativeExposurePointer | undefined {
      const captured = pointer;
      pointer = undefined;
      exposure = undefined;
      terminated = true;
      return captured;
    },
    flush: () => drain(true),
  };
}
