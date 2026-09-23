// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect, vi } from 'vitest';
import {
  DEVICE_TOKEN_BYTES,
  DEVICE_TOKEN_LENGTH,
  DEVICE_TOKEN_PREFIX,
  ensureDeviceToken,
  generateDeviceToken,
  isWellFormedDeviceToken,
} from '../src/reporter/device-token.js';
import type { ReporterCredentialStore } from '../src/types/platform.js';

/** Deterministic entropy — the point under test is encoding, not randomness. */
const bytes = (fill: number) => (n: number) => new Uint8Array(n).fill(fill);
const realRandom = (n: number) => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) out[i] = (i * 37 + 11) % 256;
  return out;
};

function memoryStore(initial: string | null = null): ReporterCredentialStore & {
  value: string | null;
} {
  const store = {
    value: initial,
    randomBytes: realRandom,
    async load() {
      return store.value;
    },
    async save(token: string) {
      store.value = token;
    },
    async clear() {
      store.value = null;
    },
  };
  return store;
}

describe('reporter device token (client-minted)', () => {
  it('uses the fresh Everframe reporter credential prefix', () => {
    expect(DEVICE_TOKEN_PREFIX).toBe('evr_');
  });

  it('emits the server-accepted shape', () => {
    const token = generateDeviceToken(realRandom);
    expect(token.startsWith(DEVICE_TOKEN_PREFIX)).toBe(true);
    expect(token).toHaveLength(DEVICE_TOKEN_LENGTH);
    expect(isWellFormedDeviceToken(token)).toBe(true);
  });

  it('encodes base64url with no padding and no + or /', () => {
    // 0xFF/0xFB bytes are what produce `+` and `/` in standard base64; if the
    // encoder were standard rather than URL-safe, the token would be rejected
    // by the server's charset check and, worse, mangled in a header.
    for (const fill of [0x00, 0x3e, 0xfb, 0xff]) {
      const token = generateDeviceToken(bytes(fill));
      expect(token.slice(DEVICE_TOKEN_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(token).not.toContain('=');
    }
  });

  it('refuses a short read from the entropy source rather than padding it', () => {
    // A silently-truncated CSPRNG read is the one failure that would produce a
    // weak credential and never surface.
    expect(() => generateDeviceToken(() => new Uint8Array(8))).toThrow(/entropy source/);
  });

  it('asks the platform for exactly 32 bytes', () => {
    const spy = vi.fn(realRandom);
    generateDeviceToken(spy);
    expect(spy).toHaveBeenCalledWith(DEVICE_TOKEN_BYTES);
  });

  it.each([
    ['too short', `${DEVICE_TOKEN_PREFIX}abc`],
    ['too long', `${DEVICE_TOKEN_PREFIX}${'a'.repeat(44)}`],
    ['wrong prefix', `txs_${'a'.repeat(43)}`],
    ['bad charset', `${DEVICE_TOKEN_PREFIX}${'a'.repeat(42)}+`],
    ['empty', ''],
  ])('rejects a %s token', (_label, bad) => {
    expect(isWellFormedDeviceToken(bad)).toBe(false);
  });

  describe('ensureDeviceToken', () => {
    it('mints and persists on a fresh install', async () => {
      const store = memoryStore();
      const token = await ensureDeviceToken(store);
      expect(isWellFormedDeviceToken(token)).toBe(true);
      expect(store.value).toBe(token);
    });

    it('is idempotent — the device keeps one identity across launches', async () => {
      const store = memoryStore();
      const first = await ensureDeviceToken(store);
      const second = await ensureDeviceToken(store);
      expect(second).toBe(first);
    });

    it('replaces a corrupted stored value instead of presenting it', async () => {
      // The server refuses to adopt a malformed token and mints over it, so
      // presenting one buys nothing; replacing locally keeps client and server
      // agreeing on which token is current.
      const store = memoryStore('evr_truncated');
      const token = await ensureDeviceToken(store);
      expect(token).not.toBe('evr_truncated');
      expect(isWellFormedDeviceToken(token)).toBe(true);
      expect(store.value).toBe(token);
    });

    // Finding 4-SDK: ensureDeviceToken was an unlocked load->mint->save
    // sequence. Mount, online, post-submit and crash drains plus manual
    // submits can overlap; two concurrent calls against one empty store each
    // saw no stored token, each minted their own, and only the SECOND save
    // won — orphaning the first conversation under a token nothing ever
    // reads again. Concurrent callers against the SAME store must share one
    // in-flight mint and all resolve to the identical token, with exactly
    // one save().
    it('serializes concurrent initialization: two concurrent calls on one empty store share a single mint and save', async () => {
      const store = memoryStore();
      let saveCalls = 0;
      const rawSave = store.save.bind(store);
      store.save = async (t: string) => {
        saveCalls += 1;
        await rawSave(t);
      };
      const [a, b] = await Promise.all([ensureDeviceToken(store), ensureDeviceToken(store)]);
      expect(a).toBe(b);
      expect(isWellFormedDeviceToken(a)).toBe(true);
      expect(saveCalls).toBe(1);
      expect(store.value).toBe(a);
    });

    it('a rejected mint does not poison a subsequent successful call for the same store', async () => {
      const store = memoryStore();
      let shouldFail = true;
      const rawRandom = store.randomBytes;
      store.randomBytes = (n: number) => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error('entropy source unavailable');
        }
        return rawRandom(n);
      };
      await expect(ensureDeviceToken(store)).rejects.toThrow('entropy source unavailable');
      // The failed attempt must not leave the store locked forever.
      const token = await ensureDeviceToken(store);
      expect(isWellFormedDeviceToken(token)).toBe(true);
      expect(store.value).toBe(token);
    });

    it('two different stores mint independently, even when called concurrently', async () => {
      const storeA = memoryStore();
      const storeB = memoryStore();
      // Distinct entropy per store so a collision would prove the two
      // mints aren't actually independent, rather than just being two
      // stores that happened to share deterministic test randomness.
      storeB.randomBytes = bytes(0x7a);
      const [a, b] = await Promise.all([ensureDeviceToken(storeA), ensureDeviceToken(storeB)]);
      expect(a).not.toBe(b);
      expect(storeA.value).toBe(a);
      expect(storeB.value).toBe(b);
    });
  });
});
