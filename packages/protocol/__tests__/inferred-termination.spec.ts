// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ReportEnvelope } from '../src/envelope.js';
import { INFERRED_TERMINATION_EXCEPTION_TYPES, INFERRED_TERMINATION_FINGERPRINTS } from '../src/inferred-termination.js';
import { baseEnvelope } from './helpers/base-envelope.js';

const reportId = '01939c34-7b8f-7000-8000-0000000000aa';
const launch = '3f0d3c0e-1d2b-4c55-9a5e-6f7a8b9c0d1e';
function inferred(platform = 'ios'): Record<string, any> {
  const value = baseEnvelope();
  Object.assign(value, { reportId, submittedAt: '2026-10-10T18:05:00.000Z', source: 'crash' });
  value.sdk = { ...value.sdk, name: 'everframe-ios', platform, formFactor: platform === 'tvos' ? 'tv' : 'phone' };
  value.payload = {
    crash: {
      exceptionType: 'Low memory kill', mechanism: 'apple-termination-inference', fatal: true, handled: false,
      message: 'Killed for low memory while in the foreground (inferred, footprint 1367187 KiB, 39062 KiB available, 2 memory warnings)',
      frames: [], fingerprint: '165254e7d389a4b6', occurredAt: '2026-10-10T18:04:05.000Z',
    },
    inferredTermination: {
      version: 1, evidenceId: reportId, processLaunchId: launch, kind: 'process_exit',
      provenance: 'apple_next_launch_inference', scope: 'os_process', outcome: 'terminated', rules: 'apple-foreground-v1',
      cause: 'low_memory', lastSeenAt: '2026-10-10T18:04:05.000Z', collectedAt: '2026-10-10T18:05:00.000Z',
      attribution: { process: 'sdk_run_record', release: 'frozen', session: 'unavailable', webExposure: 'unavailable' },
      apple: { appState: 'active', footprintKb: 1367187, availableKb: 39062, memorySampledAt: '2026-10-10T18:04:05.000Z',
        memoryWarnings: 2, lastMemoryWarningAt: '2026-10-10T18:03:50.000Z', memoryPressure: 'warning', thermalState: 'nominal' },
    },
  };
  return value;
}
const issues = (value: unknown) => {
  const parsed = ReportEnvelope.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map(issue => issue.message);
};
const exposure = (processLaunchId: string) => ({ exposureId: '3f0d3c0e-1d2b-4c55-9a5e-6f7a8b9c0d1f',
  processLaunchId, startedAt: '2026-10-10T18:00:00.000Z',
  nativeBuildId: 'native-A', loadedBuildId: null, loadedBundleStatus: 'not_applicable' });

