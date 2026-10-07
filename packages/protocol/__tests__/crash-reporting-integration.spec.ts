// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as protocol from '../src/index.js';
const id = '11111111-1111-4111-8111-111111111111';
const diagnostic = () => ({
  version: 1, evidenceId: id, processLaunchId: '22222222-2222-4222-8222-222222222222',
  kind: 'process_exit', provenance: 'android_application_exit_info', scope: 'os_process',
  outcome: 'terminated', cause: 'native_crash',
  occurredAt: '2026-10-07T10:00:00.000Z', collectedAt: '2026-10-07T10:01:00.000Z',
  attribution: { process: 'exact_os_token', release: 'frozen', session: 'unavailable', webExposure: 'unavailable' },
  android: { apiLevel: 31, reason: 5, pid: 100 },
  trace: { status: 'unavailable', format: 'none', truncated: false, frames: [] },
});
const crash = () => {
  const value = JSON.parse(readFileSync(new URL('./fixtures/crash-report.json', import.meta.url), 'utf8'));
  value.reportId = id; value.sdk.name = 'everframe-android'; value.sdk.platform = 'android';
  value.source = 'crash'; value.submittedAt = diagnostic().collectedAt;
  Object.assign(value.payload.crash, { fatal: true, handled: false, mechanism: 'android-exit-info' });
  value.payload.diagnostic = diagnostic(); value.attachments = [];
  delete value.sessionId; delete value.reporter.user;
  return value;
};
const health = () => ({ schemaVersion: 1, recordId: '33333333-3333-4333-8333-333333333333', phase: 'start', sequence: 0,
  capturedAt: '2026-10-07T12:00:00.000Z', elapsedMs: 0,
  exposure: { exposureId: id, pageLaunchId: '22222222-2222-4222-8222-222222222222',
    startedAt: '2026-10-07T12:00:00.000Z', platform: 'web', sdkVersion: '1.0.0', nativeRelease: 'not_applicable',
    loadedBuildId: 'executed-build-a', subject: 'anonymous_exposure', coverage: { policy: 'web-page-v1', sampleRate: 1, priorQueueLosses: 0 } },
});
describe('combined crash, symbol and exposure contracts', () => {
  it('keeps one fatal native crash with its diagnostic sidecar and accepts its ELF artifact contract', () => {
    const parsed = protocol.ReportEnvelope.parse(crash());
    expect(parsed.payload.diagnostic).toEqual(diagnostic());
    expect(parsed.source).toBe('crash'); expect(parsed.reportId).toBe(id);
    const nonfatal = crash(); nonfatal.payload.crash.fatal = false;
    expect(protocol.ReportEnvelope.safeParse(nonfatal).success).toBe(false);
    const digest = 'a'.repeat(64);
    expect(protocol.parseManifest({ version: 5, runtime: 'android-native', platform: 'android', buildId: 'elf:' + digest,
      artifacts: [{ url: 'elf://android/library', mapSha256: digest, mapBytes: 1024 }] }).version).toBe(5);
  });
  it('accepts independent anonymous web exposure without inventing a healthy outcome', () => {
    expect(protocol.ReleaseHealthRecordSchema.parse(health())).toEqual(health());
    expect(protocol.ReleaseHealthRecordSchema.safeParse({ ...health(), outcome: 'healthy' }).success).toBe(false);
  });
  it('does not turn ANR evidence into a fatal native crash or health record', () => {
    const value = crash(); value.source = 'diagnostic'; delete value.payload.crash;
    value.payload.diagnostic.cause = 'anr'; value.payload.diagnostic.android.reason = 6;
    expect(protocol.ReportEnvelope.parse(value).source).toBe('diagnostic');
    expect(protocol.ReleaseHealthRecordSchema.safeParse(value).success).toBe(false);
    value.payload.crash = crash().payload.crash;
    expect(protocol.ReportEnvelope.safeParse(value).success).toBe(false);
  });
});
