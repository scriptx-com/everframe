// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { Platform } from 'react-native';
import NativeEverframe from '../src/NativeEverframe.js';
import { __extractBridgeConfigForTesting as extract, createRuntime, type RuntimeConfig } from '../src/runtime.js';
import { __setCurrentContext } from '../src/contextSeam.js';

const native = NativeEverframe as unknown as { configure: ReturnType<typeof vi.fn>; configureSync?: ReturnType<typeof vi.fn> };
const config = (): RuntimeConfig => ({ sdkKey: 'key', jsBundle: { buildId: 'loaded-a', bundleName: 'index.android.bundle' },
  releaseHealth: { enabled: true, nativeBuildId: 'native-a', userId: 'opaque-a' } });
let warn: MockInstance<typeof console.warn>;
beforeEach(() => { vi.stubGlobal('HermesInternal', {}); vi.spyOn(Platform, 'OS', 'get').mockReturnValue('android');
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { __setCurrentContext(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const healthWarnings = () => warn.mock.calls.map(call => String(call[0])).filter(text => text.includes('releaseHealth'));

describe('explicit native foreground monitoring configuration', () => {
  it('derives the loaded identity from the validated executing Hermes bundle', () => {
    expect(extract(config())).toMatchObject({ releaseHealthEnabled: true, releaseHealthNativeBuildId: 'native-a',
      releaseHealthLoadedBuildId: 'loaded-a', releaseHealthUserId: 'opaque-a' });
  });
  it('accepts iOS Metro metadata and preserves valid opaque Unicode bytes', () => {
    vi.spyOn(Platform, 'OS', 'get').mockReturnValue('ios');
    vi.stubGlobal('__EVERFRAME_BUILD__', { buildId: 'loaded-ios', bundleName: 'main.jsbundle' });
    const opts = extract({ sdkKey: 'key', releaseHealth: { enabled: true,
      nativeBuildId: ' native-🚀 ', userId: 'e\u0301' } });
    expect(opts).toMatchObject({ releaseHealthEnabled: true, releaseHealthLoadedBuildId: 'loaded-ios',
      releaseHealthNativeBuildId: ' native-🚀 ', releaseHealthUserId: 'e\u0301' });
  });
  it('does not infer identity and keeps absent or disabled health off', () => {
    expect(extract({ sdkKey: 'key' }).releaseHealthEnabled).not.toBe(true);
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
  it.each([
    [{ jsBundle: { buildId: '', bundleName: 'index.bundle' } }, ['jsBundle']],
    [{ releaseHealth: { enabled: true, nativeBuildId: ' ' } }, ['releaseHealth.nativeBuildId']],
    [{ releaseHealth: { enabled: true, nativeBuildId: 'native-a', userId: 'secret\u0001' } }, ['releaseHealth.userId']],
    [{ jsBundle: undefined, releaseHealth: { enabled: true, nativeBuildId: '', userId: 'secret\u0001' } },
      ['jsBundle', 'releaseHealth.nativeBuildId', 'releaseHealth.userId']],
  ] as Array<[Partial<RuntimeConfig>, string[]]>)('warns once naming each rejected opt-in field (case %#)', (override, fields) => {
    delete (globalThis as any).__EVERFRAME_BUILD__;
    expect(extract({ ...config(), ...override }).releaseHealthEnabled).toBe(false);
    const warnings = healthWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^\[everframe\] releaseHealth rejected: /);
    for (const field of fields) expect(warnings[0]).toContain(field);
    expect(warnings[0]).toContain('erases undelivered health records');
    expect(warnings[0]).not.toContain('secret');
  });
  it('does not warn for valid, anonymous, explicitly disabled or absent health configuration', () => {
    extract(config());
    extract({ ...config(), releaseHealth: { enabled: true, nativeBuildId: 'native-a', userId: null } });
    extract({ ...config(), jsBundle: undefined, releaseHealth: { enabled: false, nativeBuildId: '' } });
    extract({ sdkKey: 'key' });
    expect(healthWarnings()).toEqual([]);
  });
  it('warns on every configure of a rejected opt-in', () => {
    const runtime = createRuntime({ ...config(), releaseHealth: { enabled: true, nativeBuildId: '' } });
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
        releaseHealthLoadedBuildId: 'loaded-a', releaseHealthUserId: 'opaque-a' }));
    } finally { runtime.unmount(); native.configureSync = sync; }
  });
  it('does not let an older runtime teardown reconfigure the new native owner', () => {
    const first = createRuntime(config());
    const second = createRuntime({ sdkKey: 'key', releaseHealth: { enabled: false, nativeBuildId: 'native-a' } });
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
    const bad: RuntimeConfig = { sdkKey: 'key', releaseHealthEnabled: true }; void bad;
  });
});
