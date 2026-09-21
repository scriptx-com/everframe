// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { Breadcrumb, BreadcrumbKind } from '../src/index.js';

const base = { t: 1751884800000, seq: 0, kind: 'tap', message: 'Pressed CheckoutButton' };

describe('Breadcrumb schema', () => {
  it('parses a minimal crumb (t, seq, kind, message)', () => {
    expect(Breadcrumb.safeParse(base).success).toBe(true);
  });

  it('parses a full crumb with level, data, truncated', () => {
    const full = {
      ...base,
      kind: 'network',
      level: 'warn',
      message: 'GET /api/cart 500',
      data: { method: 'GET', url: '/api/cart', status: 500, durationMs: 132 },
      truncated: true,
    };
    expect(Breadcrumb.safeParse(full).success).toBe(true);
  });

  it('enumerates exactly the seven kinds', () => {
    expect(BreadcrumbKind.options).toEqual([
      'navigation', 'tap', 'console', 'network', 'lifecycle', 'error', 'custom',
    ]);
  });

  it('rejects an unknown kind', () => {
    expect(Breadcrumb.safeParse({ ...base, kind: 'scroll' }).success).toBe(false);
  });

  it('rejects a message over the 2048 ceiling', () => {
    expect(Breadcrumb.safeParse({ ...base, message: 'x'.repeat(2049) }).success).toBe(false);
  });

  it('rejects a negative or non-integer seq', () => {
    expect(Breadcrumb.safeParse({ ...base, seq: -1 }).success).toBe(false);
    expect(Breadcrumb.safeParse({ ...base, seq: 1.5 }).success).toBe(false);
  });

  it('preserves unknown fields (passthrough, additive doctrine)', () => {
    const parsed = Breadcrumb.parse({ ...base, futureField: 'kept' }) as Record<string, unknown>;
    expect(parsed['futureField']).toBe('kept');
  });

  it('parses a trim marker (droppedCount discriminator)', () => {
    const marker = {
      t: 1751884800001, seq: 3, kind: 'console', level: 'info',
      message: '+42 console hidden', data: { droppedCount: 42 },
    };
    expect(Breadcrumb.safeParse(marker).success).toBe(true);
  });
});
