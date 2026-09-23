// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { UITree } from '@everframe/protocol';
import { applyRedaction } from '../src/redaction/engine.js';
import { buildSeededPIIEnvelope, TEST_PII } from '../src/__test-helpers__/seeded-pii.js';

describe('PRIV-03: zero leakage on seeded-PII fixture', () => {
  it('produces envelope with no literal PII strings (passwords/JWT/CC/SSN)', () => {
    const seeded = buildSeededPIIEnvelope();
    const { envelope, maskPlan } = applyRedaction(seeded, {});
    const json = JSON.stringify(envelope);
    expect(json).not.toContain(TEST_PII.password);
    expect(json).not.toContain(TEST_PII.jwtToken);
    expect(json).not.toContain(TEST_PII.creditCardValid);
    expect(json).not.toContain(TEST_PII.ssn);
    expect(maskPlan.length).toBeGreaterThan(0);
  });

  it('Luhn-INVALID card numbers are NOT redacted', () => {
    const seeded = buildSeededPIIEnvelope();
    const { envelope } = applyRedaction(seeded, {});
    const json = JSON.stringify(envelope);
    expect(json).toContain(TEST_PII.creditCardInvalid);
  });

  it('JWT token in Authorization + x-api-key headers → [REDACTED]', () => {
    const seeded = buildSeededPIIEnvelope();
    const { envelope } = applyRedaction(seeded, {});
    const headers = (envelope.payload.network as Array<{ headers: Record<string, string> }>)[0]!
      .headers;
    expect(headers.authorization).toBe('[REDACTED]');
    expect(headers['x-api-key']).toBe('[REDACTED]');
    expect(headers['content-type']).toBe('application/json');
  });

  it('masks reporter bearer credentials captured in network headers (recognition spec 2026-08-06)', () => {
    const seeded = buildSeededPIIEnvelope();
    (seeded.payload as { network: unknown }).network = [
      {
        method: 'GET',
        url: 'https://everframe.dev/api/reporter/threads',
        status: 200,
        startedAt: 1500,
        headers: {
          'x-everframe-device-token': 'evr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'x-everframe-identity-token': 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.sig',
          'content-type': 'application/json',
        },
      },
    ];
    const { envelope } = applyRedaction(seeded, {});
    const headers = (envelope.payload.network as Array<{ headers: Record<string, string> }>)[0]!
      .headers;
    expect(headers['x-everframe-device-token']).toBe('[REDACTED]');
    expect(headers['x-everframe-identity-token']).toBe('[REDACTED]');
    expect(headers['content-type']).toBe('application/json');
  });

  it('JWT shape inline match in log message → [REDACTED:JWT]', () => {
    const seeded = buildSeededPIIEnvelope();
    const { envelope } = applyRedaction(seeded, {});
    const logs = envelope.payload.logs as Array<{ message: string }>;
    const authFailLog = logs.find((l) => l.message.startsWith('Auth failed'));
    expect(authFailLog).toBeTruthy();
    expect(authFailLog!.message).toContain('[REDACTED:JWT]');
    expect(authFailLog!.message).not.toContain(TEST_PII.jwtToken);
  });

  it('CC inline match in log message → [REDACTED:CC]', () => {
    const seeded = buildSeededPIIEnvelope();
    const { envelope } = applyRedaction(seeded, {});
    const logs = envelope.payload.logs as Array<{ message: string }>;
    const cardLog = logs.find((l) => l.message.startsWith('Card '));
    expect(cardLog!.message).toContain('[REDACTED:CC]');
  });

  it('SSN inline match in log message → [REDACTED:SSN]', () => {
    const seeded = buildSeededPIIEnvelope();
    const { envelope } = applyRedaction(seeded, {});
    const logs = envelope.payload.logs as Array<{ message: string }>;
    const ssnLog = logs.find((l) => l.message.startsWith('SSN '));
    expect(ssnLog!.message).toContain('[REDACTED:SSN]');
    expect(ssnLog!.message).not.toContain(TEST_PII.ssn);
  });

  it('customer customRule replaces query-string token via urlParam pattern', () => {
    const seeded = buildSeededPIIEnvelope();
    const { envelope } = applyRedaction(seeded, {
      customRules: [
        { type: 'urlParam', match: /(api_key=)[^&]+/g, replacement: '$1[REDACTED]' },
      ],
    });
    const url = (envelope.payload.network as Array<{ url: string }>)[0]!.url;
    expect(url).not.toContain(TEST_PII.queryToken);
    expect(url).toContain('api_key=[REDACTED]');
  });

  it('default-deny strips aria-label PII from leaf-ish safeProps', () => {
    const seeded = buildSeededPIIEnvelope();
    const { envelope } = applyRedaction(seeded, {});
    const root = UITree.parse(envelope.payload.uiTree).root;
    expect(root.safeProps['aria-label']).toBeUndefined();
  });
});
