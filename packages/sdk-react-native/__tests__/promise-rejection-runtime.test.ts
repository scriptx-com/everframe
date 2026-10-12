// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AdapterOptions } from '../src/hermes-rejection-adapter.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { getPromiseRejectionStatus } from '../src/contextSeam.js';
import NativeEverframe from '../src/NativeEverframe.js';
const engine = vi.hoisted(() => ({ hooks: [] as AdapterOptions[], duringInstall: undefined as (() => void) | undefined }));
vi.mock('../src/hermes-rejection-adapter.js', () => ({
  installHermesRejectionAdapter(options: AdapterOptions) {
    engine.hooks.push(options);
    const callback = engine.duringInstall; engine.duringInstall = undefined; callback?.();
    let live = true;
    return { status: 'observing', adapterId: 'fixture', previousCallbacksPresent: false,
      ownsHooks: () => live, dispose: () => { live = false; } };
  },
}));
const runtimes: Runtime[] = [];
function runtime(crashReporting?: Parameters<typeof createRuntime>[0]['crashReporting']) {
  const r = createRuntime({ sdkKey: 'fixture', ...(crashReporting ? {crashReporting} : {}) });
  runtimes.push(r); return r;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  engine.hooks.length = 0;
  vi.mocked(NativeEverframe.reportCrash).mockClear().mockReturnValue(true);
});
afterEach(() => { runtimes.splice(0).forEach((r) => r.unmount()); vi.useRealTimers(); });
it('returns safe zero status outside a mount', () => {
  expect(getPromiseRejectionStatus()).toMatchObject({ status: 'not-mounted', reason: 'no-mount', counters: {pending: 0, accepted: 0} });
});
it.each([undefined, {promiseRejections: {enabled: false}}, {disabled: true, promiseRejections: {enabled: true}}])('does not install without effective opt-in: %j', (config) => {
  runtime(config).mount();
  expect(getPromiseRejectionStatus().status).toBe('disabled');
  expect(engine.hooks).toHaveLength(0);
});
it('captures once through the owning mounted controller after the grace period', () => {
  runtime({promiseRejections: {enabled: true}}).mount();
  expect(engine.hooks).toHaveLength(1);
  engine.hooks[0].onReject({}, new Error('mounted'));
  vi.advanceTimersByTime(1999); expect(NativeEverframe.reportCrash).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  const payload = JSON.parse(vi.mocked(NativeEverframe.reportCrash).mock.calls[0][0]);
  expect(payload).toMatchObject({ mechanism: 'unhandledrejection', handled: false, fatal: false, message: 'mounted' });
  expect(getPromiseRejectionStatus().counters.accepted).toBe(1);
});
it.each([true, false])('notifies overdue work while timers are paused only through a bridgeless native queue: %s', (bridgeless) => {
  const queued: (() => void)[] = [];
  vi.stubGlobal('RN$Bridgeless', bridgeless);
  vi.stubGlobal('queueMicrotask', (fn: () => void) => { queued.push(fn); });
  try { runtime({promiseRejections: {enabled: true}}).mount(); } finally { vi.unstubAllGlobals(); }
  engine.hooks[0].onReject({}, new Error('paused timers'));
  vi.clearAllTimers(); vi.advanceTimersByTime(2500);
  engine.hooks[0].onHandle({});
  expect(NativeEverframe.reportCrash).not.toHaveBeenCalled();
  queued.splice(0).forEach((fn) => fn());
  expect(NativeEverframe.reportCrash).toHaveBeenCalledTimes(bridgeless ? 1 : 0);
});
it('unmount clears pending work and a remount starts fresh counters', () => {
  const r = runtime({promiseRejections: {enabled: true}}); r.mount();
  const old = engine.hooks[0]; old.onReject({}, new Error('old'));
  r.unmount(); r.mount(); old.onReject({}, new Error('retained callback'));
  vi.advanceTimersByTime(2000);
  expect(NativeEverframe.reportCrash).not.toHaveBeenCalled();
  expect(getPromiseRejectionStatus().counters).toMatchObject({pending: 0, accepted: 0});
});
it('does not let old installation cleanup disconnect a successor', () => {
  const first = runtime({promiseRejections: {enabled: true}});
  const next = runtime({promiseRejections: {enabled: true}});
  engine.duringInstall = () => { first.unmount(); next.mount(); };
  first.mount(); first.unmount();
  expect(getPromiseRejectionStatus().status).toBe('observing');
  engine.hooks[1].onReject({}, new Error('successor'));
  vi.advanceTimersByTime(2000);
  expect(JSON.parse(vi.mocked(NativeEverframe.reportCrash).mock.calls[0][0]).message).toBe('successor');
});
it('configuration takes effect on remount and returned status is detached', () => {
  const config = {promiseRejections: {enabled: false}};
  const r = runtime(config); r.mount(); config.promiseRejections.enabled = true;
  expect(getPromiseRejectionStatus().status).toBe('disabled');
  r.unmount(); r.mount();
  const status = getPromiseRejectionStatus(); status.counters.accepted = 999;
  expect(getPromiseRejectionStatus()).toMatchObject({ status: 'observing', counters: {accepted: 0} });
});
