// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createVegaClient,
  FATAL_HANDOFF_MS,
  FOREGROUND_REFRESH_MS,
  RETRY_DELAYS_MS,
} from '../src/client.js';
import { LINK_STORAGE_KEY } from '../src/link-store.js';
import { linkScope } from '../src/link-token.js';
import type { AppStateLike } from '../src/release-health.js';
import { SDK_VERSION } from '../src/version.js';
import {
  BUILD_DIR,
  BUNDLE_ID,
  createEnv,
  createStorage,
  expectValidEnvelope,
  stored,
  vegaError,
} from './fakes.js';

const SDK_KEY = 'evf_live_test_key';
/** Dedup keys ignore digits, so distinct call sites need distinct letters. */
const letter = (i: number) => String.fromCharCode(97 + i);

afterEach(() => {
  vi.useRealTimers();
});

function start(opts: Parameters<typeof createEnv>[0] = {}, config: Record<string, unknown> = {}) {
  const harness = createEnv(opts);
  const storage = createStorage();
  const client = createVegaClient(harness.env);
  client.init({ sdkKey: SDK_KEY, storage, appVersion: '1.4.0', appBuild: '120', ...config });
  return { ...harness, storage, client };
}

describe('init', () => {
  it('turns off without an SDK key and installs nothing', () => {
    const harness = createEnv();
    const client = createVegaClient(harness.env);
    client.init({ sdkKey: '  ' });
    expect(client.getStatus().enabled).toBe(false);
    expect(harness.errorUtils.handler).toBeUndefined();
    expect(harness.hermes.options).toBeUndefined();
    expect(harness.warnings).toEqual(['[everframe] init() needs an sdkKey; Everframe is off']);
  });

  it('does nothing at all when disabled', async () => {
    const { client, errorUtils, hermes, fetch } = start({}, { enabled: false });
    client.captureException(new Error('x'));
    await client.flush();
    expect(client.getStatus()).toEqual({
      enabled: false,
      bundleId: null,
      rejections: 'off',
      pending: 0,
    });
    expect(errorUtils.handler).toBeUndefined();
    expect(hermes.options).toBeUndefined();
    expect(fetch.requests).toHaveLength(0);
  });

  it('reports its bundle id and observers', () => {
    const { client } = start();
    expect(client.getStatus()).toEqual({
      enabled: true,
      bundleId: BUNDLE_ID,
      rejections: 'observed',
      pending: 0,
    });
  });

  it('ignores a second init', () => {
    const { client, env } = start();
    const other = createEnv();
    client.init({ sdkKey: 'evf_live_other' });
    expect(client.getStatus().enabled).toBe(true);
    expect(other.errorUtils.handler).toBeUndefined();
    expect(env.errorUtils).toBeDefined();
  });

  it('warns in development when no storage is passed', () => {
    const harness = createEnv({ dev: true });
    createVegaClient(harness.env).init({ sdkKey: SDK_KEY });
    expect(harness.warnings.join('\n')).toContain('no storage passed to init()');
  });
});

