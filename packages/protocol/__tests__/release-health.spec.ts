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
  startedAt, platform, sdkVersion: '1.0.0', app: { version: '2.4.0', build: '412', debug: false },
  loadedBuildId: null, loadedBundleStatus: 'not_applicable', subject: { kind: 'anonymous' },
  sessionPolicy: 'foreground-v1',
  coverage: { policy: `${platform}-sdk-segment-v1`, sampleRate: 1, priorQueueLosses: null, queueLossAccounting: 'unavailable' },
});
const start = (value: object = exposure()) => ({ schemaVersion: 5, recordId: '33333333-3333-4333-8333-333333333333',
  exposure: value, capturedAt: startedAt, phase: 'start', sequence: 0, elapsedMs: 0 });
const end = (value: object = exposure()) => ({ schemaVersion: 5, recordId: '44444444-4444-4444-8444-444444444444',
  exposure: value, capturedAt: '2026-10-07T12:05:00.000Z', phase: 'end', sequence: 1, outcome: 'completed',
  elapsedMs: 300_000, endReason: 'background' });
/** The same object with its keys in reverse order, to prove output order comes from the schema. */
const reversed = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).reverse()) as T;

describe('release-health records, version 5', () => {
  it('names the only record version and the app text limit', () => {
    expect(RELEASE_HEALTH_SCHEMA_VERSION).toBe(5);
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
    { version: '2.4.0', build: null, debug: false },
    { version: '2.4.0', build: '412', debug: true },
    { version: 'v'.repeat(64), build: 'b'.repeat(64), debug: false },
    { version: '2.4.0+42', build: '1.0 (beta)/rc', debug: false },
    { version: '2.0-β', build: null, debug: false },
    // The version rule rejects only unpaired surrogates: 32 emoji are 64 UTF-16 units of well-formed pairs.
    { version: '\u{1F600}'.repeat(32), build: '\u{1F680}', debug: false },
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
      ...end(), exposure: reversed({ ...exposure(), app: reversed({ version: '2.4.0', build: '412', debug: false }) }),
    }));
    expect(Object.keys(parsed)).toEqual(
      ['schemaVersion', 'recordId', 'exposure', 'capturedAt', 'phase', 'sequence', 'outcome', 'elapsedMs', 'endReason']);
    expect(Object.keys(parsed.exposure)).toEqual(['exposureId', 'processLaunchId', 'startedAt', 'platform', 'sdkVersion',
      'app', 'loadedBuildId', 'loadedBundleStatus', 'subject', 'sessionPolicy', 'coverage']);
    expect(Object.keys(parsed.exposure.app)).toEqual(['version', 'build', 'debug']);
  });

  const { app: _app, ...withoutApp } = exposure();
  it.each([
    ['schemaVersion 4', () => ({ ...start(), schemaVersion: 4 })],
    ['the web platform', () => start({ ...exposure(), platform: 'web' })],
    ['a missing app', () => start(withoutApp)],
    ['an empty version', () => start({ ...exposure(), app: { version: '', build: '412', debug: false } })],
    ['a blank version', () => start({ ...exposure(), app: { version: '   ', build: '412', debug: false } })],
    ['a 65-unit version', () => start({ ...exposure(), app: { version: 'a'.repeat(65), build: '412', debug: false } })],
    ['a version with U+0000', () => start({ ...exposure(), app: { version: '2.4.0\u0000', build: '412', debug: false } })],
    ['a version with a lone high surrogate', () => start({ ...exposure(), app: { version: '2.4.0\ud83d', build: '412', debug: false } })],
    ['a version with a lone low surrogate', () => start({ ...exposure(), app: { version: '\ude002.4.0', build: '412', debug: false } })],
    ['33 emoji (66 UTF-16 units)', () => start({ ...exposure(), app: { version: '\u{1F600}'.repeat(33), build: '412', debug: false } })],
    ['an empty build', () => start({ ...exposure(), app: { version: '2.4.0', build: '', debug: false } })],
    ['a 65-unit build', () => start({ ...exposure(), app: { version: '2.4.0', build: 'b'.repeat(65), debug: false } })],
    ['an app without build', () => start({ ...exposure(), app: { version: '2.4.0', debug: false } })],
    ['an app without debug', () => start({ ...exposure(), app: { version: '2.4.0', build: '412' } })],
    ['a non-boolean debug', () => start({ ...exposure(), app: { version: '2.4.0', build: '412', debug: 'no' } })],
    ['an app with an extra name', () => start({ ...exposure(), app: { version: '2.4.0', build: '412', debug: false, name: 'Shop' } })],
    ['an extra nativeRelease', () => start({ ...exposure(), nativeRelease: { buildId: 'native-a' } })],
    ['the launch-v1 policy', () => start({ ...exposure(), sessionPolicy: 'launch-v1' })],
    ['an iOS segment with the Android coverage policy', () => start({ ...exposure('ios'), coverage: exposure('android').coverage })],
    ['a start captured after its frozen start time', () => ({ ...start(), capturedAt: '2026-10-07T12:00:01.000Z' })],
    ['an end captured before its start', () => ({ ...end(), capturedAt: '2026-10-07T11:59:59.000Z' })],
    ['a known bundle without its build ID', () => start({ ...exposure(), loadedBundleStatus: 'known', loadedBuildId: null })],
  ] as const)('rejects %s', (_name, value) => {
    expect(ReleaseHealthRecordSchema.safeParse(value()).success).toBe(false);
  });

  /** One change to a valid start (or end): exposure keys, record keys, and a record key to drop. */
  interface Patch { phase?: 'start' | 'end'; exposure?: Record<string, unknown>; record?: Record<string, unknown>; omit?: string }
  const provided = (id: string) => ({ subject: { kind: 'provided', id } });
  it.each<[string, Patch]>([
    ['a blank subject id', { exposure: provided('   ') }],
    ['a subject id with U+0000', { exposure: provided('id\u0000') }],
    ['a BOM-only subject id', { exposure: provided('\ufeff') }],
    ['a 129-unit subject id', { exposure: provided('x'.repeat(129)) }],
    ['an unknown subject kind', { exposure: { subject: { kind: 'verified', id: 'opaque' } } }],
    ['a provided subject with an extra key', { exposure: { subject: { kind: 'provided', id: 'opaque', email: 'a@example.test' } } }],
    ['an anonymous subject with an id', { exposure: { subject: { kind: 'anonymous', id: 'opaque' } } }],
    ['an end without an outcome', { phase: 'end', omit: 'outcome' }],
    ['an end with a crashed outcome', { phase: 'end', record: { outcome: 'crashed' } }],
    ['an end with elapsedMs -1', { phase: 'end', record: { elapsedMs: -1 } }],
    ['an end with elapsedMs 0.1', { phase: 'end', record: { elapsedMs: 0.1 } }],
    ['an end with elapsedMs of 32 days', { phase: 'end', record: { elapsedMs: 32 * 86_400_000 } }],
    ['an empty sdkVersion', { exposure: { sdkVersion: '' } }],
    ['a 65-unit sdkVersion', { exposure: { sdkVersion: 'x'.repeat(65) } }],
    ['an empty loadedBuildId', { exposure: { loadedBundleStatus: 'known', loadedBuildId: '' } }],
    ['a 201-unit loadedBuildId', { exposure: { loadedBundleStatus: 'known', loadedBuildId: 'x'.repeat(201) } }],
    ['a loadedBuildId with U+0000', { exposure: { loadedBundleStatus: 'known', loadedBuildId: 'bad\u0000id' } }],
    ['an unknown bundle with a build ID', { exposure: { loadedBundleStatus: 'unknown', loadedBuildId: 'downloaded-not-loaded' } }],
    ['a not-applicable bundle with a build ID', { exposure: { loadedBundleStatus: 'not_applicable', loadedBuildId: 'bundle-a' } }],
    ['priorQueueLosses 0', { exposure: { coverage: { ...exposure().coverage, priorQueueLosses: 0 } } }],
    ['a startedAt without milliseconds', { exposure: { startedAt: '2026-10-07T12:00:00Z' }, record: { capturedAt: '2026-10-07T12:00:00Z' } }],
    ['a non-UUID recordId', { record: { recordId: 'not-a-uuid' } }],
    ['an upper-case recordId', { record: { recordId: '33333333-3333-4333-8333-33333333333A' } }],
  ])('rejects %s', (_name, patch) => {
    const build = patch.phase === 'end' ? end : start;
    const value: Record<string, unknown> = { ...build({ ...exposure(), ...patch.exposure }), ...patch.record };
    if (patch.omit) delete value[patch.omit];
    expect(ReleaseHealthRecordSchema.safeParse(value).success).toBe(false);
  });

  it('requires app.debug in v5', () => {
    const record = structuredClone(start()) as { exposure: { app: { debug?: boolean } } };
    delete record.exposure.app.debug;
    expect(ReleaseHealthRecordSchema.safeParse(record).success).toBe(false);
  });

  it('accepts each patched field at its valid edge', () => {
    for (const patch of [provided('x'.repeat(128)), { sdkVersion: 'x'.repeat(64) },
      { loadedBundleStatus: 'known', loadedBuildId: 'x'.repeat(200) }, { loadedBundleStatus: 'unknown', loadedBuildId: null }]) {
      expect(ReleaseHealthRecordSchema.safeParse(start({ ...exposure(), ...patch })).success).toBe(true);
    }
    expect(ReleaseHealthRecordSchema.safeParse({ ...end(), elapsedMs: 31 * 86_400_000 }).success).toBe(true);
  });
});

