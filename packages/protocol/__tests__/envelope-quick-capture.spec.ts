// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { ReportEnvelope } from '../src/envelope.js';
import minimal from './fixtures/v1-minimal.json' with { type: 'json' };

describe('quickCapture', () => {
  it('accepts quickCapture: true and keeps it typed', () => {
    const result = ReportEnvelope.safeParse({ ...minimal, quickCapture: true });
    expect(result.success).toBe(true);
    expect(result.data?.quickCapture).toBe(true);
  });
  it('omitting quickCapture leaves it undefined', () => {
    expect(ReportEnvelope.parse(minimal).quickCapture).toBeUndefined();
  });
  it('rejects a non-boolean quickCapture', () => {
    expect(ReportEnvelope.safeParse({ ...minimal, quickCapture: 'yes' }).success).toBe(false);
  });
});
