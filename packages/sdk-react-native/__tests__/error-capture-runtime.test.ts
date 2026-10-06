// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, expect, it, vi } from 'vitest';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { getErrorCaptureStatus, __setCurrentContext } from '../src/contextSeam.js';
import NativeEverframe from '../src/NativeEverframe.js';
import { captureReactError } from '../src/integrations/react.js';
const owners: Runtime[] = [];
function mount() { const r = createRuntime({ apiKey: 'txx_test_key' }); owners.push(r); r.mount(); return r; }
afterEach(() => { owners.splice(0).forEach(r => r.unmount()); __setCurrentContext(null); vi.restoreAllMocks(); });
it('neutral snapshots and old contexts remain compatible', () => {
  expect(getErrorCaptureStatus()).toMatchObject({ status: 'not-mounted', reason: 'no-mount', scope: 'mounted-js-admission', counters: { handled: { attempted: 0 } } });
  const r = createRuntime({ apiKey: 'txx_test_key' }); const { getErrorCaptureStatus: omitted, ...old } = r; void omitted;
  __setCurrentContext(old); expect(getErrorCaptureStatus().status).toBe('not-mounted');
  __setCurrentContext({ ...old, getErrorCaptureStatus() { throw new Error('host'); }, captureException() { throw new Error('host'); } });
  expect(() => captureReactError(new Error())).not.toThrow(); expect(() => getErrorCaptureStatus()).not.toThrow();
});
it('statusNeverTouchesBridge', () => {
  const r = mount(); const getter = vi.fn(() => { throw new Error('bridge read'); });
  const saved = Object.getOwnPropertyDescriptor(NativeEverframe, 'captureHandledException')!;
  Object.defineProperty(NativeEverframe, 'captureHandledException', { configurable: true, get: getter });
  try {
    const snapshot = getErrorCaptureStatus(); snapshot.counters.handled.accepted = 100; snapshot.limits.handled = 99 as 10;
    expect(getErrorCaptureStatus()).toMatchObject({ status: 'active', limits: { handled: 10 }, counters: { handled: { accepted: 0 } } });
    expect(r.getErrorCaptureStatus!().status).toBe('active'); expect(getter).not.toHaveBeenCalled();
  } finally { Object.defineProperty(NativeEverframe, 'captureHandledException', saved); }
});