describe('native exposure pointer', () => {
  const pointer = () => ({ exposureId: '11111111-1111-4111-8111-111111111111',
    processLaunchId: '22222222-2222-4222-8222-222222222222', startedAt,
    app: { version: '2.4.0', build: null, debug: false }, loadedBuildId: null, loadedBundleStatus: 'not_applicable' });

  it('keeps an explicit null build, in wire key order', () => {
    const parsed = NativeExposurePointerSchema.parse(reversed(pointer()));
    expect(parsed).toEqual(pointer());
    expect(Object.keys(parsed)).toEqual(['exposureId', 'processLaunchId', 'startedAt', 'app', 'loadedBuildId', 'loadedBundleStatus']);
    expect(Object.keys(parsed.app)).toEqual(['version', 'build', 'debug']);
  });

  it('rejects an app that omits build', () => {
    expect(NativeExposurePointerSchema.safeParse({ ...pointer(), app: { version: '2.4.0', debug: false } }).success).toBe(false);
  });

  it('rejects an app that omits debug', () => {
    expect(NativeExposurePointerSchema.safeParse({ ...pointer(), app: { version: '2.4.0', build: null } }).success).toBe(false);
  });

  it('rejects the retired nativeBuildId, with or without app', () => {
    expect(NativeExposurePointerSchema.safeParse({ ...pointer(), nativeBuildId: 'native-a' }).success).toBe(false);
    const { app: _pointerApp, ...rest } = pointer();
    expect(NativeExposurePointerSchema.safeParse({ ...rest, nativeBuildId: 'native-a' }).success).toBe(false);
  });

  it('shares its app schema with the records', () => {
    expect(ReleaseHealthAppSchema.parse({ version: '2.4.0', build: null, debug: true }))
      .toEqual({ version: '2.4.0', build: null, debug: true });
    expect(ReleaseHealthAppSchema.safeParse({ version: '2.4.0', debug: false }).success).toBe(false);
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