describe('inferred Apple foreground termination', () => {
  it('derives every fingerprint from its exception type and cause', () => {
    for (const cause of ['low_memory', 'unresponsive', 'unexplained'] as const) {
      const digest = createHash('sha256').update(`${INFERRED_TERMINATION_EXCEPTION_TYPES[cause]}|apple_inferred_${cause}`).digest('hex').slice(0, 16);
      expect(INFERRED_TERMINATION_FINGERPRINTS[cause]).toBe(digest);
    }
  });
  it('never shares the OS-confirmed Android low-memory group', () => {
    expect(Object.values(INFERRED_TERMINATION_FINGERPRINTS)).not.toContain('e23830aadf486dc3');
  });
  it.each(['ios', 'tvos'])('accepts one anonymous stackless fatal on %s', (platform) => {
    expect(issues(inferred(platform))).toEqual([]);
  });
  it('accepts an exposure that belongs to the inferred process', () => {
    const value = inferred();
    value.payload.inferredTermination.nativeExposure = exposure(launch);
    expect(issues(value)).toEqual([]);
  });
  it('accepts an inactive process only with a recorded stall', () => {
    const value = inferred();
    Object.assign(value.payload.crash, { exceptionType: 'Unresponsive termination', fingerprint: 'a96ea84123b3e05f' });
    Object.assign(value.payload.inferredTermination, { cause: 'unresponsive' });
    Object.assign(value.payload.inferredTermination.apple, { appState: 'inactive', mainThreadStallMs: 7000 });
    expect(issues(value)).toEqual([]);
  });
  it('accepts an unexplained termination without sampled memory', () => {
    const value = inferred();
    Object.assign(value.payload.crash, { exceptionType: 'Abnormal foreground termination', fingerprint: '07f0b3e86836c84e',
      message: 'Terminated in the foreground without a crash report (inferred)' });
    value.payload.inferredTermination.cause = 'unexplained';
    for (const key of ['footprintKb', 'availableKb', 'memorySampledAt', 'lastMemoryWarningAt']) delete value.payload.inferredTermination.apple[key];
    value.payload.inferredTermination.apple.memoryWarnings = 0;
    expect(issues(value)).toEqual([]);
  });
  const CRASH = 'Inferred termination requires its own stackless fatal crash';
  const ANONYMOUS = 'Inferred termination must be anonymous and attachment-free';
  const unresponsive = (v: Record<string, any>) => {
    Object.assign(v.payload.crash, { exceptionType: 'Unresponsive termination', fingerprint: 'a96ea84123b3e05f' });
    v.payload.inferredTermination.cause = 'unresponsive';
  };
  // A null message means a structural (Zod type) rejection rather than a named rule.
  it.each<[string, string | null, (value: Record<string, any>) => void]>([
    ['an Android platform', 'Inferred termination requires iOS or tvOS', v => { v.sdk.platform = 'android'; }],
    ['a handled crash', CRASH, v => { v.payload.crash.handled = true; }],
    ['a non-fatal crash', CRASH, v => { v.payload.crash.fatal = false; }],
    ['a crash without a fatal flag', CRASH, v => { delete v.payload.crash.fatal; }],
    ['frames', CRASH, v => { v.payload.crash.frames = [{ raw: '0x1' }]; }],
    ["Android's fingerprint", CRASH, v => { v.payload.crash.fingerprint = 'e23830aadf486dc3'; }],
    ['another exception type', CRASH, v => { v.payload.crash.exceptionType = 'Abnormal foreground termination'; }],
    ['another mechanism', CRASH, v => { v.payload.crash.mechanism = 'signal'; }],
    ['a crash time other than last seen', CRASH, v => { v.payload.crash.occurredAt = '2026-10-10T18:04:06.000Z'; }],
    ['last seen after collection', 'Collection precedes the last-seen time', v => {
      v.payload.inferredTermination.lastSeenAt = '2026-10-10T18:06:00.000Z'; v.payload.crash.occurredAt = '2026-10-10T18:06:00.000Z';
    }],
    ['a reporter user', ANONYMOUS, v => { v.reporter.user = { id: 'user-A' }; }],
    ['a session', ANONYMOUS, v => { v.sessionId = '3f0d3c0e-1d2b-4c55-9a5e-6f7a8b9c0d99'; }],
    ['an attachment', ANONYMOUS, v => {
      v.attachments = [{ partName: 'screenshot', kind: 'screenshot', contentType: 'image/png', byteLength: 1, sha256: 'a'.repeat(64) }];
    }],
    ['a submission time other than collection', 'Submission must use the frozen collection time', v => { v.submittedAt = '2026-10-10T18:05:01.000Z'; }],
    ['another evidence id', 'Report and evidence identities must match', v => { v.payload.inferredTermination.evidenceId = launch; }],
    ['diagnostic source', 'Inferred termination requires a crash payload', v => { v.source = 'diagnostic'; }],
    ['no crash payload', 'Inferred termination requires a crash payload', v => { delete v.payload.crash; }],
    ['the mechanism without evidence', 'Inferred termination crash requires its evidence', v => { delete v.payload.inferredTermination; }],
    ['Android OS evidence alongside', null, v => { v.payload.diagnostic = { version: 1 }; }],
    ['MetricKit evidence alongside', null, v => { v.payload.appleDiagnostic = { version: 1 }; }],
    ['a recovered stall alongside', null, v => { v.payload.recoveredStall = { version: 1 }; }],
    ['an unknown cause', null, v => { v.payload.inferredTermination.cause = 'jetsam'; }],
    ['an unknown evidence field', null, v => { v.payload.inferredTermination.apple.pid = 42; }],
    ['an inactive process without a stall', 'Only a stalled main thread admits an inactive process', v => {
      v.payload.inferredTermination.apple.appState = 'inactive';
    }],
    ['a background process', null, v => {
      v.payload.inferredTermination.apple.appState = 'background'; v.payload.inferredTermination.apple.mainThreadStallMs = 9000;
    }],
    ['unresponsive without a stall', 'Unresponsive requires a recorded main-thread stall', v => {
      unresponsive(v); v.payload.inferredTermination.apple.mainThreadStallMs = 4999;
    }],
    ['an exposure from another process', 'Exposure must belong to the inferred process', v => {
      v.payload.inferredTermination.nativeExposure = exposure('3f0d3c0e-1d2b-4c55-9a5e-6f7a8b9c0d20');
    }],
  ])('rejects %s', (_, message, mutate) => {
    const value = inferred(); mutate(value);
    const found = issues(value);
    expect(found).not.toEqual([]);
    if (message) expect(found).toContain(message);
  });
  it('accepts a stall of exactly the threshold for an unresponsive cause', () => {
    const value = inferred(); unresponsive(value); value.payload.inferredTermination.apple.mainThreadStallMs = 5000;
    expect(issues(value)).toEqual([]);
  });
});
