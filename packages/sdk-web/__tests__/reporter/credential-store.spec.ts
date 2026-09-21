// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createLocalStorageCredentialStore,
  scopedReporterTokenStorageKey,
  LEGACY_REPORTER_TOKEN_STORAGE_KEY,
  getOrCreateInstallSeed,
  deriveWebInstallId,
  scopedInstallSeedStorageKey,
} from '../../src/reporter/credential-store';
import { createWebPlatformAdapter } from '../../src/adapter';

const SCOPE_A = 'txx_live_appA';
const SCOPE_B = 'txx_live_appB';

afterEach(() => localStorage.clear());

describe('createLocalStorageCredentialStore', () => {
  it('round-trips a token through localStorage under the scoped key', async () => {
    const store = createLocalStorageCredentialStore(SCOPE_A)!;
    expect(await store.load()).toBeNull();
    await store.save('txr_' + 'a'.repeat(43));
    expect(localStorage.getItem(scopedReporterTokenStorageKey(SCOPE_A))).toBe('txr_' + 'a'.repeat(43));
    expect(await store.load()).toBe('txr_' + 'a'.repeat(43));
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it('randomBytes returns the requested length from a CSPRNG', () => {
    const store = createLocalStorageCredentialStore(SCOPE_A)!;
    const bytes = store.randomBytes(32);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(32);
  });

  it('load survives a throwing localStorage (private-mode quota)', async () => {
    const store = createLocalStorageCredentialStore(SCOPE_A)!;
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = () => { throw new Error('denied'); };
    try {
      expect(await store.load()).toBeNull();
    } finally {
      Storage.prototype.getItem = orig;
    }
  });

  // PR review Finding 3: ensureDeviceToken() presents a freshly-minted token to
  // the server before save() returns; the server adopts the token hash on that
  // ingest and never re-echoes it. If localStorage.setItem then throws (quota
  // exceeded, Safari private mode), the token used for ingest must still be
  // readable for the rest of the session — otherwise the next load() returns
  // null, a new token gets minted, and the just-created thread becomes
  // permanently unpollable even though the success toast promised replies.
  it('save() mirrors the token in memory so load() survives a throwing localStorage.setItem', async () => {
    const store = createLocalStorageCredentialStore(SCOPE_A)!;
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error('QuotaExceededError'); };
    const token = 'txr_' + 'c'.repeat(43);
    try {
      await store.save(token);
      // localStorage never actually received the write.
      expect(localStorage.getItem(scopedReporterTokenStorageKey(SCOPE_A))).toBeNull();
      // ... but the in-memory mirror still answers load() for this session.
      expect(await store.load()).toBe(token);
    } finally {
      Storage.prototype.setItem = orig;
    }
  });

  it('clear() also clears the in-memory mirror', async () => {
    const store = createLocalStorageCredentialStore(SCOPE_A)!;
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error('QuotaExceededError'); };
    try {
      await store.save('txr_' + 'd'.repeat(43));
      await store.clear();
      expect(await store.load()).toBeNull();
    } finally {
      Storage.prototype.setItem = orig;
    }
  });

  // PR review Finding 4: the storage key used to be shared by every
  // TraceItX-integrated app on an origin. App B minting a token would
  // overwrite App A's key, orphaning A's threads on return.
  describe('per-app scoping (Finding 4)', () => {
    it('two stores with different scopes never clobber each other', async () => {
      const storeA = createLocalStorageCredentialStore(SCOPE_A)!;
      const storeB = createLocalStorageCredentialStore(SCOPE_B)!;

      const tokenA = 'txr_' + 'a'.repeat(43);
      const tokenB = 'txr_' + 'b'.repeat(43);

      await storeA.save(tokenA);
      expect(await storeA.load()).toBe(tokenA);

      // B mints/saves its own token — must not touch A's key.
      await storeB.save(tokenB);
      expect(await storeB.load()).toBe(tokenB);

      // A→B→A: returning to A must still see A's own token, untouched by B.
      expect(await storeA.load()).toBe(tokenA);
      expect(localStorage.getItem(scopedReporterTokenStorageKey(SCOPE_A))).toBe(tokenA);
      expect(localStorage.getItem(scopedReporterTokenStorageKey(SCOPE_B))).toBe(tokenB);
    });

    it('migrates a legacy unscoped token into the scoped key exactly once, then removes the legacy key', async () => {
      const legacyToken = 'txr_' + 'e'.repeat(43);
      localStorage.setItem(LEGACY_REPORTER_TOKEN_STORAGE_KEY, legacyToken);

      const store = createLocalStorageCredentialStore(SCOPE_A)!;
      expect(await store.load()).toBe(legacyToken);
      expect(localStorage.getItem(scopedReporterTokenStorageKey(SCOPE_A))).toBe(legacyToken);
      expect(localStorage.getItem(LEGACY_REPORTER_TOKEN_STORAGE_KEY)).toBeNull();

      // A second app scope must NOT also adopt the (already-migrated-away) legacy
      // token — it's gone, so a fresh store for a different scope starts empty.
      const otherStore = createLocalStorageCredentialStore(SCOPE_B)!;
      expect(await otherStore.load()).toBeNull();
    });

    it('does not overwrite an existing scoped token with a stale legacy token', async () => {
      const scopedToken = 'txr_' + 'f'.repeat(43);
      const legacyToken = 'txr_' + 'g'.repeat(43);
      localStorage.setItem(scopedReporterTokenStorageKey(SCOPE_A), scopedToken);
      localStorage.setItem(LEGACY_REPORTER_TOKEN_STORAGE_KEY, legacyToken);

      const store = createLocalStorageCredentialStore(SCOPE_A)!;
      expect(await store.load()).toBe(scopedToken);
    });
  });

  // PR review Finding (round 5): on an opaque/sandboxed origin, the
  // `window.localStorage` property GETTER itself throws SecurityError —
  // `typeof localStorage` must evaluate that reference, so a bare
  // (un-try/caught) probe propagated the throw straight out of
  // createLocalStorageCredentialStore() and into createWebPlatformAdapter(),
  // crashing SDK construction for the whole host app. None of the
  // per-operation try/catches below the old guard could ever help — they
  // never got the chance to run.
  describe('opaque/sandboxed origin: localStorage getter throws (Finding 2, round 5)', () => {
    function blockLocalStorage(): () => void {
      const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get(): Storage {
          throw new DOMException('The operation is insecure.', 'SecurityError');
        },
      });
      return () => {
        if (desc) Object.defineProperty(globalThis, 'localStorage', desc);
      };
    }

    it('createLocalStorageCredentialStore does not throw and the returned store round-trips a token in memory', async () => {
      const restore = blockLocalStorage();
      try {
        expect(() => globalThis.localStorage).toThrow();
        let store: ReturnType<typeof createLocalStorageCredentialStore>;
        expect(() => {
          store = createLocalStorageCredentialStore(SCOPE_A);
        }).not.toThrow();
        expect(store!).not.toBeNull();
        const token = 'txr_' + 'z'.repeat(43);
        await expect(store!.save(token)).resolves.toBeUndefined();
        expect(await store!.load()).toBe(token);
      } finally {
        restore();
      }
    });

    it('createWebPlatformAdapter() constructs cleanly when localStorage is blocked', () => {
      const restore = blockLocalStorage();
      try {
        expect(() => createWebPlatformAdapter({ apiKey: 'txx_live_blocked_test' })).not.toThrow();
      } finally {
        restore();
      }
    });
  });
});

