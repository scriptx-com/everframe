// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { ReportEnvelope, CrashPayload } from '../src/index.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const fixture = () =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', 'crash-report.json'), 'utf8'));

const jvmFixture = () =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', 'jvm-crash-envelope.json'), 'utf8'));

const cause = (overrides: Record<string, unknown> = {}) => ({
  exceptionType: 'java.lang.IllegalArgumentException',
  message: 'middle failure',
  frames: [{ raw: 'at sample.Middle.run(Middle.kt:11)', function: 'run', file: 'Middle.kt', line: 11 }],
  framesTruncated: false,
  ...overrides,
});

/**
 * Deep-sort JsonObject keys so re-serialization is deterministic regardless
 * of insertion order. Copied verbatim from cross-sdk-proto-02.spec.ts /
 * relay-cross-sdk.spec.ts (established per-file duplication convention —
 * this repo has no shared test-util module for it).
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      sorted[k] = canonicalize(obj[k]);
    }
    return sorted;
  }
  return value;
}

describe('CrashPayload / source (spec 2026-07-18)', () => {
  it('validates fatal when present while leaving legacy classification unknown', () => {
    const legacy = fixture().payload.crash;
    expect(CrashPayload.parse(legacy).fatal).toBeUndefined();
    expect(CrashPayload.parse({ ...legacy, handled: true, fatal: false }).fatal).toBe(false);
    expect(CrashPayload.safeParse({ ...legacy, fatal: 'false' }).success).toBe(false);
  });

  it('accepts a crash envelope fixture', () => {
    const parsed = ReportEnvelope.parse(fixture());
    expect(parsed.source).toBe('crash');
    expect(parsed.payload.crash?.exceptionType).toBe('java.lang.NullPointerException');
    expect(parsed.payload.crash?.fingerprint).toHaveLength(16);
  });

  it('source is optional — legacy envelopes still parse (additive)', () => {
    const env = fixture();
    delete env.source;
    delete env.payload.crash;
    expect(() => ReportEnvelope.parse(env)).not.toThrow();
    expect(ReportEnvelope.parse(env).source).toBeUndefined();
  });

  it('rejects out-of-enum source and over-cap frames', () => {
    const bad = fixture();
    bad.source = 'anr';
    expect(() => ReportEnvelope.parse(bad)).toThrow();
    const overFrames = fixture();
    overFrames.payload.crash.frames = Array.from({ length: 257 }, () => ({ raw: 'at x' }));
    expect(() => ReportEnvelope.parse(overFrames)).toThrow();
  });

  it('CrashPayload passthrough preserves unknown additive fields', () => {
    const p = CrashPayload.parse({ ...fixture().payload.crash, futureField: 1 });
    expect((p as Record<string, unknown>).futureField).toBe(1);
  });

  it('accepts bounded error details additively and leaves old crash payloads absent', () => {
    const legacy = fixture().payload.crash;
    expect(CrashPayload.parse(legacy).details).toBeUndefined();
    expect(CrashPayload.parse({
      ...legacy,
      details: {
        severity: 'warning',
        context: 'checkout',
        metadata: { retry: 2, flags: [true, null] },
      },
    }).details).toEqual({
      severity: 'warning',
      context: 'checkout',
      metadata: { retry: 2, flags: [true, null] },
    });
  });

  it('validates the optional generic cause chain while preserving old absence', () => {
    const legacy = fixture().payload.crash;
    expect(CrashPayload.parse(legacy).causeChain).toBeUndefined();
    expect(CrashPayload.parse({
      ...legacy,
      causeChain: {
        causes: [{
          exceptionType: 'TypeError',
          message: 'underlying',
          frames: [{ raw: 'at root' }],
          framesTruncated: false,
        }],
        truncated: false,
      },
    }).causeChain?.causes[0]?.message).toBe('underlying');
    expect(CrashPayload.safeParse({
      ...legacy,
      causeChain: { causes: [{ exceptionType: 'Error' }], truncated: false },
    }).success).toBe(false);
  });

  it('preserves an own metadata __proto__ key through the complete envelope parse', () => {
    const env = fixture();
    env.payload.crash.details = JSON.parse(
      '{"metadata":{"__proto__":{"value":"valid"},"sibling":2}}',
    );

    const parsed = ReportEnvelope.parse(env);
    expect(Object.keys(parsed.payload.crash?.details?.metadata ?? {}))
      .toEqual(['__proto__', 'sibling']);
    expect(parsed.payload.crash?.details?.metadata?.['__proto__']).toEqual({ value: 'valid' });
    expect(parsed.payload.crash?.details?.metadata?.sibling).toBe(2);
  });

  it('rejects malformed details when callers bypass normalization', () => {
    const legacy = fixture().payload.crash;
    for (const details of [
      { severity: 'fatal' },
      { context: 'x'.repeat(257) },
      { metadata: { value: () => undefined } },
      { unknown: true },
    ]) {
      expect(CrashPayload.safeParse({ ...legacy, details }).success).toBe(false);
    }
  });

  // Task 14 — cross-SDK round-trip gate (mirrors cross-sdk-proto-02.spec.ts's
  // pattern). The same physical crash-report.json is also decoded by the
  // Kotlin CrashReportCrossSDKTest and Swift CrashReportCrossSDKTests suites;
  // fixture-sync.spec.ts guards the three copies stay byte-identical.
  it('round-trips bytewise via canonical JSON (decode -> re-encode -> equal)', () => {
    const parsed = ReportEnvelope.parse(fixture());
    const reencoded = JSON.parse(JSON.stringify(parsed));
    expect(canonicalize(reencoded)).toEqual(canonicalize(fixture()));
  });
});

describe('optional Hermes identity', () => {
  const identity = { engine: 'hermes', platform: 'android', buildId: ' run-7 ', bundleName: 'index.android.bundle' };
  it('preserves exact identity while accepting old envelopes', () => {
    expect(CrashPayload.parse(fixture().payload.crash).jsBundle).toBeUndefined();
    expect(CrashPayload.parse({ ...fixture().payload.crash, jsBundle: identity }).jsBundle).toEqual(identity);
  });
  it.each(['', ' ', 'x\0y', '\ud800', '\udc00', 'a'.repeat(201)])('rejects invalid build IDs %j', buildId => {
    expect(CrashPayload.safeParse({ ...fixture().payload.crash, jsBundle: { ...identity, buildId } }).success).toBe(false);
  });
  it.each([{ engine: 'jsc' }, { platform: 'web' }, { bundleName: '../index.bundle' }, { bundleName: 'index.bundle\n' }])('rejects invalid identity %j', bad => {
    expect(CrashPayload.safeParse({ ...fixture().payload.crash, jsBundle: { ...identity, ...bad } }).success).toBe(false);
  });
});

it('round-trips the Hermes cross-SDK fixture with exact identity', () => {
  const input = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'crash-report-hermes.json'), 'utf8'));
  expect(ReportEnvelope.parse(input).payload.crash?.jsBundle?.buildId).toBe(' js-7 ');
  expect(canonicalize(JSON.parse(JSON.stringify(ReportEnvelope.parse(input))))).toEqual(canonicalize(input));
});

describe('optional JVM crash metadata', () => {
  const base = fixture().payload.crash;

  it('accepts legacy crash payloads without JVM metadata and validates mapping IDs', () => {
    expect(CrashPayload.parse(base).jvm).toBeUndefined();
    for (const mappingId of ['a', `a${'Z._-9'.repeat(25)}xy`]) {
      expect(mappingId).toHaveLength(mappingId === 'a' ? 1 : 128);
      expect(CrashPayload.parse({
        ...base,
        jvm: { mappingId, causes: [], causesTruncated: false },
      }).jvm?.mappingId).toBe(mappingId);
    }
    for (const mappingId of ['', '-release', '_release', '.release', 'invalid/id', 'release id', 'release\n', 'release\r', `a${'b'.repeat(128)}`]) {
      expect(CrashPayload.safeParse({
        ...base,
        jvm: { mappingId, causes: [], causesTruncated: false },
      }).success).toBe(false);
    }

    expect(CrashPayload.safeParse({ ...base, jvm: {
      mappingId: 'invalid/id', causes: [], causesTruncated: false,
    }}).success).toBe(false);
    expect(CrashPayload.parse({ ...base, jvm: {
      mappingId: 'android-release-ci-123', causes: [], causesTruncated: false,
    }}).jvm?.mappingId).toBe('android-release-ci-123');
  });

  it('enforces cause, nested frame, and cause text limits', () => {
    expect(CrashPayload.safeParse({
      ...base,
      jvm: { causes: Array.from({ length: 8 }, () => cause()), causesTruncated: false },
    }).success).toBe(true);
    expect(CrashPayload.safeParse({
      ...base,
      jvm: { causes: Array.from({ length: 9 }, () => cause()), causesTruncated: true },
    }).success).toBe(false);
    expect(CrashPayload.safeParse({
      ...base,
      jvm: { causes: [cause({ frames: Array.from({ length: 32 }, () => ({ raw: 'at x' })) })], causesTruncated: false },
    }).success).toBe(true);
    expect(CrashPayload.safeParse({
      ...base,
      jvm: { causes: [cause({ frames: Array.from({ length: 33 }, () => ({ raw: 'at x' })) })], causesTruncated: false },
    }).success).toBe(false);
    expect(CrashPayload.safeParse({
      ...base,
      jvm: { causes: [cause({ exceptionType: 'x'.repeat(257) })], causesTruncated: false },
    }).success).toBe(false);
    expect(CrashPayload.safeParse({
      ...base,
      jvm: { causes: [cause({ message: 'x'.repeat(4097) })], causesTruncated: false },
    }).success).toBe(false);
    expect(CrashPayload.safeParse({
      ...base,
      jvm: {
        causes: [cause({ exceptionType: 'x'.repeat(256), message: 'x'.repeat(4096) })],
        causesTruncated: false,
      },
    }).success).toBe(true);
  });

  it('requires both truncation flags while preserving the outer 256-frame limit', () => {
    expect(CrashPayload.safeParse({
      ...base,
      jvm: { causes: [cause({ framesTruncated: undefined })], causesTruncated: false },
    }).success).toBe(false);
    expect(CrashPayload.safeParse({
      ...base,
      jvm: { causes: [cause()], causesTruncated: undefined },
    }).success).toBe(false);
    expect(CrashPayload.safeParse({
      ...base,
      frames: Array.from({ length: 256 }, () => ({ raw: 'at outer' })),
      jvm: { causes: [], causesTruncated: false },
    }).success).toBe(true);
    expect(CrashPayload.safeParse({
      ...base,
      frames: Array.from({ length: 257 }, () => ({ raw: 'at outer' })),
      jvm: { causes: [], causesTruncated: false },
    }).success).toBe(false);
  });

  it('round-trips the JVM cross-SDK fixture with ordered causes and no JS identity', () => {
    const input = jvmFixture();
    const parsed = ReportEnvelope.parse(input);
    const crash = parsed.payload.crash!;
    expect(crash.jsBundle).toBeUndefined();
    expect(input.context.app.build).toBe('42');
    expect(crash.jvm?.mappingId).toBe('android-release-ci-123');
    expect(crash.jvm?.causes.map(item => [item.exceptionType, item.message])).toEqual([
      ['java.lang.IllegalArgumentException', 'middle failure'],
      ['java.lang.IllegalStateException', 'inner failure'],
    ]);
    expect(crash.jvm?.causes.map(item => item.frames[0]?.function)).toEqual(['run', 'fail']);
    expect(crash.jvm?.causes.map(item => item.frames[0]?.raw)).toEqual([
      'sample.Middle.run(Middle.kt:11)',
      'sample.Inner.fail(Inner.kt:7)',
    ]);
    expect(crash.jvm?.causes.map(item => item.framesTruncated)).toEqual([false, false]);
    expect(canonicalize(JSON.parse(JSON.stringify(parsed)))).toEqual(canonicalize(input));
  });
});
