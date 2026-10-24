// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { createLinkStore, LINK_STORAGE_KEY, type StoredLink } from '../src/link-store.js';
import { createStorage } from './fakes.js';

const TOKEN = 'evf_dev_' + 'a1B2'.repeat(8);
const SCOPE = 'a'.repeat(64);
const LINK: StoredLink = { token: TOKEN, owner: { kind: 'user', name: 'Aurimas' }, scope: SCOPE };

describe('link store', () => {
  it('savedLinkSurvivesANewStore', async () => {
    const storage = createStorage();
    expect(await createLinkStore(storage).save(LINK)).toBe(true);
    expect(await createLinkStore(storage).load(SCOPE)).toEqual(LINK);
    const raw = JSON.parse(storage.data.get(LINK_STORAGE_KEY)!);
    expect(raw).toEqual({ v: 1, s: SCOPE, t: TOKEN, o: { kind: 'user', name: 'Aurimas' } });
  });

  it('otherScopeReadsNullAndKeepsRecord', async () => {
    const storage = createStorage();
    const store = createLinkStore(storage);
    await store.save(LINK);
    expect(await store.load('b'.repeat(64))).toBeNull();
    expect(storage.data.get(LINK_STORAGE_KEY)).toContain(SCOPE);
    expect(await store.load(SCOPE)).toEqual(LINK);
  });

  it('clearWritesEmpty', async () => {
    const storage = createStorage();
    const store = createLinkStore(storage);
    await store.save(LINK);
    await store.clear();
    expect(storage.data.get(LINK_STORAGE_KEY)).toBe('');
    expect(await store.load(SCOPE)).toBeNull();
  });

  it('corruptRecordReadsNullAndIsCleared', async () => {
    const bad = [
      '{',
      '[]',
      'null',
      JSON.stringify({ v: 2, s: SCOPE, t: TOKEN, o: { kind: 'team' } }),
      JSON.stringify({ v: 1, s: SCOPE, t: 'evf_dev_x', o: { kind: 'team' } }),
      JSON.stringify({ v: 1, s: SCOPE, t: TOKEN, o: { kind: 'user' } }),
      JSON.stringify({ v: 1, s: 42, t: TOKEN, o: { kind: 'team' } }),
    ];
    for (const value of bad) {
      const storage = createStorage();
      storage.data.set(LINK_STORAGE_KEY, value);
      const store = createLinkStore(storage);
      await expect(store.load(SCOPE)).resolves.toBeNull();
      expect(storage.data.get(LINK_STORAGE_KEY)).toBe('');
    }
  });

  it('emptyRecordReadsNullWithoutWriting', async () => {
    const storage = createStorage();
    storage.data.set(LINK_STORAGE_KEY, '');
    expect(await createLinkStore(storage).load(SCOPE)).toBeNull();
    expect(storage.writes).toEqual([]);
  });

  it('rejectingStorageReadsNullAndSaveIsFalse', async () => {
    const storage = {
      getItem: async () => {
        throw new Error('boom');
      },
      setItem: async () => {
        throw new Error('boom');
      },
    };
    const store = createLinkStore(storage);
    await expect(store.load(SCOPE)).resolves.toBeNull();
    await expect(store.save(LINK)).resolves.toBe(false);
    await expect(store.clear()).resolves.toBeUndefined();
  });

  it('synchronouslyThrowingStorageNeverThrows', async () => {
    const storage = {
      getItem: () => {
        throw new Error('sync');
      },
      setItem: () => {
        throw new Error('sync');
      },
    } as never;
    const store = createLinkStore(storage);
    await expect(store.load(SCOPE)).resolves.toBeNull();
    await expect(store.save(LINK)).resolves.toBe(false);
    await expect(store.clear()).resolves.toBeUndefined();
  });

  it('saveRefusesInvalidToken', async () => {
    const storage = createStorage();
    const store = createLinkStore(storage);
    expect(await store.save({ ...LINK, token: 'evf_dev_x' })).toBe(false);
    expect(await store.save({ ...LINK, owner: { kind: 'boss' } as never })).toBe(false);
    expect(await store.save({ ...LINK, scope: '' })).toBe(false);
    expect(storage.writes).toEqual([]);
  });

  it('worksInMemoryWithoutStorage', async () => {
    const store = createLinkStore(undefined);
    expect(await store.load(SCOPE)).toBeNull();
    expect(await store.save(LINK)).toBe(true);
    expect(await store.load(SCOPE)).toEqual(LINK);
    expect(await store.load('b'.repeat(64))).toBeNull();
    await store.clear();
    expect(await store.load(SCOPE)).toBeNull();
  });
});
