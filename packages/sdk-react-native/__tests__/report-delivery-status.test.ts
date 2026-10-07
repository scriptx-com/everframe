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
import * as deliveryStatus from '../src/report-delivery-status.js';

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
  expect(getReportDeliveryStatus()).toMatchObject({ status: reason === 'native-method-missing' ? 'unsupported' : 'unavailable', reason, revision: 0 });
  expect(JSON.stringify(getReportDeliveryStatus())).not.toContain('private');
});
it('README names the fallback pairs the getters return', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const start = readme.indexOf('### Native report delivery diagnostics');
  expect(start).toBeGreaterThanOrEqual(0);
  expect(start).toBeLessThan(readme.indexOf('\n## License'));
  const end = readme.slice(start + 1).search(/\n#{2,3} /);
  const section = end < 0 ? readme.slice(start) : readme.slice(start, start + 1 + end);
  const pairs = [publicGetter(), browserGetter()].map(({ status, reason }) => `${status}/${reason}`);
  mount();
  for (const get of [(): undefined => undefined, () => () => { throw new Error('private'); }, () => () => ({})]) {
    bridge(get);
    const { status, reason } = getReportDeliveryStatus();
    pairs.push(`${status}/${reason}`);
  }
  for (const pair of pairs) expect(section).toContain(`\`${pair}\``);
  expect(section).not.toContain('`unavailable/native-method-missing`');
  expect(readme.replace(/\s+/g, ' ')).not.toContain('Native queue and delivery diagnostics remain unavailable');
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

it('bridge accessors cannot weaken fixed enum validation by replacing array intrinsics', () => {
  mount();
  const payload = JSON.parse(fixtureText); payload.queue.migration = 'PRIVATE_NATIVE_CONTENT';
  const text = JSON.stringify(payload), original = Array.prototype.includes;
  let result;
  bridge(() => { Array.prototype.includes = () => true; return () => text; });
  try { result = getReportDeliveryStatus(); } finally { Array.prototype.includes = original; }
  expect(result).toMatchObject({ status: 'unavailable', reason: 'invalid-native-snapshot' });
  expect(JSON.stringify(result)).not.toContain('PRIVATE_NATIVE_CONTENT');
});
it('bridge accessors cannot replace the invocation intrinsic', () => {
  mount(); const original = Reflect.apply; let replacedCalls = 0, result;
  bridge(() => { Reflect.apply = () => { replacedCalls++; throw new Error('private replacement'); }; return () => fixtureText; });
  try { result = getReportDeliveryStatus(); } finally { Reflect.apply = original; }
  expect(replacedCalls).toBe(0);
  expect(result?.status).toBe('active');
});
it('bridge accessors cannot install a parse callback that remounts the runtime', () => {
  const runtime = mount(), original = JSON.parse; let replacedCalls = 0, result;
  bridge(() => { JSON.parse = text => { replacedCalls++; runtime.unmount(); runtime.mount(); return original(text); }; return () => fixtureText; });
  try { result = getReportDeliveryStatus(); } finally { JSON.parse = original; }
  expect(replacedCalls).toBe(0);
  expect(result?.status).toBe('active');
});
it('rechecks mount ownership after projection before exposing the observation', () => {
  const runtime = mount(); bridge(() => () => fixtureText);
  vi.spyOn(deliveryStatus, 'parseReportDeliveryStatus').mockImplementation(text => {
    const result = JSON.parse(String(text)); runtime.unmount(); runtime.mount(); return result;
  });
  expect(getReportDeliveryStatus()).toMatchObject({ status: 'not-mounted', reason: 'no-mount' });
});
it('native-free fallback cannot expose data from a replaced projection intrinsic', () => {
  const original = Object.fromEntries; let result;
  Object.fromEntries = () => ({ private: 'PRIVATE_NATIVE_CONTENT' });
  try { result = browserGetter(); } finally { Object.fromEntries = original; }
  expect(result?.status).toBe('unsupported');
  expect(JSON.stringify(result)).not.toContain('PRIVATE_NATIVE_CONTENT');
});
