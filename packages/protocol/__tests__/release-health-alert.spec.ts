// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import {
  RELEASE_HEALTH_ALERT_SCHEMA_VERSION, ReleaseHealthAlertTargetSchema, ReleaseHealthThresholdEventSchema,
  type ReleaseHealthThresholdEvent,
} from '../src/index.js';

/** The hand-computed breach the alerts doc shows: 400 of 408 resolved sessions against a 99% target. */
const event = (): ReleaseHealthThresholdEvent => ({
  id: '28c4a9ef-855f-47fc-a903-f4dc7dbe424a', type: 'release_health.threshold_reached', schemaVersion: '2.0',
  createdAt: '2026-10-09T00:00:05.000Z',
  data: {
    projectId: '6f1c0b52-3d4e-4a8b-9c2d-7e5f6a1b2c3d', ruleId: 'b7e2d9a4-1c3f-4e5a-8b6d-9f0a1b2c3d4e', version: '2.4.0',
    platforms: ['android', 'ios'],
    window: { days: 7, from: '2026-10-02T00:00:00.000Z', to: '2026-10-09T00:00:00.000Z' },
    observedAt: '2026-10-09T00:00:00.000Z',
    target: { basisPoints: 9900, minSessions: 100 },
    sessions: { total: 420, completed: 400, crashed: 8, unknown: 12 },
    crashFreeSessions: 0.9803921568627451,
  },
});
// Mutations write values the strict type forbids; the schema is what must refuse them.
const changed = (change: (value: any) => void): unknown => {
  const value: any = event();
  change(value);
  return value;
};

describe('release_health.threshold_reached 2.0', () => {
  it('accepts web and native platforms in one alert', () => {
    expect(ReleaseHealthThresholdEventSchema.safeParse(changed(v => { v.data.platforms = ['android', 'ios', 'titanos', 'tizen', 'vega', 'vidaa', 'web', 'webos']; })).success).toBe(true);
  });

  it('is event schema 2.0', () => {
    expect(RELEASE_HEALTH_ALERT_SCHEMA_VERSION).toBe('2.0');
  });

  it('accepts the hand-computed breach unchanged', () => {
    expect(event().data.crashFreeSessions).toBe(400 / 408);
    expect(ReleaseHealthThresholdEventSchema.parse(event())).toEqual(event());
    expect(Object.keys(ReleaseHealthThresholdEventSchema.parse(event()).data)).toEqual(['projectId', 'ruleId', 'version',
      'platforms', 'window', 'observedAt', 'target', 'sessions', 'crashFreeSessions']);
  });

  it('accepts a single platform', () => {
    const value = changed(v => { v.data.platforms = ['ios']; });
    expect(ReleaseHealthThresholdEventSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ['a rate exactly at the target', (v: any) => {
      v.data.sessions = { total: 100, completed: 99, crashed: 1, unknown: 0 }; v.data.crashFreeSessions = 0.99;
    }],
    ['99 resolved sessions under minSessions 100', (v: any) => {
      v.data.sessions = { total: 99, completed: 97, crashed: 2, unknown: 0 }; v.data.crashFreeSessions = 97 / 99;
    }],
    ['a rounded crashFreeSessions', (v: any) => { v.data.crashFreeSessions = 0.98; }],
    ['a total that does not add up', (v: any) => { v.data.sessions.total = 421; }],
    ['a 30-day window', (v: any) => {
      v.data.window = { days: 30, from: '2026-09-09T00:00:00.000Z', to: '2026-10-09T00:00:00.000Z' };
    }],
    ['a 7-day window spanning 30 days', (v: any) => { v.data.window.from = '2026-09-09T00:00:00.000Z'; }],
    ['a window that does not end at observedAt', (v: any) => { v.data.observedAt = '2026-10-09T00:00:01.000Z'; }],
    ['platforms out of order', (v: any) => { v.data.platforms = ['ios', 'android']; }],
    ['a repeated platform', (v: any) => { v.data.platforms = ['ios', 'ios']; }],
    ['no platforms', (v: any) => { v.data.platforms = []; }],
    ['an unsupported platform', (v: any) => { v.data.platforms = ['android', 'roku']; }],
    ['schema version 1.2', (v: any) => { v.schemaVersion = '1.2'; }],
    ['an extra cohort', (v: any) => { v.data.cohort = { platform: 'android' }; }],
    ['an extra appId', (v: any) => { v.data.appId = v.data.projectId; }],
    ['target 9995', (v: any) => { v.data.target.basisPoints = 9995; }],
    ['target 4990', (v: any) => { v.data.target.basisPoints = 4990; }],
    ['a blank version', (v: any) => { v.data.version = '   '; }],
    ['a 65-unit version', (v: any) => { v.data.version = 'a'.repeat(65); }],
  ] as const)('rejects %s', (_name, change) => {
    expect(ReleaseHealthThresholdEventSchema.safeParse(changed(change)).success).toBe(false);
  });
});

describe('release-health alert target', () => {
  it.each([{ basisPoints: 5000, minSessions: 20 }, { basisPoints: 9990, minSessions: 1_000_000 }, { basisPoints: 9950, minSessions: 100 }])(
    'accepts %j', target => {
      expect(ReleaseHealthAlertTargetSchema.parse(target)).toEqual(target);
    });

  it.each([
    { basisPoints: 4990, minSessions: 100 }, { basisPoints: 9995, minSessions: 100 }, { basisPoints: 9905, minSessions: 100 },
    { basisPoints: 9900, minSessions: 19 }, { basisPoints: 9900, minSessions: 1_000_001 },
    { basisPoints: 9900, minSessions: 100, metric: 'sessions' },
  ])('rejects %j', target => {
    expect(ReleaseHealthAlertTargetSchema.safeParse(target).success).toBe(false);
  });
});