describe('fatal JavaScript errors', () => {
  it('stores the report before the default handler ends the process, then hands off', async () => {
    const order: string[] = [];
    const { client, errorUtils, storage, fetch } = start({ order });
    const error = vegaError('player state was null');
    errorUtils.handler!(error, true);
    expect(errorUtils.previous).toHaveLength(0);

    await client.flush();
    await vi.waitFor(() => expect(errorUtils.previous).toHaveLength(1));
    expect(errorUtils.previous[0]).toMatchObject({ error, isFatal: true });
    // Persisted, then sent, then handed to React Native's handler.
    expect(storage.writes.length).toBeGreaterThan(0);
    expect(order).toEqual(['fetch', 'default-handler']);

    const { envelope, headers, url } = fetch.requests[0]!;
    expect(url).toBe('https://everframe.dev/api/ingest');
    expect(headers['Content-Type']).toBe('application/json');
    expectValidEnvelope(envelope);
    expect(envelope).toMatchObject({
      source: 'crash',
      sdk: { name: 'everframe-vega', version: SDK_VERSION, platform: 'vega', formFactor: 'tv' },
      context: {
        app: { name: 'Vega app', version: '1.4.0', build: '120' },
        device: { os: 'Vega OS' },
      },
      attachments: [],
      payload: {
        crash: {
          exceptionType: 'Error',
          message: 'player state was null',
          mechanism: 'errorutils',
          handled: false,
          fatal: true,
          jsBundle: {
            engine: 'hermes',
            platform: 'vega',
            buildId: BUNDLE_ID,
            bundleName: `${BUNDLE_ID}.bundle`,
          },
        },
      },
    });
    const frames = envelope.payload.crash.frames.map((f: { raw: string }) => f.raw);
    expect(frames[0]).toBe(`at onPress (${BUNDLE_ID}.bundle:41237:24)`);
    expect(JSON.stringify(envelope)).not.toContain(BUILD_DIR);
    // Delivered: nothing left to replay.
    expect(stored(storage)).toEqual([]);
  });

  it("marks the report as a debug build from React Native's __DEV__, unless the config says otherwise", async () => {
    const sentDebug = async (dev: boolean, config: Record<string, unknown> = {}) => {
      const { client, errorUtils, fetch } = start({ dev }, config);
      errorUtils.handler!(vegaError('boom'), true);
      await client.flush();
      await vi.waitFor(() => expect(fetch.requests).toHaveLength(1));
      const { envelope } = fetch.requests[0]!;
      expectValidEnvelope(envelope);
      return envelope.context.app.debug;
    };
    expect(await sentDebug(true)).toBe(true);
    expect(await sentDebug(false)).toBe(false);
    expect(await sentDebug(true, { debugBuild: false })).toBe(false);
    expect(await sentDebug(false, { debugBuild: true })).toBe(true);
  });

  it('hands off after the cap when storage hangs, and the report is lost only if nothing was written', async () => {
    vi.useFakeTimers();
    const { errorUtils, storage } = start();
    storage.hangWrites = true;
    errorUtils.handler!(vegaError('boom'), true);
    await vi.advanceTimersByTimeAsync(FATAL_HANDOFF_MS - 1);
    expect(errorUtils.previous).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(errorUtils.previous).toHaveLength(1);
  });

  it('keeps a fatal whose send failed and delivers it on the next launch, byte for byte', async () => {
    const first = start({ statuses: [503] });
    first.errorUtils.handler!(vegaError('boom'), true);
    await vi.waitFor(() => expect(first.errorUtils.previous).toHaveLength(1));
    const [kept] = stored(first.storage);
    expect(kept).toMatchObject({ fatal: true, attempts: 1 });

    // Next launch: same storage, a server that answers.
    const harness = createEnv({ statuses: [200] });
    const next = createVegaClient(harness.env);
    next.init({ sdkKey: SDK_KEY, storage: first.storage });
    await next.flush();
    expect(harness.fetch.requests).toHaveLength(1);
    expect(harness.fetch.requests[0]!.body).toBe(kept!.body);
    expect(harness.fetch.requests[0]!.envelope.reportId).toBe(kept!.reportId);
    expect(stored(first.storage)).toEqual([]);
  });

  it('always admits fatals, even after the automatic allowance is spent', async () => {
    const { client, errorUtils, fetch } = start();
    for (let i = 0; i < 12; i++)
      errorUtils.handler!(vegaError(`e${i}`, { fn: `fn${letter(i)}` }), false);
    errorUtils.handler!(vegaError('e0', { fn: 'fna' }), true);
    await client.flush();
    const sent = fetch.requests.map((r) => r.envelope.payload.crash);
    expect(sent.filter((c) => !c.fatal)).toHaveLength(10);
    expect(sent.filter((c) => c.fatal)).toHaveLength(1);
  });
});

