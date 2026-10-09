// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { ReleaseHealthRecordSchema } from '../src/index.js';
const exposure = {
  exposureId: '11111111-1111-4111-8111-111111111111', pageLaunchId: '22222222-2222-4222-8222-222222222222',
  startedAt: '2026-10-07T12:00:00.000Z', platform: 'web', sdkVersion: '1.0.0',
  nativeRelease: 'not_applicable', loadedBuildId: 'executed-build-a', subject: 'anonymous_exposure',
  coverage: { policy: 'web-page-v1', sampleRate: 1, priorQueueLosses: 0 },
};
const start = () => ({ schemaVersion: 1, recordId: '33333333-3333-4333-8333-333333333333',
  exposure: structuredClone(exposure), phase: 'start', sequence: 0, capturedAt: exposure.startedAt, elapsedMs: 0 });
const end = () => ({ ...start(), phase: 'end', sequence: 1, capturedAt: '2026-10-07T12:01:00.000Z', elapsedMs: 60_000, endReason: 'sdk_stop' });
describe('release exposure record', () => {
  it('accepts explicit observations with frozen anonymous ownership', () => {
    expect(ReleaseHealthRecordSchema.parse(start())).toEqual(start());
    expect(ReleaseHealthRecordSchema.parse(end())).toEqual(end());
  });
  it('preserves unknown build and elapsed time when wall clock rolls backwards', () => {
    const record = { ...end(), capturedAt: '2026-10-07T11:59:00.000Z', exposure: { ...exposure, loadedBuildId: null } };
    expect(ReleaseHealthRecordSchema.parse(record)).toEqual(record);
  });
  it.each([{ sequence: 1 }, { elapsedMs: 1 }, { capturedAt: '2026-10-07T12:00:01.000Z' },
    { endReason: 'sdk_stop' }, { outcome: 'healthy' }, { fatal: false }, { schemaVersion: 2 },
    { recordId: 'not-a-uuid' }, { capturedAt: 'yesterday' }])('rejects malformed start or invented outcomes %j', patch => {
    expect(ReleaseHealthRecordSchema.safeParse({ ...start(), ...patch }).success).toBe(false);
  });
  it.each([{ sequence: 0 }, { endReason: undefined }, { endReason: 'healthy' }, { elapsedMs: -1 },
    { elapsedMs: 0.1 }, { elapsedMs: 32 * 86_400_000 }])('rejects malformed end %j', patch => {
    expect(ReleaseHealthRecordSchema.safeParse({ ...end(), ...patch }).success).toBe(false);
  });
  it.each([{ subject: 'verified_user' }, { userId: 'person' }, { platform: 'android' },
    { nativeRelease: 'version-label' }, { loadedBuildId: '' }, { loadedBuildId: 'x'.repeat(201) },
    { loadedBuildId: 'bad\u0000id' }, { sdkVersion: '' }, { sdkVersion: 'x'.repeat(65) },
    { coverage: { policy: 'web-page-v1', sampleRate: 0.5, priorQueueLosses: 0 } },
    { coverage: { policy: 'web-page-v1', sampleRate: 1, priorQueueLosses: -1 } }])('rejects unsupported or unsafe identity %j', patch => {
    expect(ReleaseHealthRecordSchema.safeParse({ ...start(), exposure: { ...exposure, ...patch } }).success).toBe(false);
  });
  it('keeps the parsed web key order that stored record digests were computed over', () => {
    // Receivers digest JSON.stringify(parsed); a reordered shape turns exact replays into conflicts.
    expect(JSON.stringify(ReleaseHealthRecordSchema.parse(end()).exposure)).toBe(JSON.stringify(exposure));
    expect(Object.keys(ReleaseHealthRecordSchema.parse(start())))
      .toEqual(['schemaVersion', 'recordId', 'exposure', 'capturedAt', 'phase', 'sequence', 'elapsedMs']);
  });
});

