// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { sha256Hex, sha256HexOfBytes } from '../../src/capture/sha256.js';

// FIPS 180-2 / NIST CAVP vectors.
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const TWO_BLOCK_MSG = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq';
const TWO_BLOCK = '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1';
const MILLION_A = 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0';

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

async function webCryptoHex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const d = await webcrypto.subtle.digest('SHA-256', copy);
  return Buffer.from(d).toString('hex');
}

/** An insecure context: `crypto` exists (getRandomValues) but `subtle` does not. */
function withoutSubtle(): void {
  vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

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
    expect(hex).toBe(EMPTY);
  });

  it('returns hex (lowercase, 0-9 a-f only)', async () => {
    const blob = new Blob(['hello world']);
    const hex = await sha256Hex(blob);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('sha256Hex — pure-JS fallback when crypto.subtle is missing', () => {
  it('matches the NIST vectors with crypto.subtle undefined', async () => {
    withoutSubtle();
    expect(crypto.subtle).toBeUndefined();
    expect(await sha256HexOfBytes(new Uint8Array(0))).toBe(EMPTY);
    expect(await sha256HexOfBytes(ascii('abc'))).toBe(ABC);
    expect(await sha256HexOfBytes(ascii(TWO_BLOCK_MSG))).toBe(TWO_BLOCK);
    expect(await sha256HexOfBytes(new Uint8Array(1_000_000).fill(0x61))).toBe(MILLION_A);
  });

  it('hashes a Blob through the fallback (the screenshot / page-snapshot path)', async () => {
    withoutSubtle();
    expect(await sha256Hex(new Blob(['abc']))).toBe(ABC);
  });

  it('works with no crypto global at all', async () => {
    vi.stubGlobal('crypto', undefined);
    expect(await sha256HexOfBytes(ascii('abc'))).toBe(ABC);
  });

  it('falls back when crypto.subtle.digest throws or rejects', async () => {
    vi.stubGlobal('crypto', { subtle: { digest: () => { throw new Error('SecurityError'); } } });
    expect(await sha256HexOfBytes(ascii('abc'))).toBe(ABC);
    vi.stubGlobal('crypto', { subtle: { digest: () => Promise.reject(new Error('NotSupportedError')) } });
    expect(await sha256HexOfBytes(ascii('abc'))).toBe(ABC);
  });

  it('hashes only the view, not the whole underlying buffer', async () => {
    withoutSubtle();
    const backing = ascii('xxabcxx');
    expect(await sha256HexOfBytes(backing.subarray(2, 5))).toBe(ABC);
  });

  it('is byte-identical to WebCrypto on random buffers (block-boundary sizes included)', async () => {
    const sizes = [1, 31, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 4096, 70_001];
    const inputs = sizes.map((n) => {
      const b = new Uint8Array(n);
      for (let i = 0; i < n; i += 65536) webcrypto.getRandomValues(b.subarray(i, Math.min(n, i + 65536)));
      return b;
    });
    const expected = await Promise.all(inputs.map(webCryptoHex));
    withoutSubtle();
    const fallback = await Promise.all(inputs.map((b) => sha256HexOfBytes(b)));
    expect(fallback).toEqual(expected);
  });
});

describe('sha256Hex — Web Crypto path', () => {
  it('uses crypto.subtle when present and returns lowercase hex', async () => {
    const digest = vi.fn((alg: string, data: BufferSource) => webcrypto.subtle.digest(alg, data));
    vi.stubGlobal('crypto', { subtle: { digest } });
    expect(await sha256Hex(new Blob(['abc']))).toBe(ABC);
    expect(digest).toHaveBeenCalledTimes(1);
  });
});
