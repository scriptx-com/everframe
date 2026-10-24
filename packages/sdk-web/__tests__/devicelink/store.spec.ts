// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeviceLinkStore } from '../../src/devicelink/store.js';
import { deviceLinkScope } from '../../src/devicelink/token.js';

const SCOPE = deviceLinkScope('https://everframe.dev', 'key-1')!;
const OTHER_SCOPE = deviceLinkScope('https://everframe.dev', 'key-2')!;
const TOKEN = 'evf_dev_' + 'A'.repeat(32);
const TOKEN_2 = 'evf_dev_' + 'B'.repeat(32);
const KEY = `everframe.deviceLink.v1.${SCOPE.slice(0, 32)}`;

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('device link store', () => {
  it('round-trips a link', () => {
    const store = createDeviceLinkStore(SCOPE);
    expect(store.scope).toBe(SCOPE);
    expect(store.load()).toBeNull();
    expect(store.save(TOKEN, { kind: 'user', name: 'Aurimas' })).toBe(true);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({
      v: 1,
      s: SCOPE,
      t: TOKEN,
      o: { kind: 'user', name: 'Aurimas' },
    });
    // A fresh store (a reload) reads it back.
    const again = createDeviceLinkStore(SCOPE);
    expect(again.load()).toEqual({
      token: TOKEN,
      owner: { kind: 'user', name: 'Aurimas' },
      scope: SCOPE,
    });
  });

  it('refuses to save an invalid token', () => {
    const store = createDeviceLinkStore(SCOPE);
    expect(store.save('evf_cap_' + 'a'.repeat(32), { kind: 'team' })).toBe(false);
    expect(store.load()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('a link saved under another scope is neither loaded nor deleted', () => {
    const foreign = JSON.stringify({ v: 1, s: OTHER_SCOPE, t: TOKEN, o: { kind: 'team' } });
    localStorage.setItem(KEY, foreign);
    const store = createDeviceLinkStore(SCOPE);
    expect(store.load()).toBeNull();
    expect(store.clear()).toBe(false);
    expect(store.clear(TOKEN)).toBe(false);
    expect(localStorage.getItem(KEY)).toBe(foreign);
  });

  it('corrupt JSON or an invalid token is deleted on load', () => {
    for (const raw of [
      '{not json',
      JSON.stringify({ v: 1, s: SCOPE, t: 'evf_dev_short', o: { kind: 'team' } }),
      JSON.stringify({ v: 1, s: SCOPE, t: TOKEN, o: { kind: 'nobody' } }),
      JSON.stringify({ v: 2, s: SCOPE, t: TOKEN, o: { kind: 'team' } }),
      JSON.stringify(null),
    ]) {
      localStorage.setItem(KEY, raw);
      const store = createDeviceLinkStore(SCOPE);
      expect(store.load()).toBeNull();
      expect(localStorage.getItem(KEY)).toBeNull();
    }
  });

  it('clear(onlyIfToken) keeps a different token', () => {
    const store = createDeviceLinkStore(SCOPE);
    store.save(TOKEN, { kind: 'team' });
    expect(store.clear(TOKEN_2)).toBe(false);
    expect(store.load()?.token).toBe(TOKEN);
    expect(store.clear(TOKEN)).toBe(true);
    expect(store.load()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
    // Nothing left to clear.
    expect(store.clear()).toBe(false);
  });

  it('updateOwner changes only the stored token', () => {
    const store = createDeviceLinkStore(SCOPE);
    store.save(TOKEN, { kind: 'user', name: 'Old' });
    store.updateOwner(TOKEN_2, { kind: 'team' });
    expect(store.load()?.owner).toEqual({ kind: 'user', name: 'Old' });
    store.updateOwner(TOKEN, { kind: 'user', name: 'New' });
    expect(store.load()?.owner).toEqual({ kind: 'user', name: 'New' });
    expect(createDeviceLinkStore(SCOPE).load()?.owner).toEqual({ kind: 'user', name: 'New' });
  });

  it('two SDK keys on one origin keep separate links', () => {
    const a = createDeviceLinkStore(SCOPE);
    const b = createDeviceLinkStore(OTHER_SCOPE);
    a.save(TOKEN, { kind: 'team' });
    b.save(TOKEN_2, { kind: 'user', name: 'B' });
    expect(a.load()?.token).toBe(TOKEN);
    expect(b.load()?.token).toBe(TOKEN_2);
    a.clear();
    expect(a.load()).toBeNull();
    expect(b.load()?.token).toBe(TOKEN_2);
  });

  it('storage that throws on every call keeps the link in memory for the session', () => {
    const store = createDeviceLinkStore(SCOPE, () => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(store.save(TOKEN, { kind: 'team' })).toBe(true);
    expect(store.load()?.token).toBe(TOKEN);
    expect(() => store.clear()).not.toThrow();
    expect(store.load()).toBeNull();
  });

  it('storage whose methods throw keeps the link in memory too', () => {
    const throwing = {
      getItem: () => {
        throw new Error('quota');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('quota');
      },
    } as unknown as Storage;
    const store = createDeviceLinkStore(SCOPE, () => throwing);
    expect(store.load()).toBeNull();
    expect(store.save(TOKEN, { kind: 'team' })).toBe(true);
    expect(store.load()?.token).toBe(TOKEN);
    expect(store.clear(TOKEN)).toBe(true);
    expect(store.load()).toBeNull();
  });

  it('never writes the token to the console', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    localStorage.setItem(KEY, '{broken');
    const store = createDeviceLinkStore(SCOPE);
    store.load();
    store.save(TOKEN, { kind: 'team' });
    store.updateOwner(TOKEN, { kind: 'user', name: 'X' });
    store.load();
    store.clear(TOKEN_2);
    store.clear(TOKEN);
    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain('evf_dev_');
      }
    }
  });
});
