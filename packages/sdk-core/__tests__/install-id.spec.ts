// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { deriveInstallId } from '../src/install-id.js';

describe('deriveInstallId', () => {
  it('is stable for the same seed', () => {
    const seed = new Uint8Array([1, 2, 3, 4]);
    expect(deriveInstallId(seed)).toBe(deriveInstallId(seed));
  });

  it('differs for different seeds', () => {
    expect(deriveInstallId(new Uint8Array([1]))).not.toBe(deriveInstallId(new Uint8Array([2])));
  });

  it('is url-safe and bounded, so it can ride a query string', () => {
    const id = deriveInstallId(new Uint8Array([1, 2, 3]));
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(id.length).toBeLessThanOrEqual(128);
  });

  it('does not leak the seed', () => {
    const id = deriveInstallId(new Uint8Array([9, 9, 9, 9]));
    expect(id).not.toContain('9,9,9,9');
  });
});