const androidExposure = () => ({
  exposureId: '11111111-1111-4111-8111-111111111111', processLaunchId: '22222222-2222-4222-8222-222222222222',
  startedAt: '2026-10-07T12:00:00.000Z', platform: 'android', sdkVersion: '1.0.0',
  nativeRelease: { buildId: 'native-artifact-a' }, loadedBuildId: null, loadedBundleStatus: 'not_applicable',
  subject: 'anonymous_exposure', coverage: { policy: 'android-sdk-segment-v1', sampleRate: 1,
    priorQueueLosses: null, queueLossAccounting: 'unavailable' },
});
const androidStart = () => ({ ...start(), exposure: androidExposure() });
describe('Android release exposure segments', () => {
  it('accepts explicit native identity and truthful unavailable loss accounting', () => {
    expect(ReleaseHealthRecordSchema.parse(androidStart())).toEqual(androidStart());
  });
  it('accepts the actually loaded bundle or explicitly unknown bundle identity', () => {
    for (const patch of [{ loadedBundleStatus: 'known', loadedBuildId: 'bundle-a' },
      { loadedBundleStatus: 'unknown', loadedBuildId: null }]) {
      const value = { ...androidStart(), exposure: { ...androidExposure(), ...patch } };
      expect(ReleaseHealthRecordSchema.parse(value)).toEqual(value);
    }
  });
  it('accepts an explicit stop boundary without claiming process health', () => {
    const value = { ...end(), exposure: androidExposure() };
    expect(ReleaseHealthRecordSchema.parse(value)).toEqual(value);
  });
  it.each([
    { pageLaunchId: exposure.pageLaunchId }, { processLaunchId: undefined },
    { nativeRelease: { buildId: '' } }, { nativeRelease: { buildId: 'x'.repeat(201) } },
    { nativeRelease: 'not_applicable' }, { loadedBundleStatus: 'known', loadedBuildId: null },
    { loadedBundleStatus: 'unknown', loadedBuildId: 'downloaded-only' },
    { loadedBundleStatus: 'not_applicable', loadedBuildId: 'bundle-a' },
    { coverage: { policy: 'android-sdk-segment-v1', sampleRate: 1, priorQueueLosses: 0, queueLossAccounting: 'unavailable' } },
    { userId: 'person' },
  ])('rejects invented or contradictory native identity %j', patch => {
    expect(ReleaseHealthRecordSchema.safeParse({ ...androidStart(), exposure: { ...androidExposure(), ...patch } }).success).toBe(false);
  });
  it('does not accept a web page boundary for a native SDK segment', () => {
    expect(ReleaseHealthRecordSchema.safeParse({ ...end(), exposure: androidExposure(), endReason: 'page_hide' }).success).toBe(false);
  });
});


describe('iOS release exposure segments', () => {
  const ios = () => ({ ...androidStart(), exposure: { ...androidExposure(), platform: 'ios',
    coverage: { ...androidExposure().coverage, policy: 'ios-sdk-segment-v1' } } });
  it('accepts a durable anonymous iOS start and explicit stop', () => {
    expect(ReleaseHealthRecordSchema.parse(ios())).toEqual(ios());
    const value = { ...end(), exposure: ios().exposure };
    expect(ReleaseHealthRecordSchema.parse(value)).toEqual(value);
  });
  it.each([{ loadedBundleStatus: 'known', loadedBuildId: null },
    { loadedBundleStatus: 'unknown', loadedBuildId: 'downloaded-not-loaded' },
    { nativeRelease: 'not_applicable' }, { processLaunchId: undefined },
    { startedAt: '2026-10-07T12:00:00Z' }, { userId: 'person' }])('rejects invalid iOS identity %j', patch => {
    expect(ReleaseHealthRecordSchema.safeParse({ ...ios(), exposure: { ...ios().exposure, ...patch } }).success).toBe(false);
  });
  it('rejects page-hide as a native boundary', () => {
    expect(ReleaseHealthRecordSchema.safeParse({ ...end(), exposure: ios().exposure, endReason: 'page_hide' }).success).toBe(false);
  });
});

describe('version 2 launch sessions', () => {
  const native = (platform: 'android' | 'ios') => ({ ...androidExposure(), platform,
    coverage: { ...androidExposure().coverage, policy: `${platform}-sdk-segment-v1` } });
  const v2 = (platform: 'web' | 'android' | 'ios', subject: unknown = { kind: 'anonymous' }) => ({
    ...start(), schemaVersion: 2,
    exposure: { ...(platform === 'web' ? exposure : native(platform)), sessionPolicy: 'launch-v1', subject },
  });
  it.each(['web', 'android', 'ios'] as const)('accepts explicit %s launch policy with anonymous or supplied subjects', platform => {
    for (const subject of [{ kind: 'anonymous' }, { kind: 'provided', id: 'opaque-account-17' }, { kind: 'provided', id: 'x'.repeat(128) }]) {
      const record = v2(platform, subject);
      expect(ReleaseHealthRecordSchema.parse(record)).toEqual(record);
      const stopped = { ...record, phase: 'end', sequence: 1, elapsedMs: 123, endReason: 'sdk_stop' };
      expect(ReleaseHealthRecordSchema.parse(stopped)).toEqual(stopped);
    }
  });
  it.each(['', ' ', 'x'.repeat(129), 'id\u0000', 'id\u001f', '\ud800', '\ufeff', ' \ufeff\u00a0'])('rejects unsafe supplied identity %j', id => {
    expect(ReleaseHealthRecordSchema.safeParse(v2('android', { kind: 'provided', id })).success).toBe(false);
  });
  it.each(['anonymous_exposure', { kind: 'verified', id: 'a' }, { kind: 'provided' }, { kind: 'anonymous', id: 'a' },
    { kind: 'provided', id: 'a', email: 'a@example.test' }])('rejects unsupported subject %j', subject => {
    expect(ReleaseHealthRecordSchema.safeParse(v2('ios', subject)).success).toBe(false);
  });
  it('rejects version/policy mismatches without changing v1 records', () => {
    const record = v2('web');
    expect(ReleaseHealthRecordSchema.safeParse({ ...record, schemaVersion: 1 }).success).toBe(false);
    expect(ReleaseHealthRecordSchema.safeParse({ ...start(), schemaVersion: 2 }).success).toBe(false);
    expect(ReleaseHealthRecordSchema.safeParse({ ...record, exposure: { ...record.exposure, sessionPolicy: 'foreground' } }).success).toBe(false);
    expect(ReleaseHealthRecordSchema.parse(start())).toEqual(start());
  });
});
