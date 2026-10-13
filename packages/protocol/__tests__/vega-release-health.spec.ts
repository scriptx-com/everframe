// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { expect, it } from 'vitest';
import { ReleaseHealthRecordSchema } from '../src/release-health.js';

const startedAt = '2026-10-13T12:00:00.000Z';
const exposure = {
  exposureId: '11111111-1111-4111-8111-111111111111',
  processLaunchId: '22222222-2222-4222-8222-222222222222',
  startedAt,
  platform: 'vega',
  sdkVersion: '1.2.2',
  app: { version: '1.4.0', build: null, debug: false },
  loadedBuildId: null,
  loadedBundleStatus: 'unknown',
  subject: { kind: 'anonymous' },
  sessionPolicy: 'foreground-v1',
  coverage: {
    policy: 'vega-js-segment-v1',
    sampleRate: 1,
    priorQueueLosses: null,
    queueLossAccounting: 'unavailable',
  },
};
const start = {
  schemaVersion: 5,
  recordId: '33333333-3333-4333-8333-333333333333',
  exposure,
  capturedAt: startedAt,
  phase: 'start',
  sequence: 0,
  elapsedMs: 0,
};

it('admits native Vega foreground sessions independently of browser Vega pages', () => {
  expect(ReleaseHealthRecordSchema.parse(start)).toEqual(start);
  const end = {
    ...start,
    recordId: '44444444-4444-4444-8444-444444444444',
    capturedAt: '2026-10-13T12:01:00.000Z',
    phase: 'end',
    sequence: 1,
    elapsedMs: 60000,
    outcome: 'completed',
    endReason: 'background',
  };
  expect(ReleaseHealthRecordSchema.parse(end)).toEqual(end);
  const { processLaunchId, loadedBuildId, loadedBundleStatus, coverage, ...page } = exposure;
  const web = {
    ...start,
    schemaVersion: 6,
    exposure: { ...page, pageLaunchId: processLaunchId, sessionPolicy: 'page-v1' },
  };
  expect(ReleaseHealthRecordSchema.parse(web)).toEqual(web);
  expect(ReleaseHealthRecordSchema.safeParse({ ...web, schemaVersion: 5 }).success).toBe(false);
  expect(ReleaseHealthRecordSchema.safeParse({ ...start, schemaVersion: 6 }).success).toBe(false);
});

it.each([
  { coverage: { ...exposure.coverage, policy: 'vega-sdk-segment-v1' } },
  { coverage: { ...exposure.coverage, policy: 'ios-sdk-segment-v1' } },
  { processLaunchId: null },
  { pageLaunchId: exposure.processLaunchId },
  { sessionPolicy: 'page-v1' },
  { loadedBundleStatus: 'known', loadedBuildId: null },
])('rejects an incompatible native Vega identity: %j', (patch) => {
  expect(
    ReleaseHealthRecordSchema.safeParse({ ...start, exposure: { ...exposure, ...patch } }).success,
  ).toBe(false);
});

it('freezes known Vega bundle identity without changing the native pointer key order', () => {
  const record = {
    ...start,
    exposure: { ...exposure, loadedBundleStatus: 'known', loadedBuildId: 'a'.repeat(64) },
  };
  const parsed = ReleaseHealthRecordSchema.parse(record);
  expect(parsed).toEqual(record);
  expect(Object.keys(parsed.exposure)).toEqual(Object.keys(exposure));
});
