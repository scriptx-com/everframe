// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { buildMinified } from './fixtures/minified-build/build.mjs';

describe('PAY-06 success criterion #3: displayName survives terser minification', () => {
  it('Foo (forwardRef) displayName preserved through minification', async () => {
    const { minified } = await buildMinified();
    expect(minified).toMatch(/displayName\s*[:=]\s*["']Foo["']/);
  });

  it('Bar (memo) displayName preserved', async () => {
    const { minified } = await buildMinified();
    expect(minified).toMatch(/displayName\s*[:=]\s*["']Bar["']/);
  });

  it('Baz (memo+forwardRef) displayName preserved', async () => {
    const { minified } = await buildMinified();
    expect(minified).toMatch(/displayName\s*[:=]\s*["']Baz["']/);
  });

  it('Comp (function-decl) displayName preserved', async () => {
    const { minified } = await buildMinified();
    expect(minified).toMatch(/displayName\s*[:=]\s*["']Comp["']/);
  });
});
