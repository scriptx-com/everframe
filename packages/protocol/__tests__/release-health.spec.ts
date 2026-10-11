// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import * as protocol from '../src/index.js';
import {
  NativeExposurePointerSchema, RELEASE_HEALTH_APP_TEXT_MAX, RELEASE_HEALTH_SCHEMA_VERSION, ReleaseHealthAppSchema,
  ReleaseHealthRecordSchema,
} from '../src/index.js';

const startedAt = '2026-10-07T12:00:00.000Z';
const exposure = (platform: 'android' | 'ios' = 'android') => ({
  exposureId: '11111111-1111-4111-8111-111111111111', processLaunchId: '22222222-2222-4222-8222-222222222222',
  startedAt, platform, sdkVersion: '1.0.0', app: { version: '2.4.0', build: '412' },
  loadedBuildId: null, loadedBundleStatus: 'not_applicable', subject: { kind: 'anonymous' },
  sessionPolicy: 'foreground-v1',
  coverage: { policy: `${platform}-sdk-segment-v1`, sampleRate: 1, priorQueueLosses: null, queueLossAccounting: 'unavailable' },
});
const start = (value: object = exposure()) => ({ schemaVersion: 4, recordId: '33333333-3333-4333-8333-333333333333',
  exposure: value, capturedAt: startedAt, phase: 'start', sequence: 0, elapsedMs: 0 });
const end = (value: object = exposure()) => ({ schemaVersion: 4, recordId: '44444444-4444-4444-8444-444444444444',
  exposure: value, capturedAt: '2026-10-07T12:05:00.000Z', phase: 'end', sequence: 1, outcome: 'completed',
  elapsedMs: 300_000, endReason: 'background' });
/** The same object with its keys in reverse order, to prove output order comes from the schema. */
const reversed = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).reverse()) as T;

describe('release-health records, version 4', () => {
  it('names the only record version and the app text limit', () => {
    expect(RELEASE_HEALTH_SCHEMA_VERSION).toBe(4);
    expect(RELEASE_HEALTH_APP_TEXT_MAX).toBe(64);
  });

  it('accepts an Android start and its completed background end', () => {
    expect(ReleaseHealthRecordSchema.parse(start())).toEqual(start());
    expect(ReleaseHealthRecordSchema.parse(end())).toEqual(end());
  });

  it('accepts an iOS start with a provided subject and an iOS end at an SDK stop', () => {
    const value = start({ ...exposure('ios'), subject: { kind: 'provided', id: 'opaque-account-17' } });
    expect(ReleaseHealthRecordSchema.parse(value)).toEqual(value);
    const stopped = { ...end(exposure('ios')), endReason: 'sdk_stop' };
    expect(ReleaseHealthRecordSchema.parse(stopped)).toEqual(stopped);
  });

  it.each([
    { version: '2.4.0', build: null },
    { version: 'v'.repeat(64), build: 'b'.repeat(64) },
    { version: '2.4.0+42', build: '1.0 (beta)/rc' },
    { version: '2.0-β', build: null },
    // Decision 1 rejects only unpaired surrogates: 32 emoji are 64 UTF-16 units of well-formed pairs.
    { version: '\u{1F600}'.repeat(32), build: '\u{1F680}' },
  ])('accepts app %j', app => {
    const value = start({ ...exposure(), app });
    expect(ReleaseHealthRecordSchema.parse(value)).toEqual(value);
  });

  it('accepts a known loaded bundle with its build ID', () => {
    const value = start({ ...exposure(), loadedBundleStatus: 'known', loadedBuildId: 'ota-build-42' });
    expect(ReleaseHealthRecordSchema.parse(value)).toEqual(value);
  });

  it('parses in the key order receivers digest', () => {
    const parsed = ReleaseHealthRecordSchema.parse(reversed({
      ...end(), exposure: reversed({ ...exposure(), app: reversed({ version: '2.4.0', build: '412' }) }),
    }));
    expect(Object.keys(parsed)).toEqual(
      ['schemaVersion', 'recordId', 'exposure', 'capturedAt', 'phase', 'sequence', 'outcome', 'elapsedMs', 'endReason']);
    expect(Object.keys(parsed.exposure)).toEqual(['exposureId', 'processLaunchId', 'startedAt', 'platform', 'sdkVersion',
      'app', 'loadedBuildId', 'loadedBundleStatus', 'subject', 'sessionPolicy', 'coverage']);
    expect(Object.keys(parsed.exposure.app)).toEqual(['version', 'build']);
  });

  const { app: _app, ...withoutApp } = exposure();
  it.each([
    ['schemaVersion 3', () => ({ ...start(), schemaVersion: 3 })],
    ['the web platform', () => start({ ...exposure(), platform: 'web' })],
    ['a missing app', () => start(withoutApp)],
    ['an empty version', () => start({ ...exposure(), app: { version: '', build: '412' } })],
    ['a blank version', () => start({ ...exposure(), app: { version: '   ', build: '412' } })],
    ['a 65-unit version', () => start({ ...exposure(), app: { version: 'a'.repeat(65), build: '412' } })],
    ['a version with U+0000', () => start({ ...exposure(), app: { version: '2.4.0\u0000', build: '412' } })],
    ['a version with a lone high surrogate', () => start({ ...exposure(), app: { version: '2.4.0\ud83d', build: '412' } })],
    ['a version with a lone low surrogate', () => start({ ...exposure(), app: { version: '\ude002.4.0', build: '412' } })],
    ['33 emoji (66 UTF-16 units)', () => start({ ...exposure(), app: { version: '\u{1F600}'.repeat(33), build: '412' } })],
    ['an empty build', () => start({ ...exposure(), app: { version: '2.4.0', build: '' } })],
    ['a 65-unit build', () => start({ ...exposure(), app: { version: '2.4.0', build: 'b'.repeat(65) } })],
    ['an app without build', () => start({ ...exposure(), app: { version: '2.4.0' } })],
    ['an app with an extra name', () => start({ ...exposure(), app: { version: '2.4.0', build: '412', name: 'Shop' } })],
    ['an extra nativeRelease', () => start({ ...exposure(), nativeRelease: { buildId: 'native-a' } })],
    ['the launch-v1 policy', () => start({ ...exposure(), sessionPolicy: 'launch-v1' })],
    ['an iOS segment with the Android coverage policy', () => start({ ...exposure('ios'), coverage: exposure('android').coverage })],
    ['a start captured after its frozen start time', () => ({ ...start(), capturedAt: '2026-10-07T12:00:01.000Z' })],
    ['an end captured before its start', () => ({ ...end(), capturedAt: '2026-10-07T11:59:59.000Z' })],
    ['a known bundle without its build ID', () => start({ ...exposure(), loadedBundleStatus: 'known', loadedBuildId: null })],
  ] as const)('rejects %s', (_name, value) => {
    expect(ReleaseHealthRecordSchema.safeParse(value()).success).toBe(false);
  });
});

