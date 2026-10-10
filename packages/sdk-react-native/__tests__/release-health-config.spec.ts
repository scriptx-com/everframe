// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import NativeEverframe from '../src/NativeEverframe.js';
import { __extractBridgeConfigForTesting as extract, createRuntime, type RuntimeConfig } from '../src/runtime.js';
import { __setCurrentContext } from '../src/contextSeam.js';

const native = NativeEverframe as unknown as { configure: ReturnType<typeof vi.fn>; configureSync?: ReturnType<typeof vi.fn> };
const config = (): RuntimeConfig => ({ apiKey: 'key', jsBundle: { buildId: 'loaded-a', bundleName: 'index.android.bundle' },
  releaseHealth: { enabled: true, nativeBuildId: 'native-a', userId: 'opaque-a' } });
beforeEach(() => { vi.stubGlobal('HermesInternal', {}); vi.spyOn(Platform, 'OS', 'get').mockReturnValue('android'); });
afterEach(() => { __setCurrentContext(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('explicit native foreground monitoring configuration', () => {
  it('derives the loaded identity from the validated executing Hermes bundle', () => {
    expect(extract(config())).toMatchObject({ releaseHealthEnabled: true, releaseHealthNativeBuildId: 'native-a',
      releaseHealthLoadedBuildId: 'loaded-a', releaseHealthUserId: 'opaque-a' });
  });
  it('accepts iOS Metro metadata and preserves valid opaque Unicode bytes', () => {
    vi.spyOn(Platform, 'OS', 'get').mockReturnValue('ios');
    vi.stubGlobal('__EVERFRAME_BUILD__', { buildId: 'loaded-ios', bundleName: 'main.jsbundle' });
    const opts = extract({ apiKey: 'key', releaseHealth: { enabled: true,
      nativeBuildId: ' native-🚀 ', userId: 'e\u0301' } });
    expect(opts).toMatchObject({ releaseHealthEnabled: true, releaseHealthLoadedBuildId: 'loaded-ios',
      releaseHealthNativeBuildId: ' native-🚀 ', releaseHealthUserId: 'e\u0301' });
  });
  it('does not infer identity and keeps absent or disabled health off', () => {
    expect(extract({ apiKey: 'key' }).releaseHealthEnabled).not.toBe(true);
    expect(extract({ ...config(), releaseHealth: { enabled: false, nativeBuildId: 'native-a', userId: 'private' } }))
      .toMatchObject({ releaseHealthEnabled: false });
    expect(extract({ ...config(), releaseHealth: { enabled: true, nativeBuildId: 'native-a' } }).releaseHealthUserId).toBeUndefined();
    expect(JSON.stringify(extract({ ...config(), releaseHealth: { enabled: false, nativeBuildId: 'native-a', userId: 'private' } }))).not.toContain('private');
  });
  it('treats a null user ID like an omitted one: anonymous monitoring', () => {
    const opts = extract({ ...config(), releaseHealth: { enabled: true, nativeBuildId: 'native-a', userId: null } });
    expect(opts).toMatchObject({ releaseHealthEnabled: true, releaseHealthNativeBuildId: 'native-a',
      releaseHealthLoadedBuildId: 'loaded-a' });
    expect('releaseHealthUserId' in opts).toBe(false);
  });
  it.each([undefined, { buildId: '', bundleName: 'index.bundle' }, { buildId: 'a', bundleName: '../bad' },
    { buildId: 'a\u0001', bundleName: 'index.bundle' }])('disables monitoring for invalid loaded identity %j', jsBundle => {
    delete (globalThis as any).__EVERFRAME_BUILD__;
    const opts = extract({ ...config(), jsBundle });
    expect(opts.releaseHealthEnabled).toBe(false); expect(opts.releaseHealthLoadedBuildId).toBeUndefined();
  });
  it.each(['', ' ', 'x'.repeat(201), 'a\u0000', '\ud800'])('disables invalid native build %j', nativeBuildId => {
    expect(extract({ ...config(), releaseHealth: { enabled: true, nativeBuildId } }).releaseHealthEnabled).toBe(false);
  });
  it.each(['', ' ', 'x'.repeat(129), '\ufeff', 'a\u001f'])('disables invalid opaque identity %j', userId => {
    expect(extract({ ...config(), releaseHealth: { enabled: true, nativeBuildId: 'native', userId } }).releaseHealthEnabled).toBe(false);
  });
  it('rejects unsupported engines/platforms and ignores forged flat fields', () => {
    vi.stubGlobal('HermesInternal', undefined);
    expect(extract(config()).releaseHealthEnabled).toBe(false);
    vi.stubGlobal('HermesInternal', {});
    vi.spyOn(Platform, 'OS', 'get').mockReturnValue('web');
    expect(extract(config()).releaseHealthEnabled).toBe(false);
    expect(extract({ apiKey: 'key', releaseHealthEnabled: true, releaseHealthLoadedBuildId: 'forged' } as any).releaseHealthEnabled).not.toBe(true);
  });
  it('preserves the legacy configure fallback and snapshots the bridged subject', () => {
    const sync = native.configureSync; native.configureSync = undefined; native.configure.mockClear();
    const input = config(); const runtime = createRuntime(input);
    try {
      runtime.mount(); input.releaseHealth!.userId = 'changed'; input.jsBundle!.buildId = 'changed';
      expect(native.configure).toHaveBeenCalledWith(expect.objectContaining({ releaseHealthEnabled: true,
        releaseHealthLoadedBuildId: 'loaded-a', releaseHealthUserId: 'opaque-a' }));
    } finally { runtime.unmount(); native.configureSync = sync; }
  });
  it('does not let an older runtime teardown reconfigure the new native owner', () => {
    const first = createRuntime(config());
    const second = createRuntime({ apiKey: 'key', releaseHealth: { enabled: false, nativeBuildId: 'native-a' } });
    const configure = native.configureSync ?? native.configure;
    configure.mockClear();
    try {
      first.mount(); first.unmount(); second.mount();
      expect(configure).toHaveBeenLastCalledWith(expect.objectContaining({ releaseHealthEnabled: false }));
      const calls = configure.mock.calls.length;
      first.unmount();
      expect(configure).toHaveBeenCalledTimes(calls);
    } finally { first.unmount(); second.unmount(); }
  });
  it('keeps flat bridge fields outside the host-facing API', () => {
    // @ts-expect-error Only nested releaseHealth is public configuration.
    const bad: RuntimeConfig = { apiKey: 'key', releaseHealthEnabled: true }; void bad;
  });
});
