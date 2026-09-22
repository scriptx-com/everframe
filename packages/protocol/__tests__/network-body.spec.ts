// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import { describe, it, expect } from 'vitest';
import fixture from './fixtures/network-bodies.v1.json';
import { NetworkBodyEntrySchema, ReportEnvelope } from '../src/index.js';
import minimal from './fixtures/v1-minimal.json';

describe('NetworkBodyEntry schema + parity fixture', () => {
  it('every fixture entry parses against the formal schema', () => {
    const entries = fixture as unknown[];
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(() => NetworkBodyEntrySchema.parse(e)).not.toThrow();
  });

  it('fixture covers truncated + content-type-skipped + unsupported-req + unsupported-res entries', () => {
    const entries = fixture as Array<Record<string, unknown>>;
    expect(entries.some((e) => e.resBodyTruncated === true)).toBe(true);
    expect(entries.some((e) => e.resBodySkipped === 'content-type')).toBe(true);
    expect(entries.some((e) => e.reqBodySkipped === 'unsupported')).toBe(true);
    // Android does not capture response bodies at all (scope reduction,
    // 2026-08-02) and reports every response as 'unsupported' — the fixture
    // carries a representative entry for that shape.
    expect(entries.some((e) => e.resBodySkipped === 'unsupported')).toBe(true);
  });

  it('accepts resBodySkipped: unsupported (Android reports this for every response)', () => {
    expect(() =>
      NetworkBodyEntrySchema.parse({ ref: 1, t: 1, resBodySkipped: 'unsupported' }),
    ).not.toThrow();
  });

  it('rejects an invalid skip reason', () => {
    expect(() => NetworkBodyEntrySchema.parse({ ref: 1, t: 1, resBodySkipped: 'not-a-real-reason' })).toThrow();
    expect(() => NetworkBodyEntrySchema.parse({ ref: 1, t: 1, reqBodySkipped: 'not-a-real-reason' })).toThrow();
  });

  it('payload.networkBodies is typed on the envelope (bad entry rejected)', () => {
    const base = minimal;
    const bad = { ...base, payload: { networkBodies: [{ ref: 'not-a-number', t: 0 }] } };
    expect(ReportEnvelope.safeParse(bad).success).toBe(false);
  });
});
