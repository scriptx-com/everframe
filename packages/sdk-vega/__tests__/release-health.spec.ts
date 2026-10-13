// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeReleaseHealthRecordSchema } from '@everframe/protocol';
import { createVegaClient, FATAL_HANDOFF_MS, type VegaEnvironment } from '../src/client.js';
import { createEnv, createStorage, stored, vegaError } from './fakes.js';

const HEALTH_KEY = '@everframe/vega/release-health/v1';
function appState(initial: unknown = 'active') {
  const listeners = new Map<string, (value: any) => void>();
  return {
    currentState: initial,
    currentModuleStates: null as unknown,
    addEventListener(event: string, listener: (value: any) => void) {
      listeners.set(event, listener);
      return { remove: () => listeners.delete(event) };
    },
    change(value: unknown) {
      this.currentState = value;
      listeners.get('change')?.(value);
    },
    modules(states: unknown) {
      this.currentModuleStates = states;
      listeners.get('moduleChange')?.(states);
    },
  };
}
const modules = (...states: string[]) =>
  states.map((module_state, i) => ({ module_name: `module${i}`, module_state }));
async function settle() {
  for (let i = 0; i < 80; i++) await Promise.resolve();
}
function setup(overrides: Partial<VegaEnvironment> = {}, initial: unknown = 'active') {
  const state = appState(initial);
  const harness = createEnv({ appState: state, ...overrides });
  const storage = createStorage();
  const client = createVegaClient(harness.env);
  const init = (extra = {}) =>
    client.init({ sdkKey: 'evf_live_key', appVersion: '2.0', appBuild: '42', storage, ...extra });
  const health = () =>
    harness.fetch.requests
      .filter((r) => r.url.endsWith('/release-health'))
      .map((r) => JSON.parse(r.body));
  const reports = () =>
    harness.fetch.requests.filter((r) => r.url.endsWith('/ingest')).map((r) => JSON.parse(r.body));
  return { ...harness, state, storage, client, init, health, reports };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-13T12:00:00.000Z'));
});
afterEach(() => vi.useRealTimers());

