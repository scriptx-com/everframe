// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { ReleaseHealthRecordSchema, ReleaseHealthPlatformSchema } from '../src/index.js';

const startedAt = '2026-10-13T12:00:00.000Z';
const exposure = {
  exposureId: '11111111-1111-4111-8111-111111111111',
  processLaunchId: '22222222-2222-4222-8222-222222222222',
  startedAt,
  platform: 'roku',
  sdkVersion: '1.0.1',
  app: { version: '1.2.3', build: '3', debug: false },
  loadedBuildId: null,
  loadedBundleStatus: 'not_applicable',
  subject: { kind: 'anonymous' },
  sessionPolicy: 'launch-v1',
  coverage: {
    policy: 'roku-exit-info-v1',
    sampleRate: 1,
    priorQueueLosses: null,
    queueLossAccounting: 'unavailable',
  },
};
const base = { schemaVersion: 7, recordId: '33333333-3333-4333-8333-333333333333', exposure };
const start = { ...base, capturedAt: startedAt, phase: 'start', sequence: 0, elapsedMs: 0 };
const end = {
  ...base,
  capturedAt: '2026-10-13T12:05:00.000Z',
  phase: 'end',
  sequence: 1,
  elapsedMs: 300000,
  outcome: 'completed',
  endReason: 'user_navigation',
};
const exit = {
  ...base,
  capturedAt: end.capturedAt,
  phase: 'exit',
  sequence: 2,
  elapsedMs: end.elapsedMs,
  outcome: 'terminated',
  exitCode: 'EXIT_BRIGHTSCRIPT_CRASH',
};

describe('Roku release health', () => {
  it('admits Roku as a release-health platform', () => {
    expect(ReleaseHealthPlatformSchema.safeParse('roku').success).toBe(true);
  });
  it.each([start, end, exit])('accepts the $phase launch observation', (record) => {
    expect(ReleaseHealthRecordSchema.parse(record)).toEqual(record);
  });
  it.each([
    'EXIT_NATIVE_CRASH',
    'EXIT_OUT_OF_MEMORY',
    'EXIT_SYSTEM_KILL',
    'EXIT_UNKNOWN',
    'EXIT_BRIGHTSCRIPT_TIMEOUT',
  ])('preserves %s as an exit without claiming it crashed', (exitCode) => {
    expect(ReleaseHealthRecordSchema.parse({ ...exit, exitCode })).toEqual({ ...exit, exitCode });
  });
  it('allows an optional detailed report link', () => {
    const record = { ...exit, reportId: base.recordId };
    expect(ReleaseHealthRecordSchema.parse(record)).toEqual(record);
  });
  it.each([
    { ...start, schemaVersion: 5 },
    { ...start, schemaVersion: 6 },
    { ...start, exposure: { ...exposure, platform: 'ios' } },
    { ...start, exposure: { ...exposure, sessionPolicy: 'foreground-v1' } },
    {
      ...start,
      exposure: { ...exposure, coverage: { ...exposure.coverage, policy: 'vega-js-segment-v1' } },
    },
    { ...start, exposure: { ...exposure, app: { ...exposure.app, debug: true } } },
    { ...start, exposure: { ...exposure, subject: { kind: 'provided', id: 'viewer' } } },
    { ...start, exposure: { ...exposure, loadedBundleStatus: 'unknown' } },
    { ...start, capturedAt: end.capturedAt },
    { ...end, endReason: 'background' },
    { ...exit, outcome: 'crashed' },
    { ...exit, exitCode: 'EXIT_USER_NAV' },
    { ...exit, exitCode: 'EXIT_NEW_UNKNOWN_CODE' },
    { ...exit, capturedAt: '2026-10-13T11:59:59.000Z' },
    { ...exit, reportId: 'invalid' },
  ])('rejects an incompatible or unproven observation %#', (record) => {
    expect(ReleaseHealthRecordSchema.safeParse(record).success).toBe(false);
  });
});
