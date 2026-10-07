// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, expect, it, vi } from 'vitest';
import { createPromiseRejectionObserver } from '../src/promise-rejections.js';
import { installHermesRejectionAdapter, type AdapterEnvironment } from '../src/hermes-rejection-adapter.js';

const disposals: (() => void)[] = [];
it.each(['_B', '_C'] as const)('clears pending work permanently when a callback detects temporary %s replacement', (replaced) => {
  const { C, environment } = engine();
  const priorB = vi.fn(), priorC = vi.fn();
  C._B = priorB; C._C = priorC;
  const delivered = vi.fn(() => 'accepted' as const);
  const timers = new Set<() => void>();
  let now = 0;
  const observer = createPromiseRejectionObserver({
    prepareRejection: () => ({ payload: '{}', key: 'pending' }),
    submitRejection: delivered, isActive: () => true,
    scheduler: {
      now: () => now, occurredAt: () => '2026-10-05T12:00:00.000Z',
      setTimer: (fn) => { timers.add(fn); return fn; },
      clearTimer: (handle) => { timers.delete(handle as () => void); },
    },
    installAdapter: (options) => installHermesRejectionAdapter({ ...options, environment }),
  });
  disposals.push(observer.dispose);
  const pending = {};
  C._C!.call(C, pending, 'first');
  expect(timers.size).toBe(1);
  const queued = [...timers];
  const savedB = C._B!, savedC = C._C!;
  const replacement = vi.fn();
  C[replaced] = replacement;
  if (replaced === '_B') {
    C._B!.call(C, pending); // The cancellation happens outside this observer.
    savedC.call(C, {}, 'during gap', 'extra');
    expect(priorC).toHaveBeenLastCalledWith(expect.any(Object), 'during gap', 'extra');
  } else {
    savedB.call(C, {});
    expect(priorB.mock.contexts.at(-1)).toBe(C);
  }
  // Cleanup must happen in the callback, before a status read or timer.
  expect(timers.size).toBe(0);
  expect(C[replaced]).toBe(replacement);
  C._B = savedB; C._C = savedC;
  now = 2000;
  queued.forEach((fn) => fn());
  savedC.call(C, {}, 'after restoration');
  expect(delivered).not.toHaveBeenCalled();
  expect(observer.getStatus()).toMatchObject({
    status: 'displaced', reason: 'hook-displaced', counters: { pending: 0, accepted: 0, discarded: 1 },
  });
});
afterEach(() => { disposals.splice(0).reverse().forEach((dispose) => dispose()); vi.restoreAllMocks(); });
function engine() {
  function Candidate(this: object, executor: (resolve: () => void) => void) { executor(() => {}); }
  const C = Object.assign(Candidate, { _B: null as Function | null, _C: null as Function | null });
  C.prototype.then = function () { C._B?.call(C, this); return {}; };
  const environment: AdapterEnvironment = {
    promise: C, platform: 'android', isTV: false,
    rnVersion: { major: 0, minor: 85, patch: 3, prerelease: '0' },
    hermes: {
      hasPromise: () => true,
      getRuntimeProperties: () => ({ 'OSS Release Version': '250829098.0.10', 'Bytecode Version': 98, Build: 'Release', 'Static Hermes': true }),
      getFunctionLocation: () => ({ isNative: false, segmentID: 0, virtualOffset: 1330, fileName: 'InternalBytecode.js' }),
    },
    functionSource: () => 'function Promise(a0) { [bytecode] }',
  };
  return { C, environment };
}
function install(environment: AdapterEnvironment, overrides = {}) {
  const options = { environment, isActive: () => true, onReject: vi.fn(), onHandle: vi.fn(), ...overrides };
  const result = installHermesRejectionAdapter(options);
  if (result.status === 'observing') disposals.push(result.dispose);
  return { options, result };
}
it('observes genuine callbacks while forwarding receiver and all arguments', () => {
  const { C, environment } = engine();
  const prior = vi.fn(); C._C = prior;
  const { result, options } = install(environment);
  expect(result.status).toBe('observing');
  const promise = {}, reason = new Error('reason');
  C._C!.call(C, promise, reason, 'extra');
  expect(options.onReject).toHaveBeenCalledWith(promise, reason);
  expect(prior.mock.contexts).toEqual([C]);
  expect(prior).toHaveBeenCalledWith(promise, reason, 'extra');
  expect(result.status === 'observing' && result.previousCallbacksPresent).toBe(true);
});
it('does not expose the fulfilled installation handshake to SDK observation', () => {
  const { environment } = engine();
  const { options, result } = install(environment);
  expect(result.status).toBe('observing');
  expect(options.onHandle).not.toHaveBeenCalled();
  expect(options.onReject).not.toHaveBeenCalled();
});
it('rejects a renamed bound constructor with copied hook properties', () => {
  const { C, environment } = engine();
  const bound = C.bind({});
  Object.defineProperty(bound, 'name', { value: 'Promise' });
  Object.defineProperty(bound, 'prototype', Object.getOwnPropertyDescriptor(C, 'prototype')!);
  Object.assign(bound, { _B: null, _C: null });
  environment.promise = bound;
  expect(install(environment).result).toMatchObject({ status: 'unsupported', reason: 'promise-identity' });
  expect(C._B).toBeNull(); expect(C._C).toBeNull();
});
it.each(['runtime', 'platform', 'tv', 'version', 'accessor', 'missing', 'location'] as const)('rejects unsupported %s before observation', (kind) => {
  const { C, environment } = engine();
  if (kind === 'runtime') environment.hermes = undefined;
  if (kind === 'platform') environment.platform = 'web';
  if (kind === 'tv') environment.isTV = true;
  if (kind === 'version') environment.rnVersion = { major: 0, minor: 87, patch: 1 };
  if (kind === 'accessor') Object.defineProperty(C, '_C', { get() { throw new Error('must not read'); } });
  if (kind === 'missing') Reflect.deleteProperty(C, '_C');
  if (kind === 'location') environment.hermes!.getFunctionLocation = () => ({ isNative: true });
  const { result, options } = install(environment);
  expect(result.status).toBe('unsupported');
  expect(options.onReject).not.toHaveBeenCalled();
});
it('preserves previous exceptions but contains SDK callback failures', () => {
  const { C, environment } = engine();
  const priorError = new Error('prior');
  C._C = () => { throw priorError; };
  install(environment, { onReject() { throw new Error('SDK'); } });
  expect(() => C._C!.call(C, {}, new Error('reason'))).toThrow(priorError);
});
it('restores exact callbacks and keeps retained wrappers forwarding after disposal', () => {
  const { C, environment } = engine();
  const prior = vi.fn(); C._C = prior;
  const { result, options } = install(environment);
  const wrapper = C._C!;
  if (result.status !== 'observing') throw new Error('not installed');
  result.dispose(); result.dispose();
  expect(C._C).toBe(prior); expect(C._B).toBeNull();
  wrapper.call(C, {}, 'later');
  expect(options.onReject).not.toHaveBeenCalled();
  expect(prior).toHaveBeenCalledTimes(1);
});
it('preserves partial later replacement and stops captures through the other hook', () => {
  const { C, environment } = engine();
  const { result, options } = install(environment);
  const replacement = vi.fn(); C._C = replacement;
  C._B!.call(C, {});
  expect(options.onHandle).not.toHaveBeenCalled();
  if (result.status !== 'observing') throw new Error('not installed');
  expect(result.ownsHooks()).toBe(false);
  result.dispose();
  expect(C._C).toBe(replacement); expect(C._B).toBeNull();
});
it('does not install after runtime inspection reentrantly revokes ownership', () => {
  const { C, environment } = engine();
  let active = true;
  const inspect = environment.hermes!.getRuntimeProperties;
  environment.hermes!.getRuntimeProperties = () => { active = false; return inspect(); };
  expect(install(environment, { isActive: () => active }).result.status).not.toBe('observing');
  expect(C._B).toBeNull(); expect(C._C).toBeNull();
});
it('old disposal cannot disconnect a successor installed during a prior handle callback', () => {
  const { C, environment } = engine();
  let second: ReturnType<typeof install> | undefined;
  let trigger = false;
  C._B = () => { if (trigger) { trigger = false; second = install(environment); } };
  const first = install(environment);
  trigger = true; C._B!.call(C, {});
  expect(second?.result.status).toBe('observing');
  const next = C._C;
  if (first.result.status === 'observing') first.result.dispose();
  expect(C._C).toBe(next);
  expect(second?.result.status === 'observing' && second.result.ownsHooks()).toBe(true);
});
it('rejects a different Hermes release even with matching hooks', () => {
  const { environment } = engine();
  const inspect = environment.hermes!.getRuntimeProperties;
  environment.hermes!.getRuntimeProperties = () => ({ ...inspect(), 'OSS Release Version': '250829098.0.17' });
  expect(install(environment).result).toEqual({ status: 'unsupported', reason: 'runtime' });
});
it('rolls back the first hook when installing the second hook fails', () => {
  const { C, environment } = engine();
  const define = Object.defineProperty;
  let fail = true;
  vi.spyOn(Object, 'defineProperty').mockImplementation((object, key, descriptor) => {
    if (object === C && key === '_C' && fail) { fail = false; throw new Error('install refused'); }
    return define(object, key, descriptor);
  });
  expect(install(environment).result).toEqual({ status: 'install-failed', reason: 'hook-install' });
  expect(C._B).toBeNull(); expect(C._C).toBeNull();
});
