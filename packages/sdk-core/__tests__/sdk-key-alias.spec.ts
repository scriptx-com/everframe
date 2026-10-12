// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// `apiKey` was the SDK key's config name until 1.2. It is still accepted as a
// deprecated alias so a 1.1 config keeps working in a minor release.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __internalClientState, __resetSdkKeyWarning, createClient, resolveSdkKey } from '../src/index.js';
import type { EverframeConfig } from '../src/index.js';
import type { PlatformAdapter } from '../src/types/platform.js';

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __resetSdkKeyWarning();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

describe('resolveSdkKey', () => {
  it('moves the deprecated apiKey to sdkKey and warns once', () => {
    const resolved = resolveSdkKey({ apiKey: 'evf_live_alias', appName: 'host' });
    expect(resolved).toEqual({ sdkKey: 'evf_live_alias', appName: 'host' });
    expect('apiKey' in resolved).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('rename it to `sdkKey`');

    expect(resolveSdkKey({ apiKey: 'evf_live_again' }).sdkKey).toBe('evf_live_again');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('prefers sdkKey when both are set, and says so', () => {
    const resolved = resolveSdkKey({ sdkKey: 'evf_live_new', apiKey: 'evf_live_old' });
    expect(resolved).toEqual({ sdkKey: 'evf_live_new' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('using `sdkKey`');
  });

  it('returns a config with only sdkKey unchanged and silent', () => {
    const config = { sdkKey: 'evf_live_new', appName: 'host' };
    expect(resolveSdkKey(config)).toBe(config);
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns a config with neither name unchanged and silent', () => {
    const config = { appName: 'host' } as unknown as EverframeConfig;
    const resolved = resolveSdkKey(config);
    expect(resolved).toBe(config);
    expect(resolved.sdkKey).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts either name at the type level', () => {
    const current: EverframeConfig = { sdkKey: 'k' };
    const legacy: EverframeConfig = { apiKey: 'k' };
    const both: EverframeConfig = { sdkKey: 'k', apiKey: 'old' };
    // @ts-expect-error a config needs the key under one of the two names
    const neither: EverframeConfig = { appName: 'host' };
    expect([current, legacy, both, neither]).toHaveLength(4);
  });
});

describe('client.init with the deprecated apiKey', () => {
  it('stores the key as sdkKey', () => {
    const client = createClient({} as unknown as PlatformAdapter);
    client.init({ apiKey: 'pk_alias' });
    const config = __internalClientState.get(client)?.config;
    expect(config?.sdkKey).toBe('pk_alias');
    expect(config && 'apiKey' in config).toBe(false);
  });
});
