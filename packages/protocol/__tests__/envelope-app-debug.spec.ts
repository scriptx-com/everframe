// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { ReportEnvelope } from '../src/envelope.js';
import minimal from './fixtures/v1-minimal.json' with { type: 'json' };

const withApp = (extra: Record<string, unknown>) => ({
  ...minimal,
  context: { ...minimal.context, app: { ...minimal.context.app, ...extra } },
});

describe('context.app.debug', () => {
  it('accepts a boolean and keeps it typed', () => {
    expect(ReportEnvelope.parse(withApp({ debug: true })).context.app.debug).toBe(true);
    expect(ReportEnvelope.parse(withApp({ debug: false })).context.app.debug).toBe(false);
  });
  it('is optional', () => {
    expect(ReportEnvelope.parse(minimal).context.app.debug).toBeUndefined();
  });
  it('rejects a non-boolean', () => {
    expect(() => ReportEnvelope.parse(withApp({ debug: 'yes' }))).toThrow();
  });
});