describe('non-fatal errors', () => {
  it('chains to the previous handler immediately and reports source error', async () => {
    const { client, errorUtils, fetch } = start();
    errorUtils.handler!(vegaError('soft'), false);
    expect(errorUtils.previous).toHaveLength(1);
    await client.flush();
    expect(fetch.requests[0]!.envelope).toMatchObject({
      source: 'error',
      payload: { crash: { fatal: false, mechanism: 'errorutils' } },
    });
  });

  it('deduplicates one call site per launch, across bundle line changes', async () => {
    const { client, errorUtils, fetch } = start();
    errorUtils.handler!(vegaError('soft', { line: 10 }), false);
    errorUtils.handler!(vegaError('soft again', { line: 99 }), false);
    await client.flush();
    expect(fetch.requests).toHaveLength(1);
  });

  it('reports a thrown non-Error value without failing', async () => {
    const { client, errorUtils, fetch } = start();
    errorUtils.handler!('plain string thrown', false);
    await client.flush();
    expect(fetch.requests[0]!.envelope.payload.crash).toMatchObject({
      exceptionType: 'UnhandledValue',
      message: 'plain string thrown',
      frames: [],
    });
    expectValidEnvelope(fetch.requests[0]!.envelope);
  });
});

describe('unhandled promise rejections', () => {
  it('enables the Hermes tracker for every rejection and reports Error reasons', async () => {
    const { client, hermes, fetch } = start();
    expect(hermes.options?.allRejections).toBe(true);
    hermes.options!.onUnhandled(1, vegaError('fetch failed', { name: 'TypeError' }));
    await client.flush();
    const { envelope } = fetch.requests[0]!;
    expectValidEnvelope(envelope);
    expect(envelope).toMatchObject({
      source: 'error',
      payload: {
        crash: {
          exceptionType: 'TypeError',
          mechanism: 'unhandledrejection',
          handled: false,
          fatal: false,
        },
      },
    });
  });

  it('reports only the type of a rejected non-Error value', async () => {
    const { client, hermes, fetch } = start();
    hermes.options!.onUnhandled(2, {
      status: 401,
      headers: { authorization: 'Bearer secret-token' },
    });
    await client.flush();
    const crash = fetch.requests[0]!.envelope.payload.crash;
    expect(crash).toMatchObject({ exceptionType: 'UnhandledValue', message: '[object]' });
    expect(fetch.requests[0]!.body).not.toContain('secret-token');
  });

  it('can be turned off, and says when the runtime has no tracker', () => {
    expect(start({}, { captureUnhandledRejections: false }).client.getStatus().rejections).toBe(
      'disabled',
    );
    const harness = createEnv({ hermes: undefined });
    const client = createVegaClient(harness.env);
    client.init({ sdkKey: SDK_KEY });
    expect(client.getStatus().rejections).toBe('unavailable');
  });

  it('keeps a development warning, since the tracker replaces React Native’s', () => {
    const { hermes, warnings } = start({ dev: true });
    hermes.options!.onUnhandled(3, new Error('late'));
    expect(warnings).toContain('[everframe] unhandled promise rejection: Error: late');
  });
});

