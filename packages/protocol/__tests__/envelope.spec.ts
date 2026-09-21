// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { ReportEnvelope, PROTOCOL_VERSION } from '../src/index.js';
import minimal from './fixtures/v1-minimal.json';
import full from './fixtures/v1-full.json';

describe('ReportEnvelope', () => {
  it('PROTOCOL_VERSION is "1.0"', () => {
    expect(PROTOCOL_VERSION).toBe('1.0');
  });

  it('parses v1-minimal fixture', () => {
    const result = ReportEnvelope.safeParse(minimal);
    if (!result.success) console.error(JSON.stringify(result.error, null, 2));
    expect(result.success).toBe(true);
  });

  it('round-trips v1-minimal through JSON', () => {
    const parsed = ReportEnvelope.parse(minimal);
    const serialized = JSON.stringify(parsed);
    const reparsed = ReportEnvelope.parse(JSON.parse(serialized));
    expect(reparsed).toEqual(parsed);
  });

  it('parses v1-full with every optional field populated', () => {
    const result = ReportEnvelope.safeParse(full);
    if (!result.success) console.error(JSON.stringify(result.error, null, 2));
    expect(result.success).toBe(true);
  });

  it('accepts a reporter.title of exactly 200 chars and rejects 201', () => {
    const at = (n: number) => ({
      ...minimal,
      reporter: { ...(minimal as any).reporter, title: 'a'.repeat(n) },
    });
    expect(ReportEnvelope.safeParse(at(200)).success).toBe(true);
    expect(ReportEnvelope.safeParse(at(201)).success).toBe(false);
  });

  it('PAY-02: focus.componentPath is required when focus present', () => {
    const bad = {
      ...full,
      payload: {
        ...(full as any).payload,
        focus: { path: [0], source: 'keyboard' },
      },
    };
    expect(ReportEnvelope.safeParse(bad).success).toBe(false);
  });

  it('PAY-05: captureControl.included and excluded are required arrays', () => {
    const bad = { ...minimal, captureControl: { included: [] } };
    expect(ReportEnvelope.safeParse(bad).success).toBe(false);
  });

  // Self-declared recognition (spec 2026-08-12), final whole-branch review
  // finding 1. `reporter.user` is a host-supplied LABEL: every SDK ships
  // whatever `setUser` was handed, and ingest answers a schema failure with
  // 400 `schema_validation_failed`. So a blank or unparseable email here must
  // parse — `setUser({ id: user.id, email: user.email ?? '' })` is an ordinary
  // host idiom, and a format check in this schema would turn every report that
  // app files into a lost bug report. Format arbitration lives at ingest
  // (`the server self-declared identity contract`'s EMAIL_RE), where an
  // unusable email is merely an absent attribute.
  it.each([
    ['blank', ''],
    ['unparseable', 'alice'],
    ['well-formed', 'a@b.com'],
  ])('accepts a %s reporter.user.email', (_label, email) => {
    const env = {
      ...(minimal as Record<string, unknown>),
      reporter: { title: 'T', description: 'D', user: { id: 'u_1', email } },
    };
    const result = ReportEnvelope.safeParse(env);
    if (!result.success) console.error(JSON.stringify(result.error, null, 2));
    expect(result.success).toBe(true);
  });
});