// Task 6 (MAI meter): install identifier seed — a seam deliberately SEPARATE
// from the reporter device token above (see credential-store.ts's own
// comment for why: not a secret, and must survive the device token's
// clear()).
describe('install seed (MAI metering)', () => {
  it('getOrCreateInstallSeed is stable across calls for the same scope', () => {
    const first = getOrCreateInstallSeed(SCOPE_A);
    const second = getOrCreateInstallSeed(SCOPE_A);
    expect(first).not.toBeNull();
    expect(Array.from(first!)).toEqual(Array.from(second!));
  });

  it('getOrCreateInstallSeed differs across scopes', () => {
    const a = getOrCreateInstallSeed(SCOPE_A);
    const b = getOrCreateInstallSeed(SCOPE_B);
    expect(Array.from(a!)).not.toEqual(Array.from(b!));
  });

  it('persists the seed under its OWN storage key, distinct from the device-token key', () => {
    getOrCreateInstallSeed(SCOPE_A);
    expect(localStorage.getItem(scopedInstallSeedStorageKey(SCOPE_A))).not.toBeNull();
    expect(localStorage.getItem(scopedReporterTokenStorageKey(SCOPE_A))).toBeNull();
  });

  it('deriveWebInstallId returns a url-safe, bounded, non-empty string', () => {
    const id = deriveWebInstallId(SCOPE_A);
    expect(id).not.toBeNull();
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(id!.length).toBeLessThanOrEqual(128);
  });

  it('deriveWebInstallId is stable across calls for the same scope (same seed ⇒ same id)', () => {
    expect(deriveWebInstallId(SCOPE_A)).toBe(deriveWebInstallId(SCOPE_A));
  });

  it('getOrCreateInstallSeed returns null when localStorage throws', () => {
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error('denied');
    };
    try {
      expect(getOrCreateInstallSeed(SCOPE_A)).toBeNull();
    } finally {
      Storage.prototype.getItem = orig;
    }
  });

  it('deriveWebInstallId returns null (never throws) when localStorage throws', () => {
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error('denied');
    };
    try {
      expect(() => deriveWebInstallId(SCOPE_A)).not.toThrow();
      expect(deriveWebInstallId(SCOPE_A)).toBeNull();
    } finally {
      Storage.prototype.getItem = orig;
    }
  });

  // The load-bearing property from the task brief: a rejected device token
  // (401 ⇒ ReporterCredentialStore.clear()) is NOT a new install, so
  // clear()-ing the device token must never touch the install seed.
  it('device-token store.clear() does not clear the install seed', async () => {
    const seedBefore = getOrCreateInstallSeed(SCOPE_A);
    expect(seedBefore).not.toBeNull();

    const deviceStore = createLocalStorageCredentialStore(SCOPE_A)!;
    await deviceStore.save('txr_' + 'a'.repeat(43));
    await deviceStore.clear();

    expect(localStorage.getItem(scopedReporterTokenStorageKey(SCOPE_A))).toBeNull();
    const seedAfter = getOrCreateInstallSeed(SCOPE_A);
    expect(Array.from(seedAfter!)).toEqual(Array.from(seedBefore!));
  });

  // Finding 4 (2026-08-28 review): several tabs starting with no stored seed
  // used to each mint a DIFFERENT value and each just return its OWN bytes,
  // ignoring storage — the reviewer measured multiple seeds in 90 of 100
  // rounds of a 20-tab probe. The fix reads the seed back immediately after
  // writing it and returns whatever is ACTUALLY stored, so a concurrent
  // write that lands on top of this call's own mint is what this call
  // converges on too — proved here by racing a second, real localStorage
  // write into the gap between this call's `setItem` and its own read-back.
  it('a concurrent write racing between mint and read-back wins — this call converges on it', () => {
    const key = scopedInstallSeedStorageKey(SCOPE_A);
    const realSetItem = Storage.prototype.setItem.bind(localStorage);
    const concurrentSeedHex = 'b'.repeat(32);
    let interleaved = false;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      storedKey: string,
      value: string,
    ) {
      realSetItem(storedKey, value);
      if (storedKey === key && !interleaved) {
        interleaved = true;
        // Simulate a second tab's mint racing in immediately after this
        // tab's own write lands but before its own read-back runs: it also
        // started from "no stored seed", minted its OWN value, and its
        // write lands on top of this tab's — the interleaving Finding 4
        // reproduced across 20 real tabs.
        realSetItem(key, concurrentSeedHex);
      }
    });

    let mintedSeed: Uint8Array | null;
    try {
      mintedSeed = getOrCreateInstallSeed(SCOPE_A);
    } finally {
      spy.mockRestore();
    }

    expect(mintedSeed).not.toBeNull();
    expect(toHex(mintedSeed!)).toBe(concurrentSeedHex);

    // A later reader (another tab, or this same tab's next call) hits the
    // ordinary "already stored" fast path and sees the SAME persisted
    // value — both callers converge on one identifier.
    const laterRead = getOrCreateInstallSeed(SCOPE_A);
    expect(toHex(laterRead!)).toBe(concurrentSeedHex);
  });
});

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}
