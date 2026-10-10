// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVegaClient, FATAL_HANDOFF_MS, RETRY_DELAYS_MS } from '../src/client.js';
import { SDK_VERSION } from '../src/version.js';
import { BUILD_DIR, BUNDLE_ID, createEnv, createStorage, expectValidEnvelope, stored, vegaError } from './fakes.js';

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
    expect(client.getStatus()).toEqual({ enabled: false, bundleId: null, rejections: 'off', pending: 0 });
    expect(errorUtils.handler).toBeUndefined();
    expect(hermes.options).toBeUndefined();
    expect(fetch.requests).toHaveLength(0);
  });

  it('reports its bundle id and observers', () => {
    const { client } = start();
    expect(client.getStatus()).toEqual({ enabled: true, bundleId: BUNDLE_ID, rejections: 'observed', pending: 0 });
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
      context: { app: { name: 'Vega app', version: '1.4.0', build: '120' }, device: { os: 'Vega OS' } },
      attachments: [],
      payload: {
        crash: {
          exceptionType: 'Error',
          message: 'player state was null',
          mechanism: 'errorutils',
          handled: false,
          fatal: true,
          jsBundle: { engine: 'hermes', platform: 'vega', buildId: BUNDLE_ID, bundleName: `${BUNDLE_ID}.bundle` },
        },
      },
    });
    const frames = envelope.payload.crash.frames.map((f: { raw: string }) => f.raw);
    expect(frames[0]).toBe(`at onPress (${BUNDLE_ID}.bundle:41237:24)`);
    expect(JSON.stringify(envelope)).not.toContain(BUILD_DIR);
    // Delivered: nothing left to replay.
    expect(stored(storage)).toEqual([]);
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
    for (let i = 0; i < 12; i++) errorUtils.handler!(vegaError(`e${i}`, { fn: `fn${letter(i)}` }), false);
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
    expect(fetch.requests[0]!.envelope).toMatchObject({ source: 'error', payload: { crash: { fatal: false, mechanism: 'errorutils' } } });
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
    expect(fetch.requests[0]!.envelope.payload.crash).toMatchObject({ exceptionType: 'UnhandledValue', message: 'plain string thrown', frames: [] });
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
      payload: { crash: { exceptionType: 'TypeError', mechanism: 'unhandledrejection', handled: false, fatal: false } },
    });
  });

  it('reports only the type of a rejected non-Error value', async () => {
    const { client, hermes, fetch } = start();
    hermes.options!.onUnhandled(2, { status: 401, headers: { authorization: 'Bearer secret-token' } });
    await client.flush();
    const crash = fetch.requests[0]!.envelope.payload.crash;
    expect(crash).toMatchObject({ exceptionType: 'UnhandledValue', message: '[object]' });
    expect(fetch.requests[0]!.body).not.toContain('secret-token');
  });

  it('can be turned off, and says when the runtime has no tracker', () => {
    expect(start({}, { captureUnhandledRejections: false }).client.getStatus().rejections).toBe('disabled');
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
      severity: 'warning', context: 'PlayerScreen', metadata: { assetId: 'A-42', retries: 2, nested: { no: true } as never },
    });
    await client.flush();
    const { envelope } = fetch.requests[0]!;
    expectValidEnvelope(envelope);
    expect(envelope.payload.crash).toMatchObject({
      mechanism: 'captureException', handled: true, fatal: false,
      details: { severity: 'warning', context: 'PlayerScreen', metadata: { assetId: 'A-42', retries: 2 }, truncated: true },
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
    for (let i = 0; i < 12; i++) client.captureException(vegaError(`h${i}`, { fn: `handled${letter(i)}` }));
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
    expect(envelope.payload.breadcrumbs.map((c: { kind: string; message: string }) => [c.kind, c.message])).toEqual([
      ['navigation', 'opened player'],
      ['custom', 'custom by default'],
    ]);
    expect(envelope.payload.crash.message).not.toContain('4111 1111 1111 1111');
    expect(envelope.payload.crash.frames[0].raw).toContain(`${BUNDLE_ID}.bundle`);
  });

  it('omits the bundle identity in a Debug build served by Metro', async () => {
    const harness = createEnv({ probeStack: () => 'Error\n    at probe (http://localhost:8081/index.bundle?platform=kepler:1:2)' });
    const client = createVegaClient(harness.env);
    client.init({ sdkKey: SDK_KEY });
    client.captureException(new Error('dev'));
    await client.flush();
    expect(harness.fetch.requests[0]!.envelope.payload.crash.jsBundle).toBeUndefined();
    expectValidEnvelope(harness.fetch.requests[0]!.envelope);
  });

  it('survives a host whose globals throw', async () => {
    const harness = createEnv({
      errorUtils: { getGlobalHandler: () => { throw new Error('no'); }, setGlobalHandler: () => { throw new Error('no'); } },
      readDevice: () => { throw new Error('no dims'); },
    });
    const client = createVegaClient(harness.env);
    expect(() => client.init({ sdkKey: SDK_KEY })).not.toThrow();
    client.captureException(new Error('still works'));
    await client.flush();
    expectValidEnvelope(harness.fetch.requests[0]!.envelope);
  });
});
