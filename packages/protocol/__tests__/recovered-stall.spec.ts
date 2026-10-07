// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { ReportEnvelope } from '../src/index.js';
import { baseEnvelope } from './helpers/base-envelope.js';

const evidence = () => ({
  version: 1, evidenceId: '11111111-1111-4111-8111-111111111111',
  kind: 'recovered_main_thread_stall', provenance: 'android_main_looper_probe', outcome: 'recovered', scope: 'main_looper',
  queuedAt: '2026-10-08T00:00:00.000Z', recoveredAt: '2026-10-08T00:00:06.000Z',
  probeDelayMs: 6000, thresholdMs: 5000, sampleIntervalMs: 1000, clock: 'uptime',
  eligibility: 'foreground-debugger-checked-v1', trace: 'not_collected',
  attribution: { release: 'frozen', session: 'unavailable', webExposure: 'unavailable', nativeExposure: 'unavailable' },
  android: { apiLevel: 24 },
});
const envelope = () => {
  const value = baseEnvelope(); value.source = 'diagnostic'; value.reportId = evidence().evidenceId;
  value.submittedAt = evidence().recoveredAt; value.sdk.platform = 'android'; value.sdk.name = 'everframe-android';
  value.payload = { recoveredStall: evidence() }; return value;
};

describe('recovered main-thread probe evidence', () => {
  it('accepts recovered anonymous probe delay without claiming an OS exit', () => {
    expect(ReportEnvelope.safeParse(envelope()).success).toBe(true);
    expect(ReportEnvelope.parse(envelope()).payload.recoveredStall).toEqual(evidence());
  });
  it('accepts AndroidTV and exact threshold/upper-limit observations', () => {
    for (const [duration, recovered] of [[5000, '2026-10-08T00:00:05.000Z'], [60000, '2026-10-08T00:01:00.000Z']] as const) {
      const value = envelope(); value.sdk.platform = 'androidtv'; value.payload.recoveredStall.probeDelayMs = duration;
      value.payload.recoveredStall.recoveredAt = value.submittedAt = recovered;
      expect(ReportEnvelope.safeParse(value).success).toBe(true);
    }
  });
  it.each([
    ['fatal source', (v: any) => { v.source = 'crash'; }],
    ['manual source', (v: any) => { v.source = 'manual'; }],
    ['web platform', (v: any) => { v.sdk.platform = 'web'; }],
    ['identity', (v: any) => { v.reporter.user = { id: 'person' }; }],
    ['session', (v: any) => { v.sessionId = '22222222-2222-4222-8222-222222222222'; }],
    ['different report', (v: any) => { v.reportId = '22222222-2222-4222-8222-222222222222'; }],
    ['unknown outcome', (v: any) => { v.payload.recoveredStall.outcome = 'terminated'; }],
    ['OS provenance', (v: any) => { v.payload.recoveredStall.provenance = 'android_application_exit_info'; }],
    ['OS reason', (v: any) => { v.payload.recoveredStall.android.reason = 6; }],
    ['fatal flag', (v: any) => { v.payload.recoveredStall.fatal = true; }],
    ['native exposure', (v: any) => { v.payload.recoveredStall.attribution.nativeExposure = 'exact'; }],
    ['under threshold', (v: any) => { v.payload.recoveredStall.probeDelayMs = 4999; }],
    ['over limit', (v: any) => { v.payload.recoveredStall.probeDelayMs = 60001; }],
    ['fractional duration', (v: any) => { v.payload.recoveredStall.probeDelayMs = 5000.5; }],
    ['different policy', (v: any) => { v.payload.recoveredStall.thresholdMs = 2000; }],
    ['wall drift', (v: any) => { v.payload.recoveredStall.recoveredAt = v.submittedAt = '2026-10-08T00:01:00.000Z'; }],
    ['reversed timestamps', (v: any) => { v.payload.recoveredStall.queuedAt = '2026-10-08T00:01:00.000Z'; }],
    ['mutable collection time', (v: any) => { v.submittedAt = '2026-10-08T00:00:07.000Z'; }],
    ['logs', (v: any) => { v.payload.logs = [{ message: 'secret' }]; }],
    ['extra', (v: any) => { v.payload.extra = 'secret'; }],
    ['unknown payload', (v: any) => { v.payload.custom = 'secret'; }],
    ['capture claim', (v: any) => { v.captures.logs = true; }],
    ['route', (v: any) => { v.context.route = '/private'; }],
  ] as const)('rejects %s', (_name, mutate) => {
    const value = envelope(); mutate(value); expect(ReportEnvelope.safeParse(value).success).toBe(false);
  });
  it('rejects OS evidence on the same recovered observation', () => {
    const value = envelope(); value.payload.diagnostic = {
      version: 1, evidenceId: value.reportId, processLaunchId: '22222222-2222-4222-8222-222222222222',
      kind: 'process_exit', provenance: 'android_application_exit_info', scope: 'os_process', outcome: 'terminated', cause: 'anr',
      occurredAt: '2026-10-08T00:00:00.000Z', collectedAt: value.submittedAt,
      attribution: { process: 'exact_os_token', release: 'frozen', session: 'unavailable', webExposure: 'unavailable' },
      android: { apiLevel: 30, reason: 6, pid: 100 }, trace: { status: 'unavailable', format: 'none', truncated: false, frames: [] },
    }; expect(ReportEnvelope.safeParse(value).success).toBe(false);
  });
});
