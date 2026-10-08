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

const stall = () => ({ version: 1, evidenceId: id, kind: 'recovered_main_thread_stall', provenance: 'android_main_looper_probe',
  outcome: 'recovered', scope: 'main_looper', queuedAt: start, recoveredAt: '2026-10-08T00:00:06.000Z',
  probeDelayMs: 6000, thresholdMs: 5000, sampleIntervalMs: 1000, clock: 'uptime', eligibility: 'foreground-debugger-checked-v1',
  trace: 'not_collected', attribution: { release: 'frozen', session: 'unavailable', webExposure: 'unavailable', nativeExposure: 'unavailable' }, android: { apiLevel: 35 } });
describe('followthrough diagnostics stay separate from fatal and exposure evidence', () => {
  it('accepts the new recovered observation beside the existing Apple/Android contracts', () => {
    const value = envelope('android', { recoveredStall: stall() }); value.submittedAt = stall().recoveredAt;
    expect(protocol.ReportEnvelope.parse(value).payload).toEqual({ recoveredStall: stall() });
    for (const [platform, payload] of [['ios', { appleDiagnostic: apple() }], ['android', { diagnostic: android() }]] as const) {
      expect(protocol.ReportEnvelope.parse(envelope(platform, payload)).payload).toEqual(payload);
    }
  });
  it('rejects every mixed diagnostic pair and a fabricated fatal source', () => {
    // Each pair is otherwise valid for the evidence that selects its rule, so mixing must be the only issue.
    const appleMix = 'Apple evidence requires diagnostic source and no other diagnostic or crash block';
    for (const [platform, submittedAt, payload, path, message] of [
      ['android', stall().recoveredAt, { recoveredStall: stall(), diagnostic: android() }, ['payload'], 'Recovered probes cannot include other captured content'],
      ['ios', apple().collectedAt, { recoveredStall: stall(), appleDiagnostic: apple() }, ['source'], appleMix],
      ['ios', apple().collectedAt, { diagnostic: android(), appleDiagnostic: apple() }, ['source'], appleMix],
    ] as const) {
      const mixed = envelope(platform, payload); mixed.submittedAt = submittedAt;
      const issues = protocol.ReportEnvelope.safeParse(mixed).error?.issues.map(issue => ({ path: issue.path, message: issue.message }));
      expect(issues, Object.keys(payload).join('+')).toEqual([{ path, message }]);
    }
    const value = envelope('android', { recoveredStall: stall() }); value.submittedAt = stall().recoveredAt; value.source = 'crash';
    expect(protocol.ReportEnvelope.safeParse(value).success).toBe(false);
  });
});
