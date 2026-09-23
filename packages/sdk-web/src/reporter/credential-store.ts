// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Web ReporterCredentialStore: the reporter device token in localStorage.
// Documented trust boundary (design spec): a shared browser profile shares
// thread history — same as any logged-out web session; the signed-identity
// path (phase 4) is the remedy. Every access is try/caught because Safari
// private mode and storage-partitioned iframes throw on touch; a store that
// cannot persist quietly degrades to "server mints per submit".
import type { ReporterCredentialStore } from '@everframe/sdk-core';
import { deriveInstallId } from '@everframe/sdk-core';

/**
 * Legacy (pre-scoping) storage key. localStorage is origin-scoped, not
 * app-scoped: multiple Everframe-integrated apps on the same origin (or
 * multiple environments served off one domain) used to share this single
 * key, so app B's mint would silently overwrite app A's token and orphan
 * A's threads (PR review Finding 4). Kept around ONLY as the source for the
 * one-time migration below and as the legacy fallback name in tests.
 */
export const LEGACY_REPORTER_TOKEN_STORAGE_KEY = 'everframe.reporterDeviceToken';

/** @deprecated Use {@link scopedReporterTokenStorageKey}. Kept for callers that referenced the old unscoped constant. */
export const REPORTER_TOKEN_STORAGE_KEY = LEGACY_REPORTER_TOKEN_STORAGE_KEY;

/**
 * Namespace the storage key by app identity. The publishable `apiKey` is
 * already present on the page (it's how every other call is scoped), so it's
 * the natural, non-secret scope — no hashing needed.
 */
export function scopedReporterTokenStorageKey(scope: string): string {
  return `${LEGACY_REPORTER_TOKEN_STORAGE_KEY}.${scope}`;
}

/**
 * One-time migration: a single-app origin that was already storing a token
 * under the legacy unscoped key keeps its identity (no forced re-mint) by
 * adopting that token into the new scoped key and removing the legacy entry.
 * A no-op if the scoped key already holds a value (already migrated, or a
 * fresh store) or if there's nothing legacy to adopt. Best-effort: any
 * localStorage failure here just means the next mint starts fresh under the
 * scoped key, same as any other private-mode/quota failure.
 */
function migrateLegacyToken(scopedKey: string): void {
  if (scopedKey === LEGACY_REPORTER_TOKEN_STORAGE_KEY) return;
  try {
    if (localStorage.getItem(scopedKey) !== null) return;
    const legacy = localStorage.getItem(LEGACY_REPORTER_TOKEN_STORAGE_KEY);
    if (legacy !== null) {
      localStorage.setItem(scopedKey, legacy);
      localStorage.removeItem(LEGACY_REPORTER_TOKEN_STORAGE_KEY);
    }
  } catch {
    /* best-effort only — fall through to a fresh scoped mint */
  }
}

/**
 * @param scope App identity the token is namespaced under — pass the
 *   publishable `apiKey` (PR review Finding 4: the storage key is
 *   origin-wide by default, so without a scope, two Everframe-integrated apps
 *   on one origin stomp each other's device token).
 */
