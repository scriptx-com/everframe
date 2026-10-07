// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import NativeEverframe from '../src/NativeEverframe.js';
import { createCaptureController } from '../src/errors.js';
import { createErrorCaptureLedger, emptyErrorCaptureStatus, incrementErrorCaptureCounter } from '../src/error-capture-status.js';
const handled = vi.mocked(NativeEverframe.captureHandledException);
const automatic = vi.mocked(NativeEverframe.reportCrash);
const descriptors = new Map<string, PropertyDescriptor>();
function bridgeGetter(name: 'captureHandledException' | 'reportCrash', get: () => unknown) {
  if (!descriptors.has(name)) descriptors.set(name, Object.getOwnPropertyDescriptor(NativeEverframe, name)!);
  Object.defineProperty(NativeEverframe, name, { configurable: true, get });
}
const owners: ReturnType<typeof createCaptureController>[] = [];
function owner(previous = vi.fn()) {
  let handler = previous as (error: unknown, fatal?: boolean) => void;
  const controller = createCaptureController({ errorUtils: {
    getGlobalHandler: () => handler, setGlobalHandler: cb => { handler = cb; },
  } });
  owners.push(controller);
  return { controller, send: (error: unknown, fatal = false) => handler(error, fatal) };
}
function error(site = 'secretSite') { const e = new Error('secret message'); e.stack = `Error: secret message\n at ${site} (index.bundle:1:5)`; return e; }
beforeEach(() => { handled.mockReset().mockReturnValue(true); automatic.mockReset().mockReturnValue(true); });
afterEach(() => { owners.splice(0).forEach(c => c.dispose()); vi.restoreAllMocks(); for (const [key, descriptor] of descriptors) Object.defineProperty(NativeEverframe, key, descriptor); descriptors.clear(); });
it('snapshots are detached, content-free and counters saturate', () => {
  const ledger = createErrorCaptureLedger(), settle = ledger.begin('handled');
  settle('accepted'); settle('captureFailed');
  expect(ledger.snapshot().handled).toMatchObject({ attempted: 1, accepted: 1, captureFailed: 0 });
  const snapshot = ledger.snapshot(); snapshot.handled.accepted = 123;
  expect(ledger.snapshot().handled.accepted).toBe(1);
  const counters = emptyErrorCaptureStatus('active', 'none').counters.handled;
  counters.accepted = 2147483646;
  incrementErrorCaptureCounter(counters, 'accepted'); incrementErrorCaptureCounter(counters, 'accepted');
  expect(counters.accepted).toBe(2147483647);
  const { controller } = owner(); controller.captureException(error());
  expect(JSON.stringify(controller.getErrorCaptureStatus())).not.toContain('secret');
});
it('duplicateBeforeFullAllowance', () => {
  const { controller } = owner(); const first = error('first');
  controller.captureException(first);
  for (let i = 0; i < 9; i++) controller.captureException(error(`site${String.fromCharCode(65+i)}`));
  controller.captureException(first); controller.captureException(error('first')); controller.captureException(error('eleventh'));
  expect(controller.getErrorCaptureStatus().counters.handled).toMatchObject({ attempted: 13, accepted: 10, duplicateSuppressed: 2, allowanceSuppressed: 1 });
  expect(handled).toHaveBeenCalledTimes(10);
});
it('refusal leaves identity available for recapture', () => {
  const { controller } = owner(), e = error(); handled.mockReturnValueOnce(false);
  controller.captureException(e); controller.captureException(e);
  expect(controller.getErrorCaptureStatus().counters.handled).toMatchObject({ attempted: 2, nativeRefused: 1, accepted: 1 });
});
it('reentrantAttemptSettlesOnce', () => {
  const { controller } = owner();
  handled.mockImplementationOnce(() => { controller.captureException(error('nested')); return true; });
  controller.captureException(error());
  expect(controller.getErrorCaptureStatus().counters.handled).toMatchObject({ attempted: 2, accepted: 1, reentrantSuppressed: 1 });
});
it('teardownCannotChargeSuccessor', () => {
  const { controller } = owner(); let successor: ReturnType<typeof owner> | undefined;
  const e = error(); Object.defineProperty(e, 'message', { get() { controller.dispose(); successor ??= owner(); return 'stale'; } });
  controller.captureException(e);
  expect(controller.getErrorCaptureStatus().counters.handled).toMatchObject({ attempted: 1, inactiveAborted: 1, accepted: 0 });
  expect(successor!.controller.getErrorCaptureStatus().counters.handled.attempted).toBe(0);
  expect(handled).not.toHaveBeenCalled();
});
it('previousHandlerExceptionSurvives', () => {
  const sentinel = new Error('prior handler'); const { controller, send } = owner(vi.fn(() => { throw sentinel; }));
  expect(() => send(error())).toThrow(sentinel);
  expect(controller.getErrorCaptureStatus().counters.errorUtils.accepted).toBe(1);
});
it('legacyTrueIsOnlyAttempted', () => {
  bridgeGetter('captureHandledException', () => undefined);
  const { controller, send } = owner(); send(error());
  expect(controller.getErrorCaptureStatus().counters.errorUtils).toMatchObject({ attempted: 1, accepted: 0, legacyAttempted: 1 });
});
it('legacyMissingAndThrowingMethods', () => {
  bridgeGetter('captureHandledException', () => { throw new Error('optional lookup'); });
  const { controller, send } = owner(); send(error('legacy'));
  automatic.mockImplementationOnce(() => { throw new Error('chosen call'); }); send(error('throws'));
  bridgeGetter('reportCrash', () => undefined); send(error('missing'));
  send(error('throws'));
  expect(controller.getErrorCaptureStatus().counters.errorUtils).toMatchObject({ attempted: 4, legacyAttempted: 1, captureFailed: 1, bridgeUnavailable: 1, duplicateSuppressed: 1 });
  controller.captureException(error());
  expect(controller.getErrorCaptureStatus().counters.handled.captureFailed).toBe(1);
});
it('fatalEscalationStillReports', () => {
  const { controller, send } = owner(), e = error(); controller.captureException(e); send(e); send(e, true);
  expect(controller.getErrorCaptureStatus().counters.errorUtils).toMatchObject({ attempted: 2, accepted: 1, duplicateSuppressed: 1 });
  expect(automatic).toHaveBeenCalledTimes(1);
  expect(JSON.parse(automatic.mock.calls[0][0])).toMatchObject({ fatal: true, source: 'crash' });
});
it('foreignAndDisposedSnapshotsDoNotCount', () => {
  const first = owner().controller, second = owner().controller;
  const snapshot = first.prepareRejection(error(), '2026-10-06T00:00:00Z')!;
  expect(second.submitRejection(snapshot)).toBe('inactive'); first.dispose();
  expect(first.submitRejection(snapshot)).toBe('inactive');
  expect(first.getErrorCaptureStatus().counters.rejection.attempted).toBe(0);
  expect(second.getErrorCaptureStatus().counters.rejection.attempted).toBe(0);
});
it('preparationAndCancellationAreNotSubmission', () => {
  const { controller } = owner(); controller.prepareRejection(error(), '2026-10-06T00:00:00Z');
  expect(controller.getErrorCaptureStatus().counters.rejection.attempted).toBe(0);
  const snapshot = controller.prepareRejection(error(), '2026-10-06T00:00:00Z')!;
  expect(controller.submitRejection(snapshot)).toBe('accepted'); expect(controller.submitRejection(snapshot)).toBe('duplicate');
  expect(controller.getErrorCaptureStatus().counters.rejection).toMatchObject({ attempted: 2, accepted: 1, duplicateSuppressed: 1 });
});
it('explicit missing and throwing native methods have distinct outcomes', () => {
  const { controller } = owner();
  bridgeGetter('captureHandledException', () => undefined); controller.captureException(error());
  bridgeGetter('captureHandledException', () => { throw new Error('lookup'); }); controller.captureException(error());
  bridgeGetter('captureHandledException', () => () => { throw new Error('invoke'); }); controller.captureException(error());
  expect(controller.getErrorCaptureStatus().counters.handled).toMatchObject({ attempted: 3, bridgeUnavailable: 1, captureFailed: 2 });
});
it('rejection submission observes allowance, refusal, reentrancy and teardown independently', () => {
  const { controller } = owner();
  const prepare = (site: string) => controller.prepareRejection(error(site), '2026-10-06T00:00:00Z')!;
  const nested = prepare('nested');
  automatic.mockImplementationOnce(() => { expect(controller.submitRejection(nested)).toBe('capture-failed'); return true; });
  expect(controller.submitRejection(prepare('first'))).toBe('accepted');
  automatic.mockReturnValueOnce(false); expect(controller.submitRejection(nested)).toBe('native-refused');
  automatic.mockImplementationOnce(() => { throw new Error('invoke'); }); expect(controller.submitRejection(nested)).toBe('capture-failed');
  bridgeGetter('reportCrash', () => undefined); expect(controller.submitRejection(nested)).toBe('native-refused');
  bridgeGetter('reportCrash', () => automatic);
  for (let i = 0; i < 9; i++) expect(controller.submitRejection(prepare(`site${String.fromCharCode(65+i)}`))).toBe('accepted');
  expect(controller.submitRejection(nested)).toBe('allowance');
  expect(controller.getErrorCaptureStatus().counters.rejection).toMatchObject({ attempted: 15, accepted: 10,
    reentrantSuppressed: 1, nativeRefused: 1, captureFailed: 1, bridgeUnavailable: 1, allowanceSuppressed: 1 });
  const other = owner().controller, pending = other.prepareRejection(error(), '2026-10-06T00:00:00Z')!;
  bridgeGetter('reportCrash', () => { other.dispose(); return automatic; });
  expect(other.submitRejection(pending)).toBe('inactive');
  expect(other.getErrorCaptureStatus().counters.rejection).toMatchObject({ attempted: 1, inactiveAborted: 1 });
});
