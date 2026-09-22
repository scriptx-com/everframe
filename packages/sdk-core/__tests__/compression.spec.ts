// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect, vi, afterEach } from 'vitest';
import { gzipBytes } from '../src/transport/compression.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('gzipBytes', () => {
  it('produces output starting with gzip magic bytes 0x1f 0x8b', async () => {
    const input = new TextEncoder().encode('hello world '.repeat(100));
    const out = await gzipBytes(input);
    expect(out[0]).toBe(0x1f);
    expect(out[1]).toBe(0x8b);
  });

  it('falls back to fflate when CompressionStream is undefined (Hermes path)', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    const input = new TextEncoder().encode('hello world '.repeat(100));
    const out = await gzipBytes(input);
    expect(out[0]).toBe(0x1f);
    expect(out[1]).toBe(0x8b);
  });
});
