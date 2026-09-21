// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { ReportEnvelope } from '../src/index.js';

// Build the minimal valid envelope the same way the existing envelope specs
// do — copy the fixture/helper from packages/protocol/__tests__/ (look for
// the spec that parses a full ReportEnvelope and reuse its base object).
import { baseEnvelope } from './helpers/base-envelope.js'; // create if absent, extracted from an existing spec's fixture

describe('envelope vitals additions', () => {
  it('accepts an envelope without sessionId/vitals (backward compat)', () => {
    expect(() => ReportEnvelope.parse(baseEnvelope())).not.toThrow();
  });
  it('accepts sessionId + payload.vitals', () => {
    const env = baseEnvelope();
    env.sessionId = '3b2e2f9a-1111-4222-8333-944444444444';
    env.payload.vitals = [{ kind: 'player', t: 1, type: 'play' }];
    const parsed = ReportEnvelope.parse(env);
    expect(parsed.sessionId).toBe(env.sessionId);
    expect(parsed.payload.vitals).toHaveLength(1);
  });
  it('rejects a non-uuid sessionId', () => {
    const env = baseEnvelope();
    env.sessionId = 'not-a-uuid';
    expect(() => ReportEnvelope.parse(env)).toThrow();
  });
});
