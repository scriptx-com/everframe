// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import { installErrorHandler } from '../src/errors.js';
import { createRuntime } from '../src/runtime.js';
import NativeTraceItX from '../src/NativeTraceItX.js';

let teardown: (() => void) | undefined;
afterEach(() => { teardown?.(); vi.unstubAllGlobals(); vi.clearAllMocks(); Platform.OS = 'android'; });
function capture(jsBundle: unknown, platform = 'android', hermes = true) {
  Object.assign(Platform, { OS: platform });
  vi.stubGlobal('HermesInternal', hermes ? {} : undefined);
  let installed: (error: unknown, fatal?: boolean) => void = () => {};
  const previous = vi.fn();
  teardown = installErrorHandler({ jsBundle: jsBundle as never, errorUtils: {
    getGlobalHandler: () => previous, setGlobalHandler: (handler) => { installed = handler; },
  } });
  installed(new Error('hermes-identity'), false);
  expect(previous).toHaveBeenCalledOnce();
  return JSON.parse(vi.mocked(NativeTraceItX.reportCrash).mock.calls[0][0]);
}
it.each(['android', 'ios'])('attaches actual Hermes %s identity', platform => {
  expect(capture({ buildId: 'run-7', bundleName: 'index.bundle' }, platform).jsBundle)
    .toEqual({ engine: 'hermes', platform, buildId: 'run-7', bundleName: 'index.bundle' });
});
it.each([' release 7 ', '😀'.repeat(100)])('preserves valid build ID exactly', buildId => {
  expect(capture({ buildId, bundleName: 'index.bundle' }).jsBundle.buildId).toBe(buildId);
});
it.each(['', '  ', 'x\0y', '\ud800', '\udc00', 'x'.repeat(201), '😀'.repeat(101)])('invalid build ID keeps raw capture: %j', buildId => {
  expect(capture({ buildId, bundleName: 'index.bundle' }).jsBundle).toBeUndefined();
});
it.each(['', '../index.bundle', 'a/b', 'a b', 'index.bundle\n', '.bundle', 'x'.repeat(129)])('invalid bundle keeps capture: %j', bundleName => {
  expect(capture({ buildId: 'run-7', bundleName }).jsBundle).toBeUndefined();
});
it('omits absent identity', () => expect(capture(undefined).jsBundle).toBeUndefined());
it('omits identity without Hermes', () => expect(capture({ buildId: '7', bundleName: 'index.bundle' }, 'android', false).jsBundle).toBeUndefined());
it('omits unsupported platform', () => expect(capture({ buildId: '7', bundleName: 'index.bundle' }, 'web').jsBundle).toBeUndefined());
it('snapshots identity at runtime mount and picks a new build after remount', () => {
  vi.stubGlobal('HermesInternal', {});
  let installed: (error: unknown, fatal?: boolean) => void = () => {};
  vi.stubGlobal('ErrorUtils', { getGlobalHandler: () => () => {}, setGlobalHandler: (h: typeof installed) => { installed = h; } });
  const jsBundle = { buildId: 'first', bundleName: 'index.bundle' };
  const rt = createRuntime({ apiKey: 'k', jsBundle });
  teardown = () => rt.unmount();
  rt.mount();
  jsBundle.buildId = 'second';
  installed(new Error('first'), true);
  rt.unmount(); rt.mount(); installed(new Error('second'), true);
  expect(vi.mocked(NativeTraceItX.reportCrash).mock.calls.map(([json]) => JSON.parse(json).jsBundle?.buildId)).toEqual(['first', 'second']);
  expect(vi.mocked(NativeTraceItX.configureSync).mock.calls[0][0]).not.toHaveProperty('jsBundle');
});
