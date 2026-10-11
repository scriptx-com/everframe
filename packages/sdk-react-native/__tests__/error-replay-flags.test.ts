// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Replays on errors (spec 2026-10-11). The native bridges attach a replay to a JavaScript error only when the
// payload says the app survived it, `fatal: false`. A fatal error ends the app: it is a crash and never carries one.
// JavaScript sends the same two bridge methods as before and the native side decides, so this pins the flag each
// path puts on the call: an error the app survives stays `fatal: false`, and a fatal one stays `fatal: true`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ExceptionsManager, { reported } from './stubs/react-native-exceptions-manager.js';
import NativeEverframe from '../src/NativeEverframe.js';
import { createCaptureController } from '../src/errors.js';

type Controller = ReturnType<typeof createCaptureController>;
type Handler = (error: unknown, isFatal?: boolean) => void;
const occurredAt = '2026-10-11T12:00:00.000Z';
const automatic = vi.mocked(NativeEverframe.reportCrash);
const explicit = vi.mocked(NativeEverframe.captureHandledException);
const originalHandleException = ExceptionsManager.handleException;
const controllers: Controller[] = [];
let errorUtilsHandler: Handler;

function mount(): Controller {
  const created = createCaptureController({ exceptionsManager: ExceptionsManager });
  controllers.push(created);
  return created;
}
function failure(site: string): Error {
  const value = new Error('replay flag fixture');
  value.stack = `Error: replay flag fixture\n    at ${site} (index.bundle:1:5)`;
  return value;
}
const sent = (mock: typeof automatic) => mock.mock.calls.map(([json]) => JSON.parse(json));

beforeEach(() => {
  automatic.mockReset().mockReturnValue(true);
  explicit.mockReset().mockReturnValue(true);
  reported.length = 0;
  errorUtilsHandler = vi.fn();
  vi.stubGlobal('ErrorUtils', {
    getGlobalHandler: () => errorUtilsHandler,
    setGlobalHandler: (handler: Handler) => { errorUtilsHandler = handler; },
  });
});
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.dispose());
  ExceptionsManager.handleException = originalHandleException;
  vi.unstubAllGlobals();
});

describe('errors the app survives reach the bridge as fatal: false', () => {
  const survivable: Array<{ name: string; report: (controller: Controller) => void;
    method: 'reportCrash' | 'captureHandledException'; mechanism: string; handled: boolean }> = [
    { name: 'a non-fatal ErrorUtils error', report: () => errorUtilsHandler(failure('nonFatal'), false),
      method: 'reportCrash', mechanism: 'errorutils', handled: false },
    { name: 'an ErrorUtils error reported without an isFatal argument', report: () => errorUtilsHandler(failure('noFlag')),
      method: 'reportCrash', mechanism: 'errorutils', handled: false },
    { name: 'an unhandled promise rejection',
      report: (controller) => { controller.submitRejection(controller.prepareRejection(failure('rejected'), occurredAt)!); },
      method: 'reportCrash', mechanism: 'unhandledrejection', handled: false },
    { name: 'captureException', report: (controller) => controller.captureException(failure('explicit')),
      method: 'captureHandledException', mechanism: 'captureException', handled: true },
  ];

  it.each(survivable)('$name goes through $method', ({ report, method, mechanism, handled }) => {
    report(mount());
    const [used, unused] = method === 'reportCrash' ? [automatic, explicit] : [explicit, automatic];
    expect(used).toHaveBeenCalledTimes(1);
    expect(unused).not.toHaveBeenCalled();
    const payload = sent(used)[0];
    expect(payload).toMatchObject({ fatal: false, source: 'error', mechanism, handled });
    // Both native bridges depend on an actual boolean fatal flag.
    expect(typeof payload.fatal).toBe('boolean');
  });
});

describe('errors that end the app reach the bridge as fatal: true', () => {
  const fatal: Array<{ name: string; report: () => void }> = [
    { name: 'a fatal ErrorUtils error', report: () => errorUtilsHandler(failure('fatal'), true) },
    { name: 'a React error that no boundary caught', report: () => ExceptionsManager.handleException(failure('uncaught'), true) },
  ];

  it.each(fatal)('$name goes through reportCrash only', ({ report }) => {
    mount();
    report();
    expect(explicit).not.toHaveBeenCalled();
    expect(automatic).toHaveBeenCalledTimes(1);
    const payload = sent(automatic)[0];
    expect(payload).toMatchObject({ fatal: true, source: 'crash', mechanism: 'errorutils', handled: false });
    expect(typeof payload.fatal).toBe('boolean');
  });

  it('a fatal error is not downgraded by an earlier report of the same error', () => {
    mount();
    const error = failure('twice');
    errorUtilsHandler(error, false);
    errorUtilsHandler(error, true);
    expect(sent(automatic).map(({ fatal }) => fatal)).toEqual([false, true]);
  });

  it('a fatal error is never sent through captureHandledException, even after an explicit capture of it', () => {
    const controller = mount();
    const error = failure('explicitThenFatal');
    controller.captureException(error);
    errorUtilsHandler(error, true);
    expect(explicit).toHaveBeenCalledTimes(1);
    expect(sent(explicit)[0]).toMatchObject({ fatal: false, handled: true });
    expect(sent(automatic)).toEqual([expect.objectContaining({ fatal: true, source: 'crash', handled: false })]);
  });
});

describe('errors a boundary catches', () => {
  it('are not sent automatically: React reports them as non-fatal and the app reports them with captureReactError', () => {
    mount();
    ExceptionsManager.handleException(failure('caught'), false);
    expect(automatic).not.toHaveBeenCalled();
    expect(explicit).not.toHaveBeenCalled();
    expect(reported).toHaveLength(1);
  });
});