export function createLocalStorageCredentialStore(scope: string): ReporterCredentialStore | null {
  // PR review Finding (round 5): on an opaque/sandboxed origin, the
  // `window.localStorage` property GETTER itself throws SecurityError.
  // `typeof localStorage` must evaluate that reference to report its
  // runtime type, so — unlike `typeof someUndeclaredIdentifier`, which
  // typeof famously never throws for — a throwing getter here propagates
  // straight out. Evaluated bare (as it used to be) that SecurityError
  // escaped past every per-operation try/catch below and out of
  // createWebPlatformAdapter() into the host app. Mirrors the outbox's
  // tryStorage() probe (./outbox/localStorage.ts). A throw means storage
  // access is BLOCKED, not that localStorage is genuinely absent — the
  // browser context (and crypto) are real, so we fall through and still
  // build a store; it just degrades to the memory mirror below for every
  // access, exactly like a normal quota/private-mode failure. Only a true
  // `undefined` (no DOM at all — SSR) bails out to null, unchanged from
  // before.
  try {
    if (typeof localStorage === 'undefined') return null;
  } catch {
    // Blocked, not absent — fall through to build a memory-degraded store.
  }
  if (typeof crypto === 'undefined' || !crypto.getRandomValues) {
    return null;
  }
  const storageKey = scopedReporterTokenStorageKey(scope);

  // Session-memory mirror (PR review Finding 3): ensureDeviceToken() presents
  // a freshly-minted token to the server BEFORE this save() call returns —
  // the server adopts the token hash on that first ingest and never re-echoes
  // it. If localStorage.setItem then throws (quota exceeded, Safari private
  // mode, storage-partitioned iframe), a naive store would silently lose the
  // token: the next load() returns null, a new token gets minted, and the
  // thread the user just saw a "we'll reply here" toast for becomes
  // unpollable. save() always writes the memory variable FIRST — localStorage
  // is best-effort on top — so load() has a same-session fallback whenever
  // persistence fails. Doesn't survive a reload/new tab; that narrower gap is
  // an accepted tradeoff vs. an orphaned-forever thread.
  let memoryToken: string | null = null;

  return {
    randomBytes: (byteLength: number) => crypto.getRandomValues(new Uint8Array(byteLength)),
    load: async () => {
      migrateLegacyToken(storageKey);
      try {
        const stored = localStorage.getItem(storageKey);
        if (stored !== null) return stored;
      } catch {
        // fall through to the memory mirror
      }
      return memoryToken;
    },
    save: async (token: string) => {
      memoryToken = token;
      try {
        localStorage.setItem(storageKey, token);
      } catch {
        // Non-fatal: the memory mirror keeps the token readable this session.
      }
    },
    clear: async () => {
      memoryToken = null;
      try {
        localStorage.removeItem(storageKey);
      } catch {
        // Ignore.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Install identifier (MAI metering) — a SEPARATE seam from the reporter
// device token above. Deliberately not folded into ReporterCredentialStore:
//
//   1. It is NOT a secret. The device token authenticates a device's reply
//      threads and therefore carries a "CSPRNG or omit entirely" contract
//      (see device-token.ts). The install seed authenticates nothing — it
//      only needs to be distinct-ish across installs — so it gets no such
//      contract, and must never be described as a credential.
//   2. `ReporterCredentialStore.clear()` is called by the two-way-replies
//      thread client when the SERVER REJECTS the device token (401) — see
//      `reporter/thread-client.ts`'s only caller of `credentials.clear()`.
//      A rejected device token is not a new install, so that rejection must
//      never wipe this seed. Keeping the two entirely separate objects,
//      under separate storage keys, makes that true by construction: there
//      is no shared `clear()` for a 401 handler to accidentally reach.
const INSTALL_SEED_STORAGE_KEY_PREFIX = 'everframe.installSeed';
/** 16 bytes → 32 lowercase hex chars. Plenty of distinctness for a metering seed; no secrecy requirement to justify more. */
export const INSTALL_SEED_BYTES = 16;
const INSTALL_SEED_HEX_RE = /^[0-9a-f]{32}$/;

export function scopedInstallSeedStorageKey(scope: string): string {
  return `${INSTALL_SEED_STORAGE_KEY_PREFIX}.${scope}`;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, '0');
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Get-or-mint the per-install seed handed to `deriveInstallId` (sdk-core).
 * Returns `null` on ANY failure — no localStorage (SSR), a blocked/opaque
 * origin, quota exhaustion, no CSPRNG, or a stored value that doesn't match
 * the expected shape (discarded and re-minted rather than used, same
 * posture as `isWellFormedDeviceToken` for the device token).
 *
 * Deliberately a single try/catch around the WHOLE body rather than
 * per-operation fallbacks like the device-token store above: that store
 * needs a same-session memory mirror because a lost device token orphans an
 * already-started reply thread. There is no equivalent cost here — an
 * install simply going uncounted for a request is a cosmetic under-count on
 * a display-only meter — so the simplest correct behavior is "any failure
 * ⇒ no id this call," not a partial/unstable id.
 */
export function getOrCreateInstallSeed(scope: string): Uint8Array | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    if (typeof crypto === 'undefined' || !crypto.getRandomValues) return null;
    const key = scopedInstallSeedStorageKey(scope);
    const stored = localStorage.getItem(key);
    if (stored !== null && INSTALL_SEED_HEX_RE.test(stored)) {
      return hexToBytes(stored);
    }
    const seed = crypto.getRandomValues(new Uint8Array(INSTALL_SEED_BYTES));
    localStorage.setItem(key, bytesToHex(seed));
    // Finding 4 (2026-08-28 review): the mint above is check-then-act, not
    // atomic — localStorage has no compare-and-swap. Several tabs opening
    // with no stored seed each reach this line and each mint a DIFFERENT
    // value; without this read-back each just returns its OWN freshly
    // minted bytes, so one browser ends up reporting as several installs
    // for the WHOLE lifetime of every tab's adapter (the reviewer measured
    // multiple seeds in 90 of 100 rounds of a 20-tab probe). Reading back
    // immediately after the write and using whatever is ACTUALLY stored —
    // last writer wins in localStorage — means every tab that does this
    // converges on the SAME value regardless of which one minted first.
    // That collapses the window for two tabs to disagree from "the
    // adapter's whole lifetime" down to the handful of synchronous
    // statements between one tab's own write and its own read-back. This is
    // NOT a lock (localStorage has no atomic primitive and the `storage`
    // event does not fire in the writing tab) — it is the standard
    // best-effort mitigation, and per the review it is enough.
    const readBack = localStorage.getItem(key);
    if (readBack !== null && INSTALL_SEED_HEX_RE.test(readBack)) {
      return hexToBytes(readBack);
    }
    // Defensive only: `readBack` should always be exactly what was just
    // written. A `null`/malformed read-back here would mean the browser
    // failed the `getItem` immediately after a successful `setItem` (not
    // something normal operation can produce) — fall back to the value this
    // call itself minted rather than returning nothing.
    return seed;
  } catch {
    return null;
  }
}

/**
 * The install identifier the web adapter appends to the config read
 * (`GET /api/config?installId=<value>`). Never throws — every failure mode
 * (storage, crypto, or the derivation itself) collapses to `null`, which the
 * caller (`adapter.ts`) must treat as "send the config URL unchanged." See
 * that call site's comment for why an uncounted install is acceptable but a
 * broken config read is not.
 */
export function deriveWebInstallId(scope: string): string | null {
  try {
    const seed = getOrCreateInstallSeed(scope);
    if (!seed) return null;
    return deriveInstallId(seed);
  } catch {
    return null;
  }
}

const INSTALL_DAY_STORAGE_KEY_PREFIX = 'everframe.installIdDay';

export function scopedInstallDayStorageKey(scope: string): string {
  return `${INSTALL_DAY_STORAGE_KEY_PREFIX}.${scope}`;
}

/**
 * UTC day number — whole days since the epoch. Deliberately arithmetic rather
 * than a formatted date: iOS and Android run the identical expression, and
 * three separate "what day is it in UTC" implementations would be three
 * chances to disagree in a way no single-platform test could catch (each
 * platform still dedupes correctly against its own past either way).
 */
function utcDayNumber(nowMs: number): number {
  return Math.floor(nowMs / 86_400_000);
}

/**
 * The install-identifier supplier the adapter hands to `createConfigProvider`
 * (MAI meter spec 2026-08-27, D3). Yields the identifier at most once per
 * install per UTC day; every other call yields `null`, which the provider
 * treats as "send the config URL unchanged".
 *
 * The day is recorded at the moment the value is handed over — on dispatch,
 * NOT on a successful response. Recording on success would re-send through
 * every failed fetch, and a lost day costs nothing: the server deduplicates
 * per calendar MONTH, so any later day in that month still counts this
 * install. For the same reason nothing here retries.
 *
 * Never throws. Any failure — storage, clock, derivation — yields `null`.
 */
export function makeWebInstallIdSupplier(
  scope: string,
  now: () => number = () => Date.now(),
): () => string | null {
  return () => {
    try {
      if (typeof localStorage === 'undefined') return null;
      const today = utcDayNumber(now());
      if (!Number.isFinite(today)) return null;
      const key = scopedInstallDayStorageKey(scope);
      const stored = localStorage.getItem(key);
      // A malformed marker is treated as "not sent today" rather than
      // trusted: over-sending is free (the server's unique constraint
      // absorbs it), while trusting garbage could wrongly suppress a send.
      //
      // Validation must be STRICT, not `Number.parseInt`, which parses a
      // leading numeric prefix and ignores trailing garbage — `"10abc"`
      // would parse to `10` and be trusted as a real same-day marker.
      // Swift's `Int(String)` and Kotlin's `toLongOrNull()` are both strict
      // and return nil/null for `"10abc"`; matching that strictness here is
      // deliberate platform parity, not defensive noise, so web isn't the
      // one platform that disagrees on what counts as a valid marker.
      const storedDay = stored !== null && /^\d+$/.test(stored) ? Number.parseInt(stored, 10) : null;
      if (storedDay !== null && storedDay === today) return null;
      const id = deriveWebInstallId(scope);
      if (!id) return null;
      localStorage.setItem(key, String(today));
      return id;
    } catch {
      return null;
    }
  };
}