describe('Vega foreground release health', () => {
  it('starts an anonymous frozen native session and closes it on observed background', async () => {
    const h = setup();
    h.init();
    h.client.setUser({ id: 'private-user', email: 'secret@example.com' });
    await settle();
    expect(h.health()).toHaveLength(1);
    const start = h.health()[0];
    expect(start).toMatchObject({
      schemaVersion: 5,
      phase: 'start',
      sequence: 0,
      elapsedMs: 0,
      exposure: {
        platform: 'vega',
        app: { version: '2.0', build: '42', debug: false },
        subject: { kind: 'anonymous' },
        sessionPolicy: 'foreground-v1',
        coverage: {
          policy: 'vega-js-segment-v1',
          sampleRate: 1,
          priorQueueLosses: null,
          queueLossAccounting: 'unavailable',
        },
      },
    });
    vi.setSystemTime(Date.now() + 3000);
    h.state.change('background');
    await settle();
    expect(h.health()[1]).toMatchObject({
      phase: 'end',
      sequence: 1,
      exposure: start.exposure,
      outcome: 'completed',
      endReason: 'background',
      elapsedMs: 3000,
    });
    for (const record of h.health())
      expect(NativeReleaseHealthRecordSchema.safeParse(record).success).toBe(true);
    expect(JSON.stringify(h.health())).not.toContain('private-user');
    h.state.change('active');
    await settle();
    expect(h.health()[2].exposure.exposureId).not.toBe(start.exposure.exposureId);
    expect(h.health()[2].exposure.processLaunchId).toBe(start.exposure.processLaunchId);
  });
  it('waits through unknown startup and aggregates all Vega components', async () => {
    const h = setup({}, null);
    h.init();
    await settle();
    expect(h.health()).toEqual([]);
    h.state.modules(modules('active', 'background'));
    await settle();
    expect(h.health()).toHaveLength(1);
    h.state.change('background');
    await settle();
    expect(h.health()).toHaveLength(1);
    h.state.modules(modules('background', 'active'));
    await settle();
    expect(h.health()).toHaveLength(1);
    h.state.modules(modules('background', 'unknown'));
    await settle();
    expect(h.health()).toHaveLength(1);
    h.state.modules(modules('background', 'background'));
    await settle();
    expect(h.health()).toHaveLength(2);
  });
  it.each([{ releaseHealth: false }, { debugBuild: true }, { enabled: false }])(
    'emits no health for %j',
    async (extra) => {
      const h = setup();
      h.init(extra);
      await settle();
      h.state.change('background');
      await settle();
      expect(h.health()).toEqual([]);
      expect(h.storage.data.get(HEALTH_KEY) ?? '[]').toBe('[]');
    },
  );
  it.each([{ dev: true }, { errorUtils: undefined }, { appState: undefined }])(
    'requires release runtime, AppState and a working error hook: %j',
    async (overrides) => {
      const h = setup(overrides);
      h.init();
      await settle();
      expect(h.health()).toEqual([]);
    },
  );
  it('attaches the frozen pointer only to fatal ErrorUtils reports, then withdraws it synchronously', async () => {
    const h = setup();
    h.init();
    await settle();
    const exposure = h.health()[0].exposure;
    h.client.captureException(vegaError('handled'));
    h.errorUtils.handler!(vegaError('nonfatal'), false);
    h.hermes.options!.onUnhandled(1, vegaError('promise'));
    await settle();
    expect(h.reports().every((r) => r.payload.crash.nativeExposure === undefined)).toBe(true);
    h.errorUtils.handler!(vegaError('fatal'), true);
    h.state.change('background');
    await settle();
    const crash = h.reports().find((r) => r.payload.crash.fatal).payload.crash;
    expect(crash.nativeExposure).toEqual({
      exposureId: exposure.exposureId,
      processLaunchId: exposure.processLaunchId,
      startedAt: exposure.startedAt,
      app: exposure.app,
      loadedBuildId: exposure.loadedBuildId,
      loadedBundleStatus: exposure.loadedBundleStatus,
    });
    expect(h.health()).toHaveLength(1); // A fatal session cannot also complete.
    h.errorUtils.handler!(vegaError('second fatal'), true);
    await settle();
    expect(h.reports().at(-1).payload.crash.nativeExposure).toBeUndefined();
  });
  it('withdraws attribution before background persistence can settle', async () => {
    const h = setup();
    h.init();
    await settle();
    h.storage.hangWrites = true;
    h.state.change('background');
    h.errorUtils.handler!(vegaError('background fatal'), true);
    await settle();
    h.storage.hangWrites = false;
    // A separate client avoids waiting on the intentionally hung queue.
    expect(h.errorUtils.previous).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(FATAL_HANDOFF_MS);
    expect(h.errorUtils.previous).toHaveLength(1);
  });
  it('persists a fatal independently of a hung health request and preserves fatal handoff cap', async () => {
    const h = setup();
    const original = h.env.fetch!;
    h.env.fetch = (url, init) =>
      url.endsWith('/release-health') ? new Promise(() => {}) : original(url, init);
    h.init();
    await settle();
    h.errorUtils.handler!(vegaError('fatal independent'), true);
    await settle();
    expect(h.reports()[0].payload.crash.nativeExposure).toBeDefined();
    expect(h.errorUtils.previous).toHaveLength(1);
  });
  it('replays byte-identical records after relaunch and drops records for another key or endpoint', async () => {
    const h = setup();
    h.fetch.statuses = [0];
    h.init();
    await settle();
    const body = h.fetch.requests[0]!.body;
    expect(JSON.parse(h.storage.data.get(HEALTH_KEY)!)).toHaveLength(1);
    const next = setup({}, null);
    createVegaClient(next.env).init({
      sdkKey: 'evf_live_key',
      appVersion: '2.0',
      storage: h.storage,
    });
    await settle();
    expect(next.fetch.requests[0]!.body).toBe(body);
    h.state.change('background');
    await settle();
    const foreign = setup({}, null);
    createVegaClient(foreign.env).init({
      sdkKey: 'evf_live_other',
      appVersion: '2.0',
      storage: h.storage,
    });
    await settle();
    expect(foreign.fetch.requests).toEqual([]);
    expect(JSON.parse(h.storage.data.get(HEALTH_KEY)!)).toEqual([]);
  });
  it('does not expose a pointer before start persistence and keeps crash storage separate', async () => {
    const h = setup();
    const storage = createStorage({ deferLoad: true });
    h.client.init({ sdkKey: 'evf_live_key', storage });
    h.errorUtils.handler!(vegaError('early fatal'), true);
    storage.releaseLoad();
    await settle();
    expect(h.reports()[0].payload.crash.nativeExposure).toBeUndefined();
    expect(stored(storage)).toEqual([]);
  });
  it('drains lifecycle records queued while an earlier network request is pending', async () => {
    const h = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = h.env.fetch!;
    let first = true;
    h.env.fetch = async (url, init) => {
      if (first) {
        first = false;
        await gate;
      }
      return fetch(url, init);
    };
    h.init();
    await settle();
    h.state.change('background');
    h.state.change('active');
    await settle();
    release();
    await settle();
    expect(h.health().map((record) => record.phase)).toEqual(['start', 'end', 'start']);
    expect(JSON.parse(h.storage.data.get(HEALTH_KEY)!)).toEqual([]);
  });
  it('uses a module snapshot already published when a change event arrives first', async () => {
    const h = setup();
    h.init();
    await settle();
    h.state.currentModuleStates = modules('active', 'background');
    h.state.change('background');
    await settle();
    expect(h.health()).toHaveLength(1);
    h.state.modules(modules('background', 'background'));
    await settle();
    expect(h.health()).toHaveLength(2);
  });
  it.each([
    { appVersion: undefined },
    { appVersion: 'x'.repeat(65) },
    { appVersion: 'bad\u0000version' },
    { appBuild: 'x'.repeat(65) },
  ])('does not invent or truncate a health release: %j', async (extra) => {
    const h = setup();
    h.init(extra);
    await settle();
    expect(h.health()).toEqual([]);
  });
  it('does not count sessions if the ErrorUtils hook or AppState subscription fails', async () => {
    const h = setup({
      errorUtils: {
        getGlobalHandler: () => undefined,
        setGlobalHandler: () => {
          throw new Error('unavailable');
        },
      },
    });
    h.init();
    await settle();
    expect(h.health()).toEqual([]);
    const next = setup();
    next.state.addEventListener = () => {
      throw new Error('unavailable');
    };
    next.init();
    await settle();
    expect(next.health()).toEqual([]);
  });
  it('never completes or re-arms after a fatal during pending start persistence', async () => {
    const h = setup();
    const storage = createStorage({ deferLoad: true });
    h.client.init({ sdkKey: 'evf_live_key', appVersion: '2.0', storage });
    h.errorUtils.handler!(vegaError('startup fatal'), true);
    h.state.change('background');
    storage.releaseLoad();
    await settle();
    h.state.change('active');
    await settle();
    expect(h.health().map((record) => record.phase)).toEqual(['start']);
    expect(h.reports()[0].payload.crash.nativeExposure).toBeUndefined();
  });
  it('withdraws the background pointer before the end record is stored', async () => {
    const h = setup();
    h.init();
    await settle();
    h.state.change('background');
    h.errorUtils.handler!(vegaError('background crash'), true);
    await settle();
    expect(h.reports()[0].payload.crash.nativeExposure).toBeUndefined();
  });

  it('erases queued health when opted out while retaining crash delivery', async () => {
    const h = setup();
    h.fetch.statuses = [0];
    h.init();
    await settle();
    expect(JSON.parse(h.storage.data.get(HEALTH_KEY)!)).toHaveLength(1);
    const next = setup();
    const client = createVegaClient(next.env);
    client.init({
      sdkKey: 'evf_live_key',
      appVersion: '2.0',
      storage: h.storage,
      releaseHealth: false,
    });
    client.captureException(vegaError('still reporting'));
    await settle();
    expect(JSON.parse(h.storage.data.get(HEALTH_KEY)!)).toEqual([]);
    expect(next.health()).toEqual([]);
    expect(next.reports()).toHaveLength(1);
  });

  it('stores a fatal with its pointer while both networks hang and hands off at 1500ms', async () => {
    const h = setup({ fetch: () => new Promise(() => {}) });
    h.init();
    await settle();
    h.errorUtils.handler!(vegaError('offline fatal'), true);
    await settle();
    const crash = JSON.parse(stored(h.storage)[0]!.body).payload.crash;
    expect(crash.nativeExposure).toBeDefined();
    expect(h.errorUtils.previous).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(FATAL_HANDOFF_MS - 1);
    expect(h.errorUtils.previous).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.errorUtils.previous).toHaveLength(1);
  });
  it('retries health with identical record bytes after backoff', async () => {
    const h = setup();
    h.fetch.statuses = [0, 200];
    h.init();
    await settle();
    const first = h.fetch.requests[0]!.body;
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.fetch.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(h.fetch.requests[1]!.body).toBe(first);
    expect(JSON.parse(h.storage.data.get(HEALTH_KEY)!)).toEqual([]);
  });

  it('does not spend retries on foreground/background events during backoff', async () => {
    const h = setup();
    h.fetch.statuses = [0];
    h.init();
    await settle();
    for (let i = 0; i < 10; i++) {
      h.state.change('background');
      h.state.change('active');
      await settle();
    }
    expect(h.fetch.requests).toHaveLength(1);
    const records = JSON.parse(h.storage.data.get(HEALTH_KEY)!);
    expect(records[0].attempts).toBe(1);
    expect(records).toHaveLength(21);
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(h.fetch.requests).toHaveLength(2);
  });

  it('honors the declared debugBuild override consistently for reports and health', async () => {
    const h = setup({ dev: true });
    h.init({ debugBuild: false });
    await settle();
    expect(h.health()).toHaveLength(1);
    expect(h.health()[0].exposure.app.debug).toBe(false);
  });
  it('retains prior health without sending when lifecycle observation cannot install', async () => {
    const h = setup();
    h.fetch.statuses = [0];
    h.init();
    await settle();
    const next = setup();
    next.state.addEventListener = () => {
      throw new Error('unavailable');
    };
    createVegaClient(next.env).init({
      sdkKey: 'evf_live_key',
      appVersion: '2.0',
      storage: h.storage,
    });
    await settle();
    expect(next.health()).toEqual([]);
    expect(JSON.parse(h.storage.data.get(HEALTH_KEY)!)).toHaveLength(1);
  });
});
