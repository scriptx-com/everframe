// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/capture/sha256.js';

describe('sha256Hex', () => {
  it('matches known SHA-256 of bytes [1,2,3]', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    const hex = await sha256Hex(blob);
    expect(hex).toBe('039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81');
  });

  it('returns 64 lowercase hex chars for empty blob', async () => {
    const blob = new Blob([]);
    const hex = await sha256Hex(blob);
    expect(hex).toHaveLength(64);
    expect(hex).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('returns hex (lowercase, 0-9 a-f only)', async () => {
    const blob = new Blob(['hello world']);
    const hex = await sha256Hex(blob);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });
});
