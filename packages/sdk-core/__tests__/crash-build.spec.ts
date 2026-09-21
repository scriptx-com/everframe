// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { ReportEnvelope } from '@traceitx/protocol';
import { buildCrashEnvelope } from '../src/crash/index.js';

const base = () => ({
  facts: {
    exceptionType: 'TypeError',
    message: 'boom eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ',
    // NOTE: adapted from the brief's `Bearer sk-live-12345` — the shipped
    // default-deny engine (redaction/engine.ts) only auto-redacts JWT/SSN/
    // Luhn-valid-credit-card/auth-headers; a generic API-key shape is not a
    // built-in rule (confirmed against __test-helpers__/seeded-pii.ts, whose
    // corpus has no bare-token case either). Swapped in a Luhn-valid test
    // credit-card number so this fixture actually exercises a real
    // redaction rule instead of a phantom one. See task-5-report.md.
    frames: [{ raw: 'at f (a.ts:1:1) card 4111111111111111' }],
  },
  mechanism: 'onerror',
  source: 'error' as const,
  occurredAt: '2026-07-18T12:00:00.000Z',
  reportId: '123e4567-e89b-42d3-a456-426614174000',
  submittedAt: '2026-07-18T12:00:00.100Z',
  sdk: { name: 'traceitx-react' as const, version: '1.0.0', platform: 'web' as const, formFactor: 'desktop' as const },
  breadcrumbs: [{ kind: 'error' as const, message: 'two', seq: 1, t: 999 }],
  device: {
    os: 'macOS', osVersion: '15', screenSize: { width: 1280, height: 800 },
    pixelRatio: 2, locale: 'en-US', timezone: 'UTC',
  },
  app: { name: 'demo', version: '1.2.3' },
  route: '/checkout',
  redaction: {},
});

