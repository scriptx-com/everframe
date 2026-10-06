// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import NativeEverframe from '../src/NativeEverframe.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import { __setCurrentContext, getReportDeliveryStatus } from '../src/contextSeam.js';
import { getReportDeliveryStatus as publicGetter } from '../src/index.js';
import { getReportDeliveryStatus as browserGetter } from '../src/index.web.js';
import { parseReportDeliveryStatus } from '../src/report-delivery-status.js';

const fixtureText = readFileSync(new URL('./fixtures/report-delivery-status-v1.json', import.meta.url), 'utf8');
const owners: Runtime[] = [];
const original = Object.getOwnPropertyDescriptor(NativeEverframe, 'getReportDeliveryStatusJson');
function bridge(get: () => unknown) { Object.defineProperty(NativeEverframe, 'getReportDeliveryStatusJson', { configurable: true, get }); }
function mount() { const r = createRuntime({ apiKey: 'txx_test_key' }); owners.push(r); r.mount(); return r; }
afterEach(() => {
  owners.splice(0).forEach(r => r.unmount()); __setCurrentContext(null); vi.restoreAllMocks();
  if (original) Object.defineProperty(NativeEverframe, 'getReportDeliveryStatusJson', original);
  else Reflect.deleteProperty(NativeEverframe, 'getReportDeliveryStatusJson');
});

it('native-free fallbacks do not initialize or query the bridge', () => {
  const read = vi.fn(() => { throw new Error('private bridge'); }); bridge(read);
  expect(publicGetter()).toMatchObject({ status: 'not-mounted', reason: 'no-mount', queue: { observation: 'not-observed', quality: 'unknown' } });
  expect(browserGetter()).toMatchObject({ status: 'unsupported', reason: 'platform' });
  expect(read).not.toHaveBeenCalled();
});
it('projects detached fixed-schema native values without changing JS admission', () => {
  mount(); bridge(() => () => fixtureText);
  const first = getReportDeliveryStatus();
  expect(first).toEqual(JSON.parse(fixtureText));
  first.capture.paths['native-handled'].outcomes.persisted = 9;
  expect(getReportDeliveryStatus().capture.paths['native-handled'].outcomes.persisted).toBe(1);
  expect(publicGetter().queue.pendingCount).toBe(1);
});
it.each([
  ['missing', (): undefined => undefined, 'native-method-missing'],
  ['property', () => { throw new Error('private'); }, 'native-call-failed'],
  ['method', () => () => { throw new Error('private'); }, 'native-call-failed'],
  ['non-string', () => () => ({ private: 'content' }), 'invalid-native-snapshot'],
] as const)('%s native bridge has a content-free fallback', (_name, get, reason) => {
  mount(); bridge(get);
  expect(getReportDeliveryStatus()).toMatchObject({ status: 'unavailable', reason, revision: 0 });
  expect(JSON.stringify(getReportDeliveryStatus())).not.toContain('private');
});
it.each([
  ['version', (s: any) => { s.schemaVersion = 2; }],
  ['root-extra', (s: any) => { s.secret = 'private'; }],
  ['nested-extra', (s: any) => { s.queue.operations.private = 1; }],
  ['missing', (s: any) => { delete s.transport['outbox-drain']; }],
  ['negative', (s: any) => { s.revision = -1; }],
  ['fraction', (s: any) => { s.queue.pendingCount = 0.5; }],
  ['overflow', (s: any) => { s.revision = 2147483648; }],
  ['null', (s: any) => { s.queue.pendingCount = null; }],
  ['enum', (s: any) => { s.transport['live-submit'].lastOutcome = 'private'; }],
  ['http', (s: any) => { s.transport['live-submit'].lastHttpStatus = 600; }],
  ['false-zero', (s: any) => { s.queue.observation = 'failed'; s.queue.pendingCount = 0; }],
  ['counter-total', (s: any) => { s.capture.paths['native-handled'].settledAttempts = 4; }],
  ['unsupported-path', (s: any) => { s.capture.paths['native-handled'].supported = false; }],
  ['policy-pair', (s: any) => { s.queue.capacityPolicy = 'evict-oldest'; }],
])('rejects %s without exposing input', (_name, change) => {
  const value = JSON.parse(fixtureText); change(value);
  expect(parseReportDeliveryStatus(JSON.stringify(value))).toBeNull();
});
it.each(['{', ' '.repeat(16_385), 'null', '[]', fixtureText + ' '.repeat(16_385)])('rejects malformed or oversized JSON', text => {
  expect(parseReportDeliveryStatus(text)).toBeNull();
});
it('discarded same-runtime mount cannot return a successor observation', () => {
  const runtime = mount();
  bridge(() => () => { runtime.unmount(); runtime.mount(); return fixtureText; });
  expect(getReportDeliveryStatus()).toMatchObject({ status: 'not-mounted', reason: 'no-mount' });
});
it('property reentrancy cannot call a method after ownership changes', () => {
  const runtime = mount(), method = vi.fn(() => fixtureText);
  bridge(() => { runtime.unmount(); mount(); return method; });
  expect(getReportDeliveryStatus().status).toBe('not-mounted');
  expect(method).not.toHaveBeenCalled();
});
