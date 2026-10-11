// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { Platform } from 'react-native';
import NativeEverframe from '../src/NativeEverframe.js';
import { __extractBridgeConfigForTesting as extract, createRuntime, type RuntimeConfig } from '../src/runtime.js';
import { __setCurrentContext } from '../src/contextSeam.js';

const native = NativeEverframe as unknown as { configure: ReturnType<typeof vi.fn>; configureSync?: ReturnType<typeof vi.fn> };
const config = (): RuntimeConfig => ({ sdkKey: 'key', jsBundle: { buildId: 'ota-build-42', bundleName: 'index.android.bundle' },
  releaseHealth: { enabled: true, userId: 'opaque-a' } });
const warning = (fields: string) => `[everframe] releaseHealth rejected: invalid ${fields}. Foreground-session ` +
  'monitoring is off for this configuration; turning it off erases undelivered health records on this device.';
let warn: MockInstance<typeof console.warn>;
beforeEach(() => { vi.stubGlobal('HermesInternal', {}); vi.spyOn(Platform, 'OS', 'get').mockReturnValue('android');
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { __setCurrentContext(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const healthWarnings = () => warn.mock.calls.map(call => String(call[0])).filter(text => text.includes('releaseHealth'));

describe('explicit native foreground monitoring configuration', () => {
  it('turns on with one line and takes the loaded build from the Hermes bundle', () => {
    const opts = extract({ ...config(), releaseHealth: { enabled: true } });
    expect(opts).toMatchObject({ releaseHealthEnabled: true, releaseHealthLoadedBuildId: 'ota-build-42' });
    expect('releaseHealthNativeBuildId' in opts).toBe(false);
    expect('releaseHealthUserId' in opts).toBe(false);
    expect(healthWarnings()).toEqual([]);
  });
  it('forwards the optional user ID', () => {
    expect(extract({ ...config(), releaseHealth: { enabled: true, userId: 'u-1' } })).toMatchObject({
      releaseHealthEnabled: true, releaseHealthLoadedBuildId: 'ota-build-42', releaseHealthUserId: 'u-1' });
  });
  it('accepts iOS Metro metadata and preserves valid opaque Unicode bytes', () => {
    vi.spyOn(Platform, 'OS', 'get').mockReturnValue('ios');
    vi.stubGlobal('__EVERFRAME_BUILD__', { buildId: 'loaded-ios', bundleName: 'main.jsbundle' });
    const opts = extract({ sdkKey: 'key', releaseHealth: { enabled: true, userId: 'e\u0301' } });
    expect(opts).toMatchObject({ releaseHealthEnabled: true, releaseHealthLoadedBuildId: 'loaded-ios',
      releaseHealthUserId: 'e\u0301' });
  });
  it('does not infer identity and keeps absent or disabled health off', () => {
    expect(extract({ sdkKey: 'key' }).releaseHealthEnabled).not.toBe(true);
    expect(extract({ ...config(), releaseHealth: { enabled: false } })).toMatchObject({ releaseHealthEnabled: false });
    expect(extract({ ...config(), releaseHealth: { enabled: false, userId: 'private' } }))
      .toMatchObject({ releaseHealthEnabled: false });
    expect(extract({ ...config(), releaseHealth: { enabled: true } }).releaseHealthUserId).toBeUndefined();
    expect(JSON.stringify(extract({ ...config(), releaseHealth: { enabled: false, userId: 'private' } }))).not.toContain('private');
  });
  it('treats a null user ID like an omitted one: anonymous monitoring', () => {
    const opts = extract({ ...config(), releaseHealth: { enabled: true, userId: null } });
    expect(opts).toMatchObject({ releaseHealthEnabled: true, releaseHealthLoadedBuildId: 'ota-build-42' });
    expect('releaseHealthUserId' in opts).toBe(false);
  });
  it.each([undefined, { buildId: '', bundleName: 'index.bundle' }, { buildId: 'a', bundleName: '../bad' },
    { buildId: 'a\u0001', bundleName: 'index.bundle' }])('disables monitoring for invalid loaded identity %j', jsBundle => {
    delete (globalThis as any).__EVERFRAME_BUILD__;
    const opts = extract({ ...config(), jsBundle });
    expect(opts.releaseHealthEnabled).toBe(false); expect(opts.releaseHealthLoadedBuildId).toBeUndefined();
  });
  it.each(['', ' ', 'x'.repeat(129), '\ufeff', 'a\u001f'])('disables invalid opaque identity %j', userId => {
    expect(extract({ ...config(), releaseHealth: { enabled: true, userId } }).releaseHealthEnabled).toBe(false);
  });
  it('names only releaseHealth.userId when the user ID is invalid', () => {
    expect(extract({ ...config(), releaseHealth: { enabled: true, userId: ' ' } }).releaseHealthEnabled).toBe(false);
    expect(healthWarnings()).toEqual([warning('releaseHealth.userId')]);
  });
  it('names the Hermes bundle when the jsBundle is missing', () => {
    delete (globalThis as any).__EVERFRAME_BUILD__;
    expect(extract({ ...config(), jsBundle: undefined }).releaseHealthEnabled).toBe(false);
    expect(healthWarnings()).toEqual([warning('jsBundle (no valid Hermes bundle identity)')]);
  });
  it.each([
    [{ jsBundle: { buildId: '', bundleName: 'index.bundle' } }, ['jsBundle (no valid Hermes bundle identity)']],
    [{ releaseHealth: { enabled: true, userId: 'secret\u0001' } }, ['releaseHealth.userId']],
    [{ jsBundle: undefined, releaseHealth: { enabled: true, userId: 'secret\u0001' } },
      ['jsBundle (no valid Hermes bundle identity)', 'releaseHealth.userId']],
  ] as Array<[Partial<RuntimeConfig>, string[]]>)('warns once naming each rejected opt-in field (case %#)', (override, fields) => {
    delete (globalThis as any).__EVERFRAME_BUILD__;
    expect(extract({ ...config(), ...override }).releaseHealthEnabled).toBe(false);
    const warnings = healthWarnings();
    expect(warnings).toEqual([warning(fields.join(', '))]);
    expect(warnings[0]).not.toContain('secret');
  });
  it('does not warn for valid, anonymous, explicitly disabled or absent health configuration', () => {
    extract(config());
    extract({ ...config(), releaseHealth: { enabled: true, userId: null } });
    extract({ ...config(), jsBundle: undefined, releaseHealth: { enabled: false } });
    extract({ sdkKey: 'key' });
    expect(healthWarnings()).toEqual([]);
  });
  it('warns on every configure of a rejected opt-in', () => {
    const runtime = createRuntime({ ...config(), releaseHealth: { enabled: true, userId: ' ' } });
    try {
      runtime.mount(); runtime.unmount(); runtime.mount();
      expect(healthWarnings()).toHaveLength(2);
    } finally { runtime.unmount(); }
  });
  it('rejects unsupported engines/platforms and ignores forged flat fields', () => {
    vi.stubGlobal('HermesInternal', undefined);
    expect(extract(config()).releaseHealthEnabled).toBe(false);
    vi.stubGlobal('HermesInternal', {});
    vi.spyOn(Platform, 'OS', 'get').mockReturnValue('web');
    expect(extract(config()).releaseHealthEnabled).toBe(false);
    expect(extract({ sdkKey: 'key', releaseHealthEnabled: true, releaseHealthLoadedBuildId: 'forged' } as any).releaseHealthEnabled).not.toBe(true);
  });
  it('preserves the legacy configure fallback and snapshots the bridged subject', () => {
    const sync = native.configureSync; native.configureSync = undefined; native.configure.mockClear();
    const input = config(); const runtime = createRuntime(input);
    try {
      runtime.mount(); input.releaseHealth!.userId = 'changed'; input.jsBundle!.buildId = 'changed';
      expect(native.configure).toHaveBeenCalledWith(expect.objectContaining({ releaseHealthEnabled: true,
        releaseHealthLoadedBuildId: 'ota-build-42', releaseHealthUserId: 'opaque-a' }));
    } finally { runtime.unmount(); native.configureSync = sync; }
  });
  it('does not let an older runtime teardown reconfigure the new native owner', () => {
    const first = createRuntime(config());
    const second = createRuntime({ sdkKey: 'key', releaseHealth: { enabled: false } });
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
  it('keeps flat bridge fields and retired release fields outside the host-facing API', () => {
    // @ts-expect-error Only nested releaseHealth is public configuration.
    const bad: RuntimeConfig = { sdkKey: 'key', releaseHealthEnabled: true }; void bad;
    // @ts-expect-error The native SDK reads the app version; there is no build ID to pass.
    const retired: RuntimeConfig = { sdkKey: 'key', releaseHealth: { enabled: true, nativeBuildId: 'x' } }; void retired;
    // @ts-expect-error appVersion was never sent to native and is removed.
    const version: RuntimeConfig = { sdkKey: 'key', appVersion: '1' }; void version;
    // @ts-expect-error appBuild was never sent to native and is removed.
    const build: RuntimeConfig = { sdkKey: 'key', appBuild: '1' }; void build;
  });
});
