// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { ReportEnvelope } from '../src/index.js';
import additive from './fixtures/v1-additive.json';
import crashCauses from './fixtures/crash-causes.json';

describe('PAY-01 additive compatibility', () => {
  it('parses v1-additive (unknown fields tolerated)', () => {
    const result = ReportEnvelope.safeParse(additive);
    if (!result.success) console.error(JSON.stringify(result.error, null, 2));
    expect(result.success).toBe(true);
  });

  it('preserves unknown top-level fields on parse (passthrough)', () => {
    const parsed = ReportEnvelope.parse(additive) as Record<string, unknown>;
    expect(parsed['futureFieldX']).toBe('this is not in v1 schema');
  });

  it('preserves unknown nested fields on parse (passthrough)', () => {
    const parsed = ReportEnvelope.parse(additive) as Record<string, unknown>;
    const sdk = parsed['sdk'] as Record<string, unknown>;
    expect(sdk['futureSdkField']).toBe('x');
  });

  it('keeps pre-details envelopes byte-shape compatible', () => {
    const parsed = ReportEnvelope.parse(additive);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(additive);
  });

  it('keeps causeChain absent on an older crash payload', () => {
    const parsed = ReportEnvelope.parse(additive);
    expect(parsed.payload.crash?.causeChain).toBeUndefined();
  });

  it('preserves an additive causeChain on a newer crash payload', () => {
    const withCause = {
      ...additive,
      payload: { ...additive.payload, crash: crashCauses },
    };

    const parsed = ReportEnvelope.parse(withCause);

    expect(parsed.payload.crash?.causeChain).toEqual(crashCauses.causeChain);
  });
});
