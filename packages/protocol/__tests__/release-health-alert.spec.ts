// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { ReleaseHealthThresholdEventSchema } from '../src/index.js';
const id = '28c4a9ef-855f-47fc-a903-f4dc7dbe424a';
const event = () => ({ id, type: 'release_health.threshold_reached', schemaVersion: '1.2', createdAt: '2026-10-09T00:00:00.000Z',
  data: { appId: id, projectId: id, ruleId: id,
    cohort: { platform: 'android', nativeBuildId: 'release-42', loadedBundleStatus: 'not_applicable', loadedBuildId: null },
    window: { days: 7, from: '2026-10-02T00:00:00.000Z', to: '2026-10-09T00:00:00.000Z' },
    observedAt: '2026-10-09T00:00:00.000Z', thresholds: { minObservedSessions: 20, minFatalSessions: 3 },
    counts: { observedSessions: 21, fatalSessions: 3, noQualifiedExitSessions: 18 },
    coverage: { status: 'incomplete', metric: 'reported_fatal_sessions' } } });
describe('release-health threshold webhook', () => {
  it.each(['android', 'ios'])('accepts explicit native counts for %s', platform => {
    const value = event(); value.data.cohort.platform = platform;
    expect(ReleaseHealthThresholdEventSchema.parse(value)).toEqual(value);
  });
  it('accepts a known OTA cohort over30days', () => {
    const value: any = event(); value.data.cohort.loadedBundleStatus = 'known'; value.data.cohort.loadedBuildId = 'ota';
    value.data.window.days = 30; value.data.window.from = '2026-09-09T00:00:00.000Z';
    expect(ReleaseHealthThresholdEventSchema.safeParse(value).success).toBe(true);
  });
  it.each([
    (v: any) => v.data.userId = 'person', (v: any) => v.data.report = {}, (v: any) => v.data.coverage.status = 'complete',
    (v: any) => v.data.cohort.platform = 'web', (v: any) => v.data.cohort.loadedBundleStatus = 'unknown',
    (v: any) => v.data.cohort.loadedBuildId = 'wrong', (v: any) => v.data.cohort.nativeBuildId = ' ',
    (v: any) => v.data.counts.fatalSessions = 22, (v: any) => v.data.counts.fatalSessions = -1,
    (v: any) => v.data.counts.observedSessions = 21.5, (v: any) => v.data.counts.noQualifiedExitSessions = 22,
    (v: any) => v.data.thresholds.minObservedSessions = 19, (v: any) => v.data.thresholds.minFatalSessions = 2,
    (v: any) => v.data.window.days = 8, (v: any) => v.data.window.from = v.data.window.to,
    (v: any) => v.data.observedAt = 'invalid', (v: any) => v.data.observedAt = '2026-10-08T00:00:00.000Z',
    (v: any) => v.data.counts.fatalSessions = 2,
  ])('rejects malformed or overstated claims %#', change => {
    const value = event(); change(value); expect(ReleaseHealthThresholdEventSchema.safeParse(value).success).toBe(false);
  });
  it.each([
    (v: any) => v.schemaVersion = '1.3', (v: any) => v.deliveredAt = v.createdAt,
    (v: any) => v.data.counts.conflictingSessions = 0, (v: any) => v.data.window.timeZone = 'UTC',
  ])('stays the exact 1.2 producer shape, not a receiver filter for later 1.x additions %#', change => {
    const value = event(); change(value); expect(ReleaseHealthThresholdEventSchema.safeParse(value).success).toBe(false);
  });
});