describe('native exposure pointer', () => {
  const pointer = () => ({ exposureId: '11111111-1111-4111-8111-111111111111',
    processLaunchId: '22222222-2222-4222-8222-222222222222', startedAt,
    app: { version: '2.4.0', build: null }, loadedBuildId: null, loadedBundleStatus: 'not_applicable' });

  it('keeps an explicit null build, in wire key order', () => {
    const parsed = NativeExposurePointerSchema.parse(reversed(pointer()));
    expect(parsed).toEqual(pointer());
    expect(Object.keys(parsed)).toEqual(['exposureId', 'processLaunchId', 'startedAt', 'app', 'loadedBuildId', 'loadedBundleStatus']);
    expect(Object.keys(parsed.app)).toEqual(['version', 'build']);
  });

  it('rejects an app that omits build', () => {
    expect(NativeExposurePointerSchema.safeParse({ ...pointer(), app: { version: '2.4.0' } }).success).toBe(false);
  });

  it('rejects the retired nativeBuildId, with or without app', () => {
    expect(NativeExposurePointerSchema.safeParse({ ...pointer(), nativeBuildId: 'native-a' }).success).toBe(false);
    const { app: _pointerApp, ...rest } = pointer();
    expect(NativeExposurePointerSchema.safeParse({ ...rest, nativeBuildId: 'native-a' }).success).toBe(false);
  });

  it('shares its app schema with the records', () => {
    expect(ReleaseHealthAppSchema.parse({ version: '2.4.0', build: null })).toEqual({ version: '2.4.0', build: null });
    expect(ReleaseHealthAppSchema.safeParse({ version: '2.4.0' }).success).toBe(false);
  });
});

describe('retired release-health exports', () => {
  it.each([
    'ReleaseHealthRecordV1Schema', 'ReleaseHealthRecordV3Schema', 'WebReleaseHealthExposureSchema',
    'ReleaseHealthAlertCohortSchema', 'ReleaseHealthRateThresholdEventSchema',
  ])('%s is gone', name => {
    expect(name in protocol).toBe(false);
  });
});
