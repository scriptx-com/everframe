// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ReportEnvelope } from '../src/index.js';
const evidence = () => ({ version: 1, evidenceId: '11111111-1111-4111-8111-111111111111',
  ownershipId: '22222222-2222-4222-8222-222222222222', kind: 'hang_batch', provenance: 'apple_metrickit',
  scope: 'reporting_interval', outcome: 'unknown', interval: { begin: '2026-10-08T00:00:00.000Z', end: '2026-10-08T00:01:00.000Z' },
  collectedAt: '2026-10-08T00:02:00.000Z',
  attribution: { process: 'unavailable', release: 'frozen', session: 'unavailable', webExposure: 'unavailable' },
  apple: { applicationVersion: '1.0', applicationBuild: '42', osVersion: 'iOS 18.0' }, truncated: false,
  hangs: [{ durationMs: 2000, stack: { status: 'available', truncated: false,
    frames: [{ binaryUUID: '33333333-3333-4333-8333-333333333333', binaryName: 'Example', address: '0x100004010', offset: '0x4010' }] } }],
});
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/crash-report.json', import.meta.url), 'utf8'));
const envelope = (): any => {
  const v = fixture();
  v.source = 'diagnostic'; v.sdk.platform = 'ios'; v.sdk.name = 'everframe-ios';
  v.reportId = evidence().evidenceId; v.submittedAt = evidence().collectedAt;
  v.payload = { appleDiagnostic: evidence() }; v.attachments = [];
  delete v.sessionId; delete v.reporter.user; return v;
};
const exclusive = 'Apple evidence requires diagnostic source and no other diagnostic or crash block';
const anonymous = 'Apple evidence must be anonymous and attachment-free';
describe('Apple MetricKit diagnostic evidence', () => {
  it('preserves a hang batch with unknown outcome and only a reporting period', () => {
    expect(ReportEnvelope.parse(envelope()).payload.appleDiagnostic).toEqual(evidence());
  });
  it('accepts explicit aggregate counts without manufacturing individual exit evidence', () => {
    const v = envelope(); const d = v.payload.appleDiagnostic; d.kind = 'app_exit_summary'; delete d.hangs;
    d.exits = [{ state: 'background', reason: 'memory_pressure', count: 3 }, { state: 'foreground', reason: 'normal', count: 2 }];
    expect(ReportEnvelope.safeParse(v).success).toBe(true);
  });
  // Each mutation is otherwise valid, so only the Apple envelope rule can reject it.
  it.each([
    ['source', ['source'], exclusive, (v: any) => { v.source = 'crash'; }],
    ['platform', ['sdk', 'platform'], 'MetricKit evidence requires iOS', (v: any) => { v.sdk.platform = 'tvos'; }],
    ['user', ['payload', 'appleDiagnostic'], anonymous, (v: any) => { v.reporter.user = { id: 'live-user' }; }],
    ['attachments', ['payload', 'appleDiagnostic'], anonymous, (v: any) => {
      v.attachments = [{ partName: 'screenshot', kind: 'screenshot', contentType: 'image/png', byteLength: 1, sha256: 'a'.repeat(64) }];
    }],
    ['session', ['payload', 'appleDiagnostic'], anonymous, (v: any) => { v.sessionId = evidence().ownershipId; }],
    ['report identity', ['reportId'], 'Report and evidence identities must match', (v: any) => { v.reportId = evidence().ownershipId; }],
    ['collection time', ['submittedAt'], 'Submission must use the frozen collection time', (v: any) => { v.submittedAt = '2026-10-08T00:03:00Z'; }],
    ['crash body', ['source'], exclusive, (v: any) => { v.payload.crash = fixture().payload.crash; }],
    ['second individually valid Android evidence block', ['source'], exclusive, (v: any) => {
      v.payload.diagnostic = { version: 1, evidenceId: v.reportId, processLaunchId: evidence().ownershipId,
        kind: 'process_exit', provenance: 'android_application_exit_info', scope: 'os_process', outcome: 'terminated', cause: 'anr',
        occurredAt: v.submittedAt, collectedAt: v.submittedAt,
        attribution: { process: 'exact_os_token', release: 'frozen', session: 'unavailable', webExposure: 'unavailable' },
        android: { apiLevel: 30, reason: 6, pid: 100 }, trace: { status: 'unavailable', format: 'none', truncated: false, frames: [] } };
    }],
  ])('rejects %s through the Apple envelope rule', (_label, path, message, mutate) => {
    const v = envelope(); mutate(v);
    const issues = ReportEnvelope.safeParse(v).error?.issues.map(({ path, message }) => ({ path, message }));
    expect(issues).toEqual([{ path, message }]);
  });
  it.each([
    ['fatal', (v: any) => { v.payload.appleDiagnostic.fatal = true; }],
    ['process attribution', (v: any) => { v.payload.appleDiagnostic.attribution.process = 'exact_os_token'; }],
    ['occurrence', (v: any) => { v.payload.appleDiagnostic.occurredAt = v.submittedAt; }],
    ['recovery claim', (v: any) => { v.payload.appleDiagnostic.outcome = 'recovered'; }],
    ['future interval', (v: any) => { v.payload.appleDiagnostic.interval.end = '2026-10-09T00:00:00Z'; }],
    ['reversed interval', (v: any) => { v.payload.appleDiagnostic.interval.begin = '2026-10-08T00:01:01Z'; }],
    ['long interval', (v: any) => { v.payload.appleDiagnostic.interval.begin = '2026-10-06T00:00:00Z'; }],
    ['unsafe name', (v: any) => { v.payload.appleDiagnostic.hangs[0].stack.frames[0].binaryName = '/private/alice/Example'; }],
    ['frame bound', (v: any) => { const s = v.payload.appleDiagnostic.hangs[0].stack; s.frames = Array(65).fill(s.frames[0]); }],
    ['hang bound', (v: any) => { const d = v.payload.appleDiagnostic; d.hangs = Array(9).fill(d.hangs[0]); }],
    ['missing stack', (v: any) => { v.payload.appleDiagnostic.hangs[0].stack.frames = []; }],
    ['unavailable stack', (v: any) => { v.payload.appleDiagnostic.hangs[0].stack.status = 'unavailable'; }],
    ['mixed kinds', (v: any) => { v.payload.appleDiagnostic.exits = [{ state: 'foreground', reason: 'normal', count: 1 }]; }],
  ])('rejects %s', (_label, mutate) => {
    const v = envelope(); mutate(v); expect(ReportEnvelope.safeParse(v).success).toBe(false);
  });
  it.each([0, -1, 1.5, 2147483648])('rejects invalid aggregate count %s', (count) => {
    const v = envelope(); const d = v.payload.appleDiagnostic; delete d.hangs; d.kind = 'app_exit_summary';
    d.exits = [{ state: 'foreground', reason: 'normal', count }];
    expect(ReportEnvelope.safeParse(v).success).toBe(false);
  });
  it('rejects duplicate count buckets and background-only reasons in the foreground', () => {
    const v = envelope(); const d = v.payload.appleDiagnostic; delete d.hangs; d.kind = 'app_exit_summary';
    d.exits = [{ state: 'foreground', reason: 'memory_pressure', count: 1 }];
    expect(ReportEnvelope.safeParse(v).success).toBe(false);
    d.exits = Array(2).fill({ state: 'background', reason: 'normal', count: 1 });
    expect(ReportEnvelope.safeParse(v).success).toBe(false);
  });
});
