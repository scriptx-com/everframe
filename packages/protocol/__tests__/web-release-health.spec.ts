// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { expect, it } from 'vitest';
import { ReleaseHealthRecordSchema } from '../src/release-health.js';
const startedAt = '2026-10-13T12:00:00.000Z';
const webStart = {
  schemaVersion: 6,
  recordId: '33333333-3333-4333-8333-333333333333',
  exposure: {
    exposureId: '11111111-1111-4111-8111-111111111111',
    pageLaunchId: '22222222-2222-4222-8222-222222222222',
    startedAt,
    platform: 'web',
    sdkVersion: '1.2.2',
    app: { version: '12.3.5-12-web', build: null, debug: false },
    subject: { kind: 'anonymous' },
    sessionPolicy: 'page-v1',
  },
  capturedAt: startedAt,
  phase: 'start',
  sequence: 0,
  elapsedMs: 0,
};
it.each(['web', 'tizen', 'webos', 'vega', 'vidaa', 'titanos'])(
  'admits a production %s page',
  (platform) => {
    expect(
      ReleaseHealthRecordSchema.safeParse({
        ...webStart,
        exposure: { ...webStart.exposure, platform },
      }).success,
    ).toBe(true);
  },
);
it.each(['onerror', 'unhandledrejection'])(
  'admits independent %s failure after a completion',
  (mechanism) => {
    const common = { ...webStart, capturedAt: '2026-10-13T12:00:01.000Z', elapsedMs: 1000 };
    expect(
      ReleaseHealthRecordSchema.safeParse({
        ...common,
        phase: 'end',
        sequence: 1,
        outcome: 'completed',
        endReason: 'pagehide',
      }).success,
    ).toBe(true);
    expect(
      ReleaseHealthRecordSchema.safeParse({
        ...common,
        phase: 'failure',
        sequence: 2,
        outcome: 'crashed',
        mechanism,
      }).success,
    ).toBe(true);
  },
);
it.each([
  { exposure: { ...webStart.exposure, app: { ...webStart.exposure.app, debug: true } } },
  { exposure: { ...webStart.exposure, processLaunchId: webStart.exposure.pageLaunchId } },
  { exposure: { ...webStart.exposure, platform: 'android' } },
  { exposure: { ...webStart.exposure, platform: 'tvos' } },
  { schemaVersion: 5 },
  { sequence: 1 },
  { phase: 'failure', sequence: 2, outcome: 'crashed', mechanism: 'captureException' },
  { phase: 'end', sequence: 1, outcome: 'completed', endReason: 'background' },
  { capturedAt: '2026-10-12T12:00:00.000Z' },
])('rejects incompatible web fields %j', (patch) => {
  expect(ReleaseHealthRecordSchema.safeParse({ ...webStart, ...patch }).success).toBe(false);
});
it('can correlate a failure with its detailed report without requiring delivery of that report', () => {
  expect(
    ReleaseHealthRecordSchema.safeParse({
      ...webStart,
      phase: 'failure',
      sequence: 2,
      outcome: 'crashed',
      mechanism: 'onerror',
      reportId: '55555555-5555-4555-8555-555555555555',
    }).success,
  ).toBe(true);
});
