// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createCaptureController, type CaptureController } from '../src/errors.js';
import NativeEverframe from '../src/NativeEverframe.js';
import { Platform } from 'react-native';
let controller: CaptureController | undefined;
const handled = vi.mocked(NativeEverframe.captureHandledException);
const automatic = vi.mocked(NativeEverframe.reportCrash);
const makeError = () => {
  const cause = new TypeError('inner');
  cause.stack = 'TypeError: inner\n    at inner (index.android.bundle:1:42)';
  const error = new Error('outer', { cause });
  error.stack = 'Error: outer\n    at outer (index.android.bundle:1:7)';
  return { error, cause };
};
beforeEach(() => { handled.mockReset().mockReturnValue(true); automatic.mockReset().mockReturnValue(true); });
afterEach(() => { controller?.dispose(); controller = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('sends an owned handled cause snapshot with unchanged Hermes identity', () => {
  vi.stubGlobal('HermesInternal', {});
  vi.spyOn(Platform, 'OS', 'get').mockReturnValue('android');
  controller = createCaptureController({ jsBundle: { buildId: 'owned-build', bundleName: 'index.android.bundle' } });
  const { error, cause } = makeError();
  controller.captureException(error);
  cause.message = 'mutated';
  expect(JSON.parse(handled.mock.calls[0]![0])).toMatchObject({ exceptionType: 'Error', message: 'outer', handled: true, fatal: false,
    jsBundle: { engine: 'hermes', platform: 'android', buildId: 'owned-build', bundleName: 'index.android.bundle' },
    causeChain: { truncated: false, causes: [{ exceptionType: 'TypeError', message: 'inner', framesTruncated: false,
      frames: [{ raw: 'at inner (index.android.bundle:1:42)' }] }] },
  });
});
it('captures automatic causes and chains the exact previous-handler arguments', () => {
  const previous = vi.fn();
  let installed = previous as (error: unknown, fatal?: boolean) => void;
  controller = createCaptureController({ errorUtils: { getGlobalHandler: () => installed, setGlobalHandler: fn => { installed = fn; } } });
  const { error } = makeError();
  installed(error, true);
  expect(JSON.parse(automatic.mock.calls[0]![0])).toMatchObject({ handled: false, fatal: true, mechanism: 'errorutils', causeChain: { causes: [{ message: 'inner' }] } });
  expect(previous.mock.calls).toEqual([[error, true]]);
});
it('does not invoke accessor causes or add enrichment when cause is absent', () => {
  controller = createCaptureController({});
  const error = new Error('plain');
  controller.captureException(error);
  expect(JSON.parse(handled.mock.calls[0]![0])).not.toHaveProperty('causeChain');
  controller.dispose(); controller = createCaptureController({});
  const getter = vi.fn(() => { throw new Error('do not call'); });
  Object.defineProperty(error, 'cause', { get: getter });
  controller.captureException(error);
  expect(getter).not.toHaveBeenCalled();
  expect(JSON.parse(handled.mock.calls[1]![0]).causeChain).toEqual({ causes: [], truncated: true });
});
it('does not submit after cause inspection disposes the capture owner', () => {
  controller = createCaptureController({});
  const { error } = makeError();
  const proxy = new Proxy(error, { getOwnPropertyDescriptor(target, key) {
    if (key === 'cause') controller!.dispose();
    return Reflect.getOwnPropertyDescriptor(target, key);
  } });
  controller.captureException(proxy);
  expect(handled).not.toHaveBeenCalled();
});
it('drops a cause token cut by the scan window before the JavaScript redactor runs', () => {
  controller = createCaptureController({});
  const { error, cause } = makeError();
  cause.message = `${'x'.repeat(4_000)} eyJhbGciOiJIUzI1NiJ9.${'A'.repeat(9_000)}.${'S'.repeat(43)}`;
  controller.captureException(error);
  const sent = JSON.parse(handled.mock.calls[0]![0]).causeChain;
  expect(sent.causes[0].message).toBe('x'.repeat(4_000));
  expect(sent.truncated).toBe(true);
});
it('retries refused enqueue and deduplicates accepted causes by the outer error', () => {
  controller = createCaptureController({});
  const { error, cause } = makeError();
  handled.mockReturnValueOnce(false);
  controller.captureException(error); controller.captureException(error);
  cause.message = 'different inner'; controller.captureException(error);
  expect(handled).toHaveBeenCalledTimes(2);
  expect(handled.mock.calls.map(([json]) => JSON.parse(json).causeChain.causes[0].message)).toEqual(['inner', 'inner']);
});
