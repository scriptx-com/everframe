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
});
