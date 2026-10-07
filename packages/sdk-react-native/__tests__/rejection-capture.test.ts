// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import NativeEverframe from '../src/NativeEverframe.js';
import { createCaptureController } from '../src/errors.js';

const occurredAt = '2026-10-05T12:00:00.000Z';
const owners: ReturnType<typeof createCaptureController>[] = [];
function controller() {
  const value = createCaptureController({ jsBundle: { buildId: 'rejection-build', bundleName: 'index.bundle' } });
  owners.push(value);
  return value;
}
function error(site = 'rejectionSite') {
  const value = new Error('original message');
  value.stack = `Error: original message\n at ${site} (index.bundle:1:5)`;
  return value;
}
const automatic = vi.mocked(NativeEverframe.reportCrash);
const explicit = vi.mocked(NativeEverframe.captureHandledException);
beforeEach(() => {
  vi.stubGlobal('HermesInternal', {});
  automatic.mockReset().mockReturnValue(true);
  explicit.mockReset().mockReturnValue(true);
});
afterEach(() => { owners.splice(0).forEach((owner) => owner.dispose()); vi.unstubAllGlobals(); });

it('doesNotReserveAcceptanceWhilePending', () => {
  const owner = controller(), reason = error();
  const pending = owner.prepareRejection(reason, occurredAt)!;
  expect(automatic).not.toHaveBeenCalled();
  owner.captureException(reason);
  expect(explicit).toHaveBeenCalledTimes(1);
  expect(owner.submitRejection(pending)).toBe('duplicate');
  expect(automatic).not.toHaveBeenCalled();
});
it('refusalAllowsLaterExplicitCapture', () => {
  automatic.mockReturnValue(false);
  const owner = controller(), reason = error();
  expect(owner.submitRejection(owner.prepareRejection(reason, occurredAt)!)).toBe('native-refused');
  owner.captureException(reason);
  expect(automatic).toHaveBeenCalledTimes(1);
  expect(explicit).toHaveBeenCalledTimes(1);
});
it('acceptedExplicitSuppressesPendingRejection', () => {
  const owner = controller(), reason = error();
  owner.captureException(reason);
  const pending = owner.prepareRejection(reason, occurredAt)!;
  expect(owner.submitRejection(pending)).toBe('duplicate');
  expect(automatic).not.toHaveBeenCalled();
});
it('accepted rejection suppresses later explicit capture of the same object', () => {
  const owner = controller(), reason = error();
  expect(owner.submitRejection(owner.prepareRejection(reason, occurredAt)!)).toBe('accepted');
  owner.captureException(reason);
  expect(explicit).not.toHaveBeenCalled();
});
it('snapshotSurvivesCauseMutation', () => {
  const owner = controller(), reason = error();
  const cause = new Error('before');
  Object.defineProperty(reason, 'cause', { value: cause });
  const pending = owner.prepareRejection(reason, occurredAt)!;
  reason.message = 'changed'; cause.message = 'after';
  expect(owner.submitRejection(pending)).toBe('accepted');
  const payload = JSON.parse(automatic.mock.calls[0][0]);
  expect(payload).toMatchObject({ message: 'original message', occurredAt,
    mechanism: 'unhandledrejection', source: 'error', handled: false, fatal: false,
    jsBundle: { buildId: 'rejection-build', bundleName: 'index.bundle' },
    causeChain: { causes: [{ message: 'before' }] },
  });
  expect(pending).not.toHaveProperty('error');
  expect(pending).not.toHaveProperty('reason');
});
it('shares automatic allowance while preserving independent explicit allowance', () => {
  const owner = controller();
  for (let i = 0; i < 10; i++)
    expect(owner.submitRejection(owner.prepareRejection(error(`site${String.fromCharCode(65 + i)}`), occurredAt)!)).toBe('accepted');
  const reason = error('eleventh');
  expect(owner.submitRejection(owner.prepareRejection(reason, occurredAt)!)).toBe('allowance');
  owner.captureException(reason);
  expect(explicit).toHaveBeenCalledTimes(1);
  expect(automatic).toHaveBeenCalledTimes(10);
});
function errorUtilsController() {
  let handler: ((error: unknown, isFatal?: boolean) => void) | undefined;
  const owner = createCaptureController({ jsBundle: { buildId: 'rejection-build', bundleName: 'index.bundle' },
    errorUtils: { getGlobalHandler: () => () => {}, setGlobalHandler: (installed) => { handler = installed; } } });
  owners.push(owner);
  return { owner, report: (value: unknown, fatal = false) => handler!(value, fatal) };
}
it('rejections share automatic keys with ErrorUtils reports', () => {
  const { owner, report } = errorUtilsController();
  report(error('sharedSite'));
  expect(owner.submitRejection(owner.prepareRejection(error('sharedSite'), occurredAt)!)).toBe('duplicate');
  expect(automatic).toHaveBeenCalledTimes(1);
});
it('ErrorUtils reports spend the automatic allowance that rejections share', () => {
  const { owner, report } = errorUtilsController();
  for (let i = 0; i < 10; i++) report(error(`site${String.fromCharCode(65 + i)}`));
  expect(owner.submitRejection(owner.prepareRejection(error('eleventh'), occurredAt)!)).toBe('allowance');
  expect(automatic).toHaveBeenCalledTimes(10);
});
it('an accepted rejection does not suppress a later fatal crash of the same error', () => {
  const { owner, report } = errorUtilsController(), reason = error();
  expect(owner.submitRejection(owner.prepareRejection(reason, occurredAt)!)).toBe('accepted');
  report(reason, true);
  expect(automatic).toHaveBeenCalledTimes(2);
  expect(JSON.parse(automatic.mock.calls[1][0])).toMatchObject({ fatal: true, source: 'crash', mechanism: 'errorutils' });
});
it('refuses rejection capture on a bridge without handled-exception support', () => {
  const owner = controller(), pending = owner.prepareRejection(error(), occurredAt)!;
  const descriptor = Object.getOwnPropertyDescriptor(NativeEverframe, 'captureHandledException')!;
  Object.defineProperty(NativeEverframe, 'captureHandledException', { configurable: true, value: undefined });
  try { expect(owner.submitRejection(pending)).toBe('native-refused'); }
  finally { Object.defineProperty(NativeEverframe, 'captureHandledException', descriptor); }
  expect(automatic).not.toHaveBeenCalled();
});
it('refusal does not spend an automatic key', () => {
  const owner = controller();
  automatic.mockReturnValueOnce(false);
  expect(owner.submitRejection(owner.prepareRejection(error(), occurredAt)!)).toBe('native-refused');
  expect(owner.submitRejection(owner.prepareRejection(error(), occurredAt)!)).toBe('accepted');
});
it('refuses stale or foreign snapshots without invoking native', () => {
  const first = controller(), second = controller();
  const pending = first.prepareRejection(error(), occurredAt)!;
  expect(second.submitRejection(pending)).toBe('inactive');
  first.dispose();
  expect(first.submitRejection(pending)).toBe('inactive');
  expect(automatic).not.toHaveBeenCalled();
});
it('getter disposal prevents preparation from surviving its owner', () => {
  const owner = controller(), reason = error();
  Object.defineProperty(reason, 'message', { get() { owner.dispose(); return 'stale'; } });
  expect(owner.prepareRejection(reason, occurredAt)).toBeUndefined();
  expect(automatic).not.toHaveBeenCalled();
});
it('native lookup disposal prevents stale submission', () => {
  const owner = controller(), pending = owner.prepareRejection(error(), occurredAt)!;
  const descriptor = Object.getOwnPropertyDescriptor(NativeEverframe, 'reportCrash')!;
  Object.defineProperty(NativeEverframe, 'reportCrash', { configurable: true, get() { owner.dispose(); return automatic; } });
  try { expect(owner.submitRejection(pending)).toBe('inactive'); }
  finally { Object.defineProperty(NativeEverframe, 'reportCrash', descriptor); }
  expect(automatic).not.toHaveBeenCalled();
});
it.each([
  ['fetch response', { type: 'default', status: 401, ok: false, headers: { map: { 'set-cookie': 'sid=secret-cookie' } },
    url: 'https://api.example.com/v1/me?api_key=sk_live_secret' }, '[object]'],
  ['request config', { config: { headers: { Authorization: 'Token abc123', 'x-api-key': 'live_abc123' } } }, '[object]'],
  ['array', ['secret-cookie'], '[object]'],
  ['function', function secretCookie() {}, '[function]'],
  ['symbol', Symbol('secret-cookie'), '[symbol]'],
  ['bigint', BigInt(42), '[bigint]'],
  ['string', 'Session expired', 'Session expired'],
  ['number', 404, '404'],
  ['undefined', undefined, 'undefined'],
  ['null', null, 'null'],
])('reports a non-Error %s reason without serializing its contents', (_kind, reason, message) => {
  const owner = controller();
  expect(owner.submitRejection(owner.prepareRejection(reason, occurredAt)!)).toBe('accepted');
  const raw = automatic.mock.calls[0][0];
  expect(JSON.parse(raw)).toMatchObject({ exceptionType: 'UnhandledValue', message, framesRaw: [],
    mechanism: 'unhandledrejection' });
  for (const secret of ['secret-cookie', 'sk_live_secret', 'abc123']) expect(raw).not.toContain(secret);
});
it('deduplicates non-Error reasons by their reported value', () => {
  const owner = controller();
  const submit = (reason: unknown) => owner.submitRejection(owner.prepareRejection(reason, occurredAt)!);
  expect(['Session expired', 'Network timeout', 'Session expired', { code: 'E_AUTH' }, undefined, 42,
    { code: 'E_PAYMENT' }, '42'].map(submit))
    .toEqual(['accepted', 'accepted', 'duplicate', 'accepted', 'accepted', 'accepted', 'duplicate', 'duplicate']);
  expect(automatic.mock.calls.map(([raw]) => JSON.parse(raw).message))
    .toEqual(['Session expired', 'Network timeout', '[object]', 'undefined', '42']);
});
it('contains bridge failure and leaves later explicit admission available', () => {
  const owner = controller(), reason = error();
  automatic.mockImplementationOnce(() => { throw new Error('bridge unavailable'); });
  expect(owner.submitRejection(owner.prepareRejection(reason, occurredAt)!)).toBe('capture-failed');
  owner.captureException(reason);
  expect(explicit).toHaveBeenCalledTimes(1);
});