describe('buildCrashEnvelope (spec 2026-07-18)', () => {
  it('snapshots and redacts capture options without changing classification or fingerprint', () => {
    const metadata = { retry: 2, accessToken: 'synthetic' };
    const first = buildCrashEnvelope({
      ...base(),
      handled: true,
      fatal: false,
      captureOptions: { severity: 'warning', context: 'checkout 123-45-6789', metadata },
    });
    metadata.retry = 99;
    const second = buildCrashEnvelope({
      ...base(),
      captureOptions: { severity: 'info', context: 'payment', metadata: { retry: 8 } },
    });

    expect(first.envelope.payload.crash).toMatchObject({
      handled: true,
      fatal: false,
      details: {
        severity: 'warning',
        context: 'checkout [REDACTED:SSN]',
        metadata: { retry: 2, accessToken: '[REDACTED]' },
      },
    });
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it('attaches the owned cause snapshot without a second normalization pass or fingerprint input', () => {
    const causeChain = {
      causes: [{
        exceptionType: 'TypeError',
        message: 'already-owned',
        frames: [{ raw: 'at inner (owned.js:1:2)' }],
        framesTruncated: false,
      }],
      truncated: false,
    };
    const withCause = buildCrashEnvelope({
      ...base(),
      causeChain,
      redaction: {
        customRules: [{ type: 'pattern' as const, match: /owned/g, replacement: 'redacted-again' }],
      },
    });
    const withoutCause = buildCrashEnvelope(base());

    expect(withCause.envelope.payload.crash?.causeChain).toEqual(causeChain);
    expect(withCause.envelope.payload.crash?.causeChain?.causes[0]?.message).toBe('already-owned');
    expect(withCause.fingerprint).toBe(withoutCause.fingerprint);
  });

  it('adds error severity by default to newly assembled web crash envelopes', () => {
    const { envelope } = buildCrashEnvelope(base());
    expect(envelope.payload.crash?.details).toEqual({ severity: 'error' });
  });

  it('preserves handled and fatal as separate classification fields', () => {
    const { envelope } = buildCrashEnvelope({ ...base(), handled: true, fatal: false });
    expect(ReportEnvelope.parse(envelope).payload.crash).toMatchObject({
      handled: true, fatal: false,
    });
  });

  it('keeps a long exception message in the synthesized title up to 200 chars', () => {
    const message = 'x'.repeat(400);
    const { envelope } = buildCrashEnvelope({
      ...base(),
      facts: { ...base().facts, message },
    });
    const title = ReportEnvelope.parse(envelope).reporter.title;

    expect(title).toBe(`TypeError: ${message}`.slice(0, 200));
    expect(title.length).toBe(200);
  });

  it('produces a schema-valid unattended envelope with synthesized reporter', () => {
    const { envelope, fingerprint } = buildCrashEnvelope(base());
    const parsed = ReportEnvelope.parse(envelope);
    expect(parsed.source).toBe('error');
    expect(parsed.reporter.title.length).toBeLessThanOrEqual(200);
    expect(parsed.reporter.title.startsWith('TypeError: boom')).toBe(true);
    expect(parsed.reporter.description).toBe('');
    expect(parsed.payload.crash?.mechanism).toBe('onerror');
    expect(parsed.payload.crash?.handled).toBe(false);
    expect(parsed.payload.crash?.fingerprint).toBe(fingerprint);
    expect(parsed.payload.breadcrumbs?.length).toBe(1);
    expect(parsed.captureControl.degradedReason).toBe('crash-capture');
    expect(parsed.captureControl.included).toEqual(['breadcrumbs']);
    // Only breadcrumbs captured — no derived logs/network, no uiTree/screenshot.
    expect(parsed.captures).toMatchObject({
      screenshot: false, uiTree: false, focus: false, logs: false, network: false, breadcrumbs: true,
    });
    expect(parsed.payload.logs).toBeUndefined();
  });

  it('redacts crash message and frames before they enter the envelope', () => {
    const { envelope } = buildCrashEnvelope(base());
    expect(envelope.payload.crash?.message).toContain('[REDACTED:JWT]');
    expect(envelope.payload.crash?.frames[0]!.raw).not.toContain('4111111111111111');
    expect(envelope.payload.crash?.frames[0]!.raw).toContain('[REDACTED:CC]');
  });

  it('re-caps a frame raw that redaction expands past the 1024-char protocol limit', () => {
    // SSN `123-45-6789` (11 chars) -> `[REDACTED:SSN]` (14 chars) is an
    // EXPANDING replacement. Build a raw that is exactly at the 1024 cap
    // pre-redaction (as extract.ts would have already capped it) so that
    // post-redaction it overflows past the cap unless build.ts re-slices.
    const ssn = '123-45-6789';
    const prefix = 'a'.repeat(1024 - ssn.length);
    const rawAtCap = `${prefix}${ssn}`;
    expect(rawAtCap.length).toBe(1024);

    const input = base();
    input.facts.frames = [{ raw: rawAtCap }];

    const { envelope } = buildCrashEnvelope(input);
    // Would be 1027 chars if not re-sliced post-redaction.
    expect(envelope.payload.crash?.frames[0]!.raw.length).toBeLessThanOrEqual(1024);

    const parsed = ReportEnvelope.parse(envelope);
    expect(parsed.payload.crash?.frames[0]!.raw.length).toBeLessThanOrEqual(1024);
  });

  it('re-caps a crash message that redaction expands past the 4096-char protocol limit', () => {
    const ssn = '123-45-6789';
    const prefix = 'b'.repeat(4096 - ssn.length);
    const messageAtCap = `${prefix}${ssn}`;
    expect(messageAtCap.length).toBe(4096);

    const input = base();
    input.facts.message = messageAtCap;

    const { envelope } = buildCrashEnvelope(input);
    expect(envelope.payload.crash?.message.length).toBeLessThanOrEqual(4096);

    const parsed = ReportEnvelope.parse(envelope);
    expect(parsed.payload.crash?.message.length).toBeLessThanOrEqual(4096);
  });
});
