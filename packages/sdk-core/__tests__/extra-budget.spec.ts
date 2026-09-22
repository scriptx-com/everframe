// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { budgetExtra, EXTRA_MAX_CHARS } from '../src/extra-budget.js';

const parse = (s: string | null) => JSON.parse(s as string) as Record<string, unknown>;

describe('budgetExtra', () => {
  it('returns the object unchanged when it already fits', () => {
    expect(parse(budgetExtra({ a: 1, b: 'two' }))).toEqual({ a: 1, b: 'two' });
  });

  it('fits a payload that would have exceeded the old 2000-char cap but fits the new 16 KiB one', () => {
    const value = { blob: 'y'.repeat(10_000) };
    const out = budgetExtra(value);
    expect(out).not.toBeNull();
    expect(parse(out)).toEqual(value);
  });

  it('returns null (omit) when the serialized object exceeds EXTRA_MAX_CHARS', () => {
    const value = { blob: 'y'.repeat(EXTRA_MAX_CHARS * 2) };
    expect(budgetExtra(value)).toBeNull();
  });

  it('returns null for a value that cannot serialize at all (cyclic reference)', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(budgetExtra({ a: 'x', bad: cyclic })).toBeNull();
  });
});
