// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// setUser -> envelope.reporter.user (spec 2026-08-12). Before this spec the
// value was stored on client state and silently dropped on every path.
import { describe, it, expect } from 'vitest';
import { buildEnvelope, type BuildEnvelopeInput } from '../src/envelope-builder.js';
import { buildCrashEnvelope, type BuildCrashEnvelopeInput } from '../src/crash/build.js';

// Minimal valid BuildEnvelopeInput, lifted from roundtrip.spec.ts's shape
// (reporter/draft/device/app/attachments) rather than invented.
function baseEnvelopeInput(): BuildEnvelopeInput {
  return {
    reportId: '01939c34-7b8f-7000-8000-000000000123',
    submittedAt: '2026-04-29T16:00:00.000Z',
    sdk: { name: 'everframe-react', version: '0.0.0', platform: 'web', formFactor: 'desktop' },
    reporter: { title: 'T', description: 'D' },
    draft: { title: 'T', description: 'D', excludedArtifacts: [], annotations: [], redactions: [] },
    device: {
      os: 'macOS',
      osVersion: '15',
      screenSize: { width: 1280, height: 800 },
      pixelRatio: 2,
      locale: 'en-US',
      timezone: 'UTC',
    },
    app: { name: 'demo', version: '1.2.3' },
    attachments: [],
  };
}

// Minimal valid BuildCrashEnvelopeInput, lifted from crash-build.spec.ts's
// `base()` helper rather than invented.
function baseCrashInput(): BuildCrashEnvelopeInput {
  return {
    facts: {
      exceptionType: 'TypeError',
      message: 'boom',
      frames: [{ raw: 'at f (a.ts:1:1)' }],
    },
    mechanism: 'onerror',
    source: 'error',
    occurredAt: '2026-07-18T12:00:00.000Z',
    reportId: '123e4567-e89b-42d3-a456-426614174000',
    submittedAt: '2026-07-18T12:00:00.100Z',
    sdk: { name: 'everframe-react', version: '1.0.0', platform: 'web', formFactor: 'desktop' },
    breadcrumbs: [{ kind: 'error', message: 'two', seq: 1, t: 999 }],
    device: {
      os: 'macOS',
      osVersion: '15',
      screenSize: { width: 1280, height: 800 },
      pixelRatio: 2,
      locale: 'en-US',
      timezone: 'UTC',
    },
    app: { name: 'demo', version: '1.2.3' },
    redaction: {},
  };
}

describe('envelope.reporter.user', () => {
  it('carries the user on the report path', () => {
    const env = buildEnvelope({
      ...baseEnvelopeInput(),
      reporter: { title: 'T', description: 'D', user: { id: 'u_1', email: 'a@b.com' } },
    });
    expect(env.reporter.user).toEqual({ id: 'u_1', email: 'a@b.com' });
  });

  it('omits the key entirely when no user is set', () => {
    const env = buildEnvelope(baseEnvelopeInput());
    expect(env.reporter.user).toBeUndefined();
  });

  it('omits the key when the user is null (sign-out)', () => {
    const env = buildEnvelope({
      ...baseEnvelopeInput(),
      reporter: { title: 'T', description: 'D', user: null },
    });
    expect(env.reporter.user).toBeUndefined();
  });

  it('carries the user on the crash path', () => {
    const env = buildCrashEnvelope({
      ...baseCrashInput(),
      user: { id: 'u_1', displayName: 'A' },
    }).envelope;
    expect(env.reporter.user).toEqual({ id: 'u_1', displayName: 'A' });
  });

  it('omits the key entirely when no user is set (crash path)', () => {
    const env = buildCrashEnvelope(baseCrashInput()).envelope;
    expect(env.reporter.user).toBeUndefined();
  });

  // Symmetric with the report path's sign-out case above (final whole-branch
  // review, finding 6). A crash sink reads the host's user through a getter
  // that resolves `null` for "signed out" as readily as it resolves a person,
  // so `null` must produce an ANONYMOUS crash report — not a `user: null` key
  // that the protocol's `.passthrough()` object would happily carry to ingest
  // and that `normalizeSelfDeclaredUser` would then have to defend against.
  it('omits the key when the user is null (sign-out, crash path)', () => {
    const env = buildCrashEnvelope({ ...baseCrashInput(), user: null }).envelope;
    expect(env.reporter.user).toBeUndefined();
  });
});