describe('captureException', () => {
  it('reports a handled error with details', async () => {
    const { client, fetch } = start();
    client.captureException(vegaError('decode failed'), {
      severity: 'warning',
      context: 'PlayerScreen',
      metadata: { assetId: 'A-42', retries: 2, nested: { no: true } as never },
    });
    await client.flush();
    const { envelope } = fetch.requests[0]!;
    expectValidEnvelope(envelope);
    expect(envelope.payload.crash).toMatchObject({
      mechanism: 'captureException',
      handled: true,
      fatal: false,
      details: {
        severity: 'warning',
        context: 'PlayerScreen',
        metadata: { assetId: 'A-42', retries: 2 },
        truncated: true,
      },
    });
  });

  it('defaults severity to error and reports one error object once', async () => {
    const { client, fetch } = start();
    const error = vegaError('once');
    client.captureException(error);
    client.captureException(error);
    await client.flush();
    expect(fetch.requests).toHaveLength(1);
    expect(fetch.requests[0]!.envelope.payload.crash.details).toEqual({ severity: 'error' });
  });

  it('allows ten distinct handled keys per launch', async () => {
    const { client, fetch } = start();
    for (let i = 0; i < 12; i++)
      client.captureException(vegaError(`h${i}`, { fn: `handled${letter(i)}` }));
    await client.flush();
    expect(fetch.requests).toHaveLength(10);
  });
});

