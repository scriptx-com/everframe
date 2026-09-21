// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it, vi, afterEach } from 'vitest';
import { readBlobArrayBuffer } from '../../src/internal/blob.js';

afterEach(() => vi.unstubAllGlobals());
describe('legacy Blob reads', () => {
  it('uses the native method when present', async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const native = vi.fn(async () => bytes);
    expect(await readBlobArrayBuffer({ arrayBuffer: native } as unknown as Blob)).toBe(bytes);
    expect(native).toHaveBeenCalledOnce();
  });

  for (const outcome of ['load', 'error', 'abort'] as const) {
    it(`settles the FileReader ${outcome} path when arrayBuffer is absent`, async () => {
      const bytes = new Uint8Array([4, 5, 6]).buffer;
      const failure = new Error('read failed');
      const input = {} as Blob;
      const read = vi.fn();
      vi.stubGlobal('FileReader', class {
        result = bytes;
        error = failure;
        onload?: () => void;
        onerror?: () => void;
        onabort?: () => void;
        readAsArrayBuffer(blob: Blob) { read(blob); queueMicrotask(() => this[`on${outcome}`]?.()); }
      });
      const result = readBlobArrayBuffer(input);
      if (outcome === 'load') expect(await result).toBe(bytes);
      else if (outcome === 'error') await expect(result).rejects.toBe(failure);
      else await expect(result).rejects.toThrow(/abort/i);
      expect(read).toHaveBeenCalledWith(input);
    });
  }
});
