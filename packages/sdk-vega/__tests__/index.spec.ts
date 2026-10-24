// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createErrorUtils, createFetch, createHermes, createStorage, vegaError } from './fakes.js';

type Host = typeof globalThis & Record<string, unknown>;
const host = globalThis as Host;
const saved = {
  ErrorUtils: host.ErrorUtils,
  HermesInternal: host.HermesInternal,
  fetch: host.fetch,
  __DEV__: host.__DEV__,
};

afterEach(() => {
  Object.assign(host, saved);
  vi.resetModules();
});

describe('public entry', () => {
  it('reads React Native globals when init() runs, not at import', async () => {
    const sdk = await import('../src/index.js');
    // Installed after the module loaded, as InitializeCore might.
    const errorUtils = createErrorUtils();
    const hermes = createHermes();
    const fetch = createFetch([200]);
    Object.assign(host, { ErrorUtils: errorUtils, HermesInternal: hermes, fetch, __DEV__: false });

    sdk.init({ sdkKey: 'evf_live_key', storage: createStorage(), appVersion: '2.0.0' });
    expect(errorUtils.handler).toBeTypeOf('function');
    expect(hermes.options?.allRejections).toBe(true);
    // The probe runs from Node here, so there is no Vega bundle id.
    expect(sdk.getStatus()).toMatchObject({
      enabled: true,
      bundleId: null,
      rejections: 'observed',
    });

    sdk.setUser({ id: 'u-9' });
    sdk.addBreadcrumb({ message: 'hello' });
    sdk.captureException(vegaError('from the entry'));
    await sdk.flush();
    expect(fetch.requests).toHaveLength(1);
    expect(fetch.requests[0]!.envelope).toMatchObject({
      sdk: { name: 'everframe-vega', platform: 'vega' },
      reporter: { user: { id: 'u-9' } },
      context: {
        app: { version: '2.0.0' },
        device: { os: 'Vega OS', screenSize: { width: 1920, height: 1080 } },
      },
    });
  });

  it('installs the root wrapper through AppRegistry from init()', async () => {
    const sdk = await import('../src/index.js');
    // The same (reset) module instance the SDK imported.
    const { AppRegistry } = await import('./stubs/react-native.js');
    const fetch = createFetch([200]);
    fetch.route('GET', '/api/config', { status: 200, body: {} });
    Object.assign(host, { ErrorUtils: createErrorUtils(), fetch, __DEV__: false });
    const before = AppRegistry.wrapperProviders.length;
    sdk.init({ sdkKey: 'evf_live_key', storage: createStorage(), appVersion: '2.0.0' });
    expect(AppRegistry.wrapperProviders).toHaveLength(before + 1);
    await vi.waitFor(() =>
      expect(fetch.all.filter((r) => r.url.endsWith('/api/config'))).toHaveLength(1),
    );
  });

  it('installs nothing with quickCaptureEnabled: false', async () => {
    const sdk = await import('../src/index.js');
    const { AppRegistry } = await import('./stubs/react-native.js');
    const fetch = createFetch([200]);
    Object.assign(host, { ErrorUtils: createErrorUtils(), fetch, __DEV__: false });
    const before = AppRegistry.wrapperProviders.length;
    sdk.init({ sdkKey: 'evf_live_key', storage: createStorage(), quickCaptureEnabled: false });
    await new Promise((r) => setTimeout(r, 10));
    expect(AppRegistry.wrapperProviders).toHaveLength(before);
    expect(fetch.all).toHaveLength(0);
  });

  it('exports only the documented API', async () => {
    const sdk = await import('../src/index.js');
    expect(Object.keys(sdk).sort()).toEqual([
      'SDK_VERSION',
      'addBreadcrumb',
      'captureException',
      'flush',
      'getStatus',
      'init',
      'setUser',
    ]);
  });
});

describe('qualified Vega AppState wiring', () => {
  it.each([72, 83])(
    'only enables foreground health on React Native for Vega 0.72 (runtime 0.%s)',
    async (minor) => {
      const { AppState, Platform } = await import('./stubs/react-native.js');
      const originalMinor = Platform.constants.reactNativeVersion.minor;
      AppState.currentState = 'active';
      Platform.constants.reactNativeVersion.minor = minor;
      try {
        const errorUtils = createErrorUtils();
        const fetch = createFetch();
        Object.assign(host, { ErrorUtils: errorUtils, fetch, __DEV__: false });
        const sdk = await import('../src/index.js');
        sdk.init({ sdkKey: 'evf_live_key', storage: createStorage(), appVersion: '2.0' });
        await sdk.flush();
        expect(
          fetch.requests.filter((request) => request.url.endsWith('/release-health')),
        ).toHaveLength(minor === 72 ? 1 : 0);
      } finally {
        AppState.currentState = null;
        Platform.constants.reactNativeVersion.minor = originalMinor;
      }
    },
  );
});