describe('delivery', () => {
  it('retries a transient failure while the app runs', async () => {
    vi.useFakeTimers();
    const { client, fetch, storage } = start({ statuses: [500, 200] });
    client.captureException(vegaError('later'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch.requests).toHaveLength(1);
    expect(stored(storage)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
    expect(fetch.requests).toHaveLength(2);
    expect(fetch.requests[1]!.body).toBe(fetch.requests[0]!.body);
    expect(stored(storage)).toEqual([]);
    expect(client.getStatus().pending).toBe(0);
  });

  it('drops a report the server rejects for good', async () => {
    const { client, fetch, storage } = start({ statuses: [400] });
    client.captureException(vegaError('bad'));
    await client.flush();
    expect(fetch.requests).toHaveLength(1);
    expect(stored(storage)).toEqual([]);
  });

  it('sends to a custom endpoint', async () => {
    const { client, fetch } = start({}, { endpoint: 'http://127.0.0.1:8787/' });
    client.captureException(vegaError('local'));
    await client.flush();
    expect(fetch.requests[0]!.url).toBe('http://127.0.0.1:8787/api/ingest');
  });
});

describe('report contents', () => {
  it('attaches the user and breadcrumbs, and redacts the message but not the bundle id', async () => {
    const { client, fetch } = start();
    client.setUser({ id: 'u-1', email: 'viewer@example.com', extra: 'dropped' } as never);
    client.addBreadcrumb({ kind: 'navigation', message: 'opened player' });
    client.addBreadcrumb({ message: 'custom by default', level: 'loud' as never });
    client.captureException(vegaError('call 4111 1111 1111 1111 failed'));
    await client.flush();
    const { envelope } = fetch.requests[0]!;
    expectValidEnvelope(envelope);
    expect(envelope.reporter.user).toEqual({ id: 'u-1', email: 'viewer@example.com' });
    expect(
      envelope.payload.breadcrumbs.map((c: { kind: string; message: string }) => [
        c.kind,
        c.message,
      ]),
    ).toEqual([
      ['navigation', 'opened player'],
      ['custom', 'custom by default'],
    ]);
    expect(envelope.payload.crash.message).not.toContain('4111 1111 1111 1111');
    expect(envelope.payload.crash.frames[0].raw).toContain(`${BUNDLE_ID}.bundle`);
  });

  it('omits the bundle identity in a Debug build served by Metro', async () => {
    const harness = createEnv({
      probeStack: () =>
        'Error\n    at probe (http://localhost:8081/index.bundle?platform=kepler:1:2)',
    });
    const client = createVegaClient(harness.env);
    client.init({ sdkKey: SDK_KEY });
    client.captureException(new Error('dev'));
    await client.flush();
    expect(harness.fetch.requests[0]!.envelope.payload.crash.jsBundle).toBeUndefined();
    expectValidEnvelope(harness.fetch.requests[0]!.envelope);
  });

  it('survives a host whose globals throw', async () => {
    const harness = createEnv({
      errorUtils: {
        getGlobalHandler: () => {
          throw new Error('no');
        },
        setGlobalHandler: () => {
          throw new Error('no');
        },
      },
      readDevice: () => {
        throw new Error('no dims');
      },
    });
    const client = createVegaClient(harness.env);
    expect(() => client.init({ sdkKey: SDK_KEY })).not.toThrow();
    client.captureException(new Error('still works'));
    await client.flush();
    expectValidEnvelope(harness.fetch.requests[0]!.envelope);
  });
});

describe('anonymous callbacks', () => {
  // Hermes gives an error thrown in a timer or promise callback one frame,
  // `at anonymous (<id>.bundle:L:C)`. Two different ones must stay two reports
  // in two groups (found on the Vega Virtual Device).
  it('reports and groups two different errors from arrow functions separately', async () => {
    const { client, errorUtils, fetch } = start();
    const thrown = (message: string, line: number) => {
      const error = new Error(message);
      error.stack = `Error: ${message}\n    at anonymous (${BUILD_DIR}/${BUNDLE_ID}.bundle:${line}:28)`;
      return error;
    };
    errorUtils.handler!(thrown('first callback failed', 11213), false);
    errorUtils.handler!(thrown('second callback failed', 11228), false);
    await client.flush();
    expect(fetch.requests).toHaveLength(2);
    const [a, b] = fetch.requests.map((r) => r.envelope.payload.crash.fingerprint);
    expect(a).not.toBe(b);
  });
});

describe('stored reports stay with their SDK key and endpoint', () => {
  async function fatalLeftInStorage(config: Record<string, unknown> = {}) {
    const first = start({ statuses: [503] }, config);
    first.errorUtils.handler!(vegaError('boom'), true);
    await vi.waitFor(() => expect(first.errorUtils.previous).toHaveLength(1));
    expect(stored(first.storage)).toHaveLength(1);
    return first.storage;
  }

  function relaunch(storage: ReturnType<typeof createStorage>, config: Record<string, unknown>) {
    const harness = createEnv({ statuses: [200], dev: true });
    const client = createVegaClient(harness.env);
    client.init({ sdkKey: SDK_KEY, storage, ...config });
    return { ...harness, client };
  }

  it('never sends a report captured under another SDK key', async () => {
    const storage = await fatalLeftInStorage();
    const next = relaunch(storage, { sdkKey: 'evf_live_another_app' });
    await next.client.flush();
    expect(next.fetch.requests).toHaveLength(0);
    expect(stored(storage)).toEqual([]);
    expect(next.warnings.join('\n')).toContain('captured for another SDK key or endpoint');
  });

  it('never sends a report captured for another endpoint', async () => {
    const storage = await fatalLeftInStorage({ endpoint: 'http://127.0.0.1:8790' });
    const next = relaunch(storage, {});
    await next.client.flush();
    expect(next.fetch.requests).toHaveLength(0);
    expect(stored(storage)).toEqual([]);
  });

  it('replays to the same endpoint under the same key', async () => {
    const storage = await fatalLeftInStorage({ endpoint: 'http://127.0.0.1:8790' });
    const next = relaunch(storage, { endpoint: 'http://127.0.0.1:8790' });
    await next.client.flush();
    expect(next.fetch.requests.map((r) => [r.url, r.headers.Authorization])).toEqual([
      ['http://127.0.0.1:8790/api/ingest', `Bearer ${SDK_KEY}`],
    ]);
  });

  it('stores a fingerprint of the key, not the key', async () => {
    const storage = await fatalLeftInStorage();
    const [entry] = stored(storage);
    expect(entry!.keyHash).toMatch(/^[0-9a-f]{32}$/);
    expect(entry!.endpoint).toBe('https://everframe.dev/api/ingest');
    expect(storage.data.get('@everframe/vega/outbox/v1')).not.toContain(SDK_KEY);
  });
});

describe('credential-named metadata', () => {
  it('never reaches storage or the network', async () => {
    const { client, fetch, storage } = start({ statuses: [503] });
    client.captureException(vegaError('login failed'), {
      metadata: { password: 'hunter2', API_KEY: 'k-123', Authorization: 'Bearer abc', user: 'u-1' },
    });
    await client.flush();
    const written = storage.data.get('@everframe/vega/outbox/v1') ?? '';
    for (const secret of ['hunter2', 'k-123', 'Bearer abc']) {
      expect(written).not.toContain(secret);
      expect(fetch.requests[0]!.body).not.toContain(secret);
    }
    expect(fetch.requests[0]!.envelope.payload.crash.details.metadata).toEqual({
      password: '[REDACTED]',
      API_KEY: '[REDACTED]',
      Authorization: '[REDACTED]',
      user: 'u-1',
    });
    expectValidEnvelope(fetch.requests[0]!.envelope);
  });
});

describe('quick capture wiring', () => {
  const TOKEN = 'evf_dev_' + 'a1B2'.repeat(8);
  const ENDPOINT = 'https://everframe.dev';
  const CONFIG = { captureHotkey: { enabled: true }, deviceLinking: { enabled: true } };

  function wired(
    opts: {
      config?: Record<string, unknown>;
      link?: { endpoint?: string; key?: string };
      configReply?: { status: number; body?: unknown };
      appState?: AppStateLike;
      statuses?: number[];
    } = {},
  ) {
    const providers: unknown[] = [];
    const appRegistry = {
      setWrapperComponentProvider(provider: unknown) {
        providers.push(provider);
      },
    };
    const harness = createEnv({
      appRegistry,
      ...(opts.appState ? { appState: opts.appState } : {}),
      ...(opts.statuses ? { statuses: opts.statuses } : {}),
    });
    harness.fetch.route('GET', '/api/config', opts.configReply ?? { status: 200, body: CONFIG });
    const storage = createStorage();
    if (opts.link) {
      const scope = linkScope(opts.link.endpoint ?? ENDPOINT, opts.link.key ?? SDK_KEY);
      storage.data.set(
        LINK_STORAGE_KEY,
        JSON.stringify({ v: 1, s: scope, t: TOKEN, o: { kind: 'user', name: 'Aurimas' } }),
      );
    }
    const client = createVegaClient(harness.env);
    client.init({ sdkKey: SDK_KEY, storage, appVersion: '1.4.0', ...(opts.config ?? {}) });
    client.quickCaptureParts().overlay?.setMounted(true);
    const configs = () => harness.fetch.all.filter((r) => r.url.endsWith('/api/config'));
    return { ...harness, client, storage, providers, configs };
  }

  it('releaseEndUserMakesOneConfigRequestAndNothingElse', async () => {
    vi.useFakeTimers();
    const w = wired({ config: { debugBuild: false } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.providers).toHaveLength(1);
    expect(w.fetch.all.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET https://everframe.dev/api/config',
    ]);
    expect(w.configs()[0]!.headers).not.toHaveProperty('X-Everframe-Capture-Token');
    expect(w.warnings).toEqual([]);
    expect(w.client.armed()).toBe(true);
  });

  it('firstConfigCarriesStoredToken', async () => {
    vi.useFakeTimers();
    const w = wired({ link: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(w.configs()).toHaveLength(1);
    expect(w.configs()[0]!.headers['X-Everframe-Capture-Token']).toBe(TOKEN);
    expect(w.configs()[0]!.headers['X-Everframe-SDK-Features']).toBe(
      'capturehotkey, devicelinking',
    );
  });

  it('configCarriesNoTokenForAnotherScope', async () => {
    vi.useFakeTimers();
    for (const link of [{ endpoint: 'https://staging.everframe.dev' }, { key: 'evf_live_other' }]) {
      const w = wired({ link });
      await vi.advanceTimersByTimeAsync(0);
      expect(w.configs()).toHaveLength(1);
      expect(w.configs()[0]!.headers).not.toHaveProperty('X-Everframe-Capture-Token');
      expect(w.client.quickCaptureParts().deviceLink!.current()).toBeNull();
      // The other scope's record stays for when the app goes back to it.
      expect(w.storage.data.get(LINK_STORAGE_KEY)).toContain(TOKEN);
    }
  });

  it('quickCaptureOffInstallsNothing', async () => {
    vi.useFakeTimers();
    for (const config of [{ quickCaptureEnabled: false }, { enabled: false }]) {
      let listeners = 0;
      const appState: AppStateLike = {
        currentState: 'active',
        addEventListener: () => {
          listeners++;
          return { remove() {} };
        },
      };
      const w = wired({ config: { ...config, releaseHealth: false }, appState });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(w.providers).toHaveLength(0);
      expect(w.configs()).toHaveLength(0);
      expect(listeners).toBe(0);
      expect(w.client.quickCaptureParts()).toEqual({ remote: null });
    }
  });

  it('configFailureLeavesGestureInert', async () => {
    vi.useFakeTimers();
    for (const reply of [{ status: 500 }, { status: 0 }, { status: 200, body: 'nope' }]) {
      const w = wired({ link: {}, configReply: reply, config: { debugBuild: true } });
      await vi.advanceTimersByTimeAsync(0);
      expect(w.client.armed()).toBe(false);
      w.client.onGesture();
      await vi.advanceTimersByTimeAsync(0);
      expect(w.fetch.all.filter((r) => !r.url.endsWith('/api/config'))).toEqual([]);
    }
  });

  it('foregroundRefreshOnlyWhileLinkedAndThrottled', async () => {
    vi.useFakeTimers();
    const makeAppState = () => {
      const listeners: Array<(v: unknown) => void> = [];
      const appState: AppStateLike = {
        currentState: 'active',
        addEventListener: (_e, l) => {
          listeners.push(l);
          return { remove() {} };
        },
      };
      return { appState, emit: (v: string) => listeners.forEach((l) => l(v)) };
    };
    const unlinked = makeAppState();
    const u = wired({ appState: unlinked.appState, config: { releaseHealth: false } });
    await vi.advanceTimersByTimeAsync(FOREGROUND_REFRESH_MS * 2);
    unlinked.emit('background');
    unlinked.emit('active');
    await vi.advanceTimersByTimeAsync(0);
    expect(u.configs()).toHaveLength(1);

    const linked = makeAppState();
    const l = wired({ link: {}, appState: linked.appState, config: { releaseHealth: false } });
    await vi.advanceTimersByTimeAsync(0);
    expect(l.configs()).toHaveLength(1);
    linked.emit('active');
    await vi.advanceTimersByTimeAsync(0);
    expect(l.configs()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(FOREGROUND_REFRESH_MS);
    linked.emit('background');
    linked.emit('active');
    await vi.advanceTimersByTimeAsync(0);
    expect(l.configs()).toHaveLength(2);
    expect(l.configs()[1]!.headers['X-Everframe-Capture-Token']).toBe(TOKEN);
    linked.emit('active');
    await vi.advanceTimersByTimeAsync(0);
    expect(l.configs()).toHaveLength(2);
  });

  it('crashReportingUnchanged', async () => {
    const plain = start();
    const w = wired({ link: {} });
    for (const run of [plain, w]) {
      run.errorUtils.handler!(vegaError('player state was null'), true);
      await vi.waitFor(() => expect(run.errorUtils.previous).toHaveLength(1));
    }
    const a = plain.fetch.requests[0]!;
    const b = w.fetch.requests[0]!;
    expect(b.headers).toEqual(a.headers);
    expect(b.headers).not.toHaveProperty('X-Everframe-Capture-Token');
    expect(b.envelope.source).toBe('crash');
    expect(b.envelope.quickCapture).toBeUndefined();
    expect(Object.keys(b.envelope).sort()).toEqual(Object.keys(a.envelope).sort());
  });
});
