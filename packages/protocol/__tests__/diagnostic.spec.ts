// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ReportEnvelope } from '../src/index.js';

const legacy = () => JSON.parse(readFileSync(new URL('./fixtures/crash-report.json', import.meta.url), 'utf8'));
const diagnostic = () => ({
  version: 1, evidenceId: '11111111-1111-4111-8111-111111111111',
  processLaunchId: '22222222-2222-4222-8222-222222222222',
  kind: 'process_exit', provenance: 'android_application_exit_info', scope: 'os_process',
  outcome: 'terminated', cause: 'anr',
  occurredAt: '2026-10-07T10:00:00.000Z', collectedAt: '2026-10-07T10:01:00.000Z',
  attribution: { process: 'exact_os_token', release: 'frozen', session: 'unavailable', webExposure: 'unavailable' },
  android: { apiLevel: 30, reason: 6, pid: 100 },
  trace: { status: 'unavailable', format: 'none', truncated: false, frames: [] },
});
const envelope = () => {
  const value = legacy();
  value.source = 'diagnostic'; value.reportId = diagnostic().evidenceId;
  value.sdk.name = 'everframe-android'; value.sdk.platform = 'android';
  value.submittedAt = diagnostic().collectedAt;
  value.payload = { diagnostic: diagnostic() }; value.attachments = [];
  delete value.sessionId; delete value.reporter.user;
  return value;
};

describe('process-exit evidence', () => {
  it('accepts anonymous OS ANR evidence without inventing a crash', () => {
    expect(ReportEnvelope.parse(envelope()).payload.diagnostic).toEqual(diagnostic());
  });
  it('preserves existing crash envelopes', () => {
    expect(ReportEnvelope.parse(legacy())).toEqual(legacy());
  });
  it.each([
    { reason: 3, cause: 'system_low_memory' }, { reason: 4, cause: 'java_crash' },
    { reason: 10, cause: 'user_requested' }, { reason: 11, cause: 'user_requested' },
    { reason: 1, cause: 'system_other' }, { reason: 2, cause: 'unknown' },
    { reason: 0, cause: 'unknown' }, { reason: 999, cause: 'unknown' },
  ])('retains qualified reason $reason as $cause', ({ reason, cause }) => {
    const value = envelope(); value.payload.diagnostic.android.reason = reason;
    value.payload.diagnostic.cause = cause;
    expect(ReportEnvelope.safeParse(value).success).toBe(true);
    value.payload.diagnostic.cause = 'anr';
    expect(ReportEnvelope.safeParse(value).success).toBe(false);
  });
  it('keeps native overlap on one fatal native crash envelope', () => {
    const value = envelope(); value.source = 'crash'; value.payload.crash = legacy().payload.crash;
    Object.assign(value.payload.crash, { fatal: true, handled: false, mechanism: 'android-exit-info' });
    value.payload.diagnostic.cause = 'native_crash'; value.payload.diagnostic.android.reason = 5;
    expect(ReportEnvelope.safeParse(value).success).toBe(true);
    value.payload.crash.fatal = false;
    expect(ReportEnvelope.safeParse(value).success).toBe(false);
  });
  it.each([
    (v: any) => { delete v.payload.diagnostic; },
    (v: any) => { v.source = 'manual'; },
    (v: any) => { v.source = 'error'; },
    (v: any) => { v.payload.crash = legacy().payload.crash; },
    (v: any) => { v.payload.diagnostic.evidenceId = diagnostic().processLaunchId; },
    (v: any) => { v.payload.diagnostic.outcome = 'recovered'; },
    (v: any) => { v.payload.diagnostic.collectedAt = '2026-10-06T10:00:00Z'; },
    (v: any) => { v.sessionId = diagnostic().processLaunchId; },
    (v: any) => { v.reporter.user = { id: 'current-user' }; },
    (v: any) => { v.sdk.platform = 'web'; },
    (v: any) => { v.payload.diagnostic.trace.frames = [{ function: 'com.example.Main.run' }]; },
    (v: any) => { v.payload.diagnostic.trace.status = 'available'; },
    (v: any) => { v.payload.diagnostic.android.apiLevel = 29; },
  ])('rejects contradictory or falsely attributed evidence %#', mutate => {
    const value = envelope(); mutate(value); expect(ReportEnvelope.safeParse(value).success).toBe(false);
  });
  it('allows only a bounded structured ANR main-thread stack', () => {
    const value = envelope();
    value.payload.diagnostic.trace = { status: 'available', format: 'android_anr_text', truncated: true,
      frames: [{ function: 'com.example.Main.run', file: 'Main.java', line: 42 }] };
    expect(ReportEnvelope.safeParse(value).success).toBe(true);
    value.payload.diagnostic.android.reason = 3; value.payload.diagnostic.cause = 'system_low_memory';
    expect(ReportEnvelope.safeParse(value).success).toBe(false);
    value.payload.diagnostic.android.reason = 6; value.payload.diagnostic.cause = 'anr';
    value.payload.diagnostic.trace.frames = Array.from({ length: 65 }, () => ({ function: 'a.b' }));
    expect(ReportEnvelope.safeParse(value).success).toBe(false);
  });
});
