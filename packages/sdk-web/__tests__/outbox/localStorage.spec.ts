// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLocalStorageOutbox,
  KEY_PREFIX,
  QUOTA_BYTES,
} from '../../src/outbox/localStorage.js';
import { createOutbox, __resetOutboxWarnLatchForTesting } from '../../src/outbox/index.js';

const sampleItem = (id: string, enqueuedAt: number, payloadBytes = 32) => ({
  reportId: id,
  enqueuedAt,
  attempts: 0,
  payload: new Uint8Array(payloadBytes).fill(0xab),
  metadata: { 'x-test': '1' },
});

describe('createLocalStorageOutbox', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('returns non-null OutboxAdapter when localStorage available', () => {
    expect(createLocalStorageOutbox()).not.toBeNull();
  });

  it('enqueue + list round-trip preserves payload bytes', async () => {
    const ob = createLocalStorageOutbox()!;
    await ob.enqueue(sampleItem('rep-1', 1000));
    const list = await ob.list();
    expect(list.length).toBe(1);
    expect(list[0]!.reportId).toBe('rep-1');
    expect(list[0]!.payload).toBeInstanceOf(Uint8Array);
    expect(list[0]!.payload.length).toBe(32);
    expect(Array.from(list[0]!.payload)).toEqual(Array.from(new Uint8Array(32).fill(0xab)));
  });

  it('list() iterates only keys with traceitx:outbox: prefix; sorts by enqueuedAt asc', async () => {
    localStorage.setItem('unrelated:key', 'noise');
    const ob = createLocalStorageOutbox()!;
    await ob.enqueue(sampleItem('rep-3', 3000));
    await ob.enqueue(sampleItem('rep-1', 1000));
    await ob.enqueue(sampleItem('rep-2', 2000));
    const list = await ob.list();
    expect(list.map((i) => i.reportId)).toEqual(['rep-1', 'rep-2', 'rep-3']);
  });

  it('delete(reportId) removes the corresponding entry', async () => {
    const ob = createLocalStorageOutbox()!;
    await ob.enqueue(sampleItem('rep-x', 100));
    await ob.delete('rep-x');
    expect(await ob.list()).toEqual([]);
    expect(localStorage.getItem(KEY_PREFIX + 'rep-x')).toBeNull();
  });

  it('evicts oldest first when enqueue would exceed QUOTA', async () => {
    const ob = createLocalStorageOutbox()!;
    // Use a large payload such that 3 entries fit but a 4th evicts the oldest.
    const bigPayloadSize = Math.floor(QUOTA_BYTES / 4); // ~1.25 MB, base64 inflates to ~1.66 MB
    await ob.enqueue(sampleItem('a', 1, bigPayloadSize));
    await ob.enqueue(sampleItem('b', 2, bigPayloadSize));
    await ob.enqueue(sampleItem('c', 3, bigPayloadSize));
    await ob.enqueue(sampleItem('d', 4, bigPayloadSize)); // should evict 'a'
    const list = await ob.list();
    expect(list.map((i) => i.reportId)).not.toContain('a');
    expect(list.map((i) => i.reportId)).toContain('d');
  });

  it('returns null when localStorage probe throws', () => {
    const origSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new DOMException('Quota', 'QuotaExceededError');
    };
    try {
      expect(createLocalStorageOutbox()).toBeNull();
    } finally {
      Storage.prototype.setItem = origSetItem;
    }
  });
});

describe('createOutbox factory', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetOutboxWarnLatchForTesting();
  });
  afterEach(() => {
    localStorage.clear();
    __resetOutboxWarnLatchForTesting();
  });

  it('returns localStorage-backed outbox when available', async () => {
    const ob = createOutbox();
    await ob.enqueue(sampleItem('a', 1));
    // localStorage should now contain a key with our prefix
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) keys.push(k);
    }
    expect(keys.some((k) => k.startsWith(KEY_PREFIX))).toBe(true);
  });

  it('falls back to in-memory + warns ONCE per session when localStorage unavailable', async () => {
    const origSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('blocked');
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const ob1 = createOutbox();
      const ob2 = createOutbox();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      // Both ob1 and ob2 are in-memory instances; they don't share storage.
      await ob1.enqueue(sampleItem('m1', 1));
      expect((await ob1.list()).length).toBe(1);
      expect((await ob2.list()).length).toBe(0);
    } finally {
      Storage.prototype.setItem = origSetItem;
    }
  });
});
