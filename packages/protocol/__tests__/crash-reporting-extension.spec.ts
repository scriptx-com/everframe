// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as protocol from '../src/index.js';
const id = '11111111-1111-4111-8111-111111111111';
const processId = '22222222-2222-4222-8222-222222222222';
const start = '2026-10-08T00:00:00.000Z';
const collected = '2026-10-08T00:02:00.000Z';
const pointer = () => ({ exposureId: id, processLaunchId: processId, startedAt: start,
  nativeBuildId: 'release-42', loadedBuildId: null, loadedBundleStatus: 'not_applicable' });
const android = () => ({ version: 1, evidenceId: id, processLaunchId: processId, nativeExposure: pointer(),
  kind: 'process_exit', provenance: 'android_application_exit_info', scope: 'os_process', outcome: 'terminated', cause: 'anr',
  occurredAt: '2026-10-08T00:01:00.000Z', collectedAt: collected,
  attribution: { process: 'exact_os_token', release: 'frozen', session: 'unavailable', webExposure: 'unavailable' },
  android: { apiLevel: 35, reason: 6, pid: 100 }, trace: { status: 'unavailable', format: 'none', truncated: false, frames: [] } });
const apple = () => ({ version: 1, evidenceId: id, ownershipId: processId, kind: 'hang_batch',
  provenance: 'apple_metrickit', scope: 'reporting_interval', outcome: 'unknown',
  interval: { begin: start, end: '2026-10-08T00:01:00.000Z' }, collectedAt: collected,
  attribution: { process: 'unavailable', release: 'frozen', session: 'unavailable', webExposure: 'unavailable' },
  apple: { applicationVersion: '1', applicationBuild: '42', osVersion: 'iOS 18' }, truncated: false,
  hangs: [{ durationMs: 2000, stack: { status: 'unavailable', truncated: false, frames: [] } }] });
function envelope(platform: 'ios' | 'android', payload: Record<string, unknown>) {
  const value = JSON.parse(readFileSync(new URL('./fixtures/crash-report.json', import.meta.url), 'utf8'));
  value.reportId = id; value.submittedAt = collected; value.source = 'diagnostic';
  value.sdk.platform = platform; value.sdk.name = 'everframe-' + platform;
  value.payload = payload; value.attachments = []; delete value.sessionId; delete value.reporter.user;
  return value;
}
describe('combined Apple diagnostics and Android health contracts', () => {
  it('preserves the Android pointer including explicit null without making an ANR a crash', () => {
    const parsed = protocol.ReportEnvelope.parse(envelope('android', { diagnostic: android() }));
    expect(parsed.source).toBe('diagnostic'); expect(parsed.payload).not.toHaveProperty('crash');
    expect(parsed.payload.diagnostic).toEqual(android());
    expect(protocol.ReportEnvelope.safeParse(envelope('android', { diagnostic: {
      ...android(), nativeExposure: { ...pointer(), processLaunchId: id },
    } })).success).toBe(false);
  });
  it('retains Apple interval uncertainty and rejects an invented native exposure or fatal outcome', () => {
    expect(protocol.ReportEnvelope.parse(envelope('ios', { appleDiagnostic: apple() })).payload).toEqual({ appleDiagnostic: apple() });
    for (const extra of [{ nativeExposure: pointer() }, { outcome: 'terminated' }]) {
      expect(protocol.ReportEnvelope.safeParse(envelope('ios', { appleDiagnostic: { ...apple(), ...extra } })).success).toBe(false);
    }
    expect(protocol.ReportEnvelope.safeParse(envelope('ios', { appleDiagnostic: apple(), diagnostic: android() })).success).toBe(false);
  });
  it('accepts native and web observations independently, retaining absent bundle uncertainty', () => {
    const exposure = { ...pointer(), platform: 'android', sdkVersion: '1.0.0', nativeRelease: { buildId: 'release-42' },
      subject: 'anonymous_exposure', coverage: { policy: 'android-sdk-segment-v1', sampleRate: 1, priorQueueLosses: null, queueLossAccounting: 'unavailable' } };
    const { nativeBuildId: _nativeBuildId, ...wire } = exposure;
    const record = { schemaVersion: 1, recordId: processId, phase: 'start', sequence: 0, elapsedMs: 0, capturedAt: start, exposure: wire };
    expect(protocol.ReleaseHealthRecordSchema.parse(record)).toEqual(record);
    expect(protocol.ReleaseHealthRecordSchema.safeParse({ ...record, outcome: 'healthy' }).success).toBe(false);
    expect(protocol.ReleaseHealthRecordSchema.safeParse({ ...record, exposure: { ...wire, loadedBundleStatus: 'known' } }).success).toBe(false);
  });
});
