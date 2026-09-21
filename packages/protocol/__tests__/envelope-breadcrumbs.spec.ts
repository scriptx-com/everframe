// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { ReportEnvelope } from '../src/index.js';
import withBreadcrumbs from './fixtures/v1-with-breadcrumbs.json';
import minimal from './fixtures/v1-minimal.json';

describe('payload.breadcrumbs (additive)', () => {
  it('parses the golden fixture with breadcrumbs', () => {
    const result = ReportEnvelope.safeParse(withBreadcrumbs);
    if (!result.success) console.error(JSON.stringify(result.error, null, 2));
    expect(result.success).toBe(true);
  });

  it('still parses a pre-breadcrumb envelope (no breadcrumbs, five-boolean captures)', () => {
    expect(ReportEnvelope.safeParse(minimal).success).toBe(true);
  });

  it('rejects a chain over 128 entries', () => {
    const fixture = JSON.parse(JSON.stringify(withBreadcrumbs)) as Record<string, any>;
    fixture.payload.breadcrumbs = Array.from({ length: 129 }, (_, i) => ({
      t: 1751884800000 + i, seq: i, kind: 'tap', message: `tap ${i}`,
    }));
    expect(ReportEnvelope.safeParse(fixture).success).toBe(false);
  });

  it('rejects a crumb with an unknown kind inside the envelope', () => {
    const fixture = JSON.parse(JSON.stringify(withBreadcrumbs)) as Record<string, any>;
    fixture.payload.breadcrumbs[0].kind = 'scroll';
    expect(ReportEnvelope.safeParse(fixture).success).toBe(false);
  });
});
