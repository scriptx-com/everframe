// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Derives the (non-secret) install identifier the web/RN SDKs report on
// `GET /api/config?installId=<value>` for MAI ("monthly active install")
// metering — a display-only, per-(org, month) distinct-install count. This
// is NOT a user identifier and NOT authentication; never call it a "user id"
// or reason about it as one.
//
// ONE-WAYNESS IS THE WHOLE POINT. The spec's second amendment (2026-08-27
// design doc, "The install identifier: a non-secret per-install seed")
// killed the original premise that native platforms would hand this
// function the device key: `DeviceKey` has no production call site on
// either iOS or Android, and this feature deliberately does not read it.
// Every platform instead mints its own non-secret, purpose-built 16-byte
// seed (UserDefaults on iOS, SharedPreferences on Android, local storage
// here) specifically for this derivation. Even though that seed is
// non-secret by design, the derivation still routes it through a keyed PRF
// rather than e.g. hashing or truncating it directly, so the construction
// carries no less one-wayness than it would if the input ever changed.
//
// PRIMITIVE CHOICE — HMAC-SHA256 via @noble/hashes, not a hand-rolled
// SHA-256. `reporter/device-token.ts` in this same directory hand-rolls
// base64url and imports nothing, but that is a narrower constraint than
// "sdk-core can't use crypto": that file's job is *generating entropy*
// (CSPRNG), which is unavoidably a platform concern injected via
// `ReporterCredentialStore.randomBytes` — there is no portable "give me
// randomness" primitive to import. Deriving a one-way output from
// already-supplied bytes is a different problem, and this package already
// ships and tests an audited answer to it: `@noble/hashes` is a existing
// sdk-core dependency, pure JS with no Node/DOM built-ins (no `node:crypto`,
// no `crypto.subtle`), used synchronously for exactly this kind of hashing
// in `crash/sha256.ts` and `transport/multipart.ts`. Hand-rolling SHA-256
// here would mean owning and testing a second, parallel implementation of a
// primitive this package already has — strictly worse than reusing the one
// that's already vetted and in the dependency tree. See the task-6 report
// for the fuller comparison against the platform-seam alternative.
//
// CONSTRUCTION. HMAC-SHA256(key = seed, message = domain-separator). The
// seed is the KEY, not the message: that is what makes this a proper keyed
// PRF over the seed — HMAC's security guarantee is precisely that, without
// the key, the output is indistinguishable from random and the key cannot
// be recovered from any number of (message, tag) pairs, even for a message
// as predictable as a fixed public constant. Keying on the domain separator
// instead (seed-as-message) would not carry that same guarantee for a
// fixed, attacker-known message.
//
// DOMAIN SEPARATION. The domain-separator string is versioned
// ("-v1") so a future change to this derivation (longer output, different
// KDF, etc.) can bump to "-v2" and produce values that are unambiguously
// distinct from anything derived under this version — never a value that
// could be silently misinterpreted as still meaning what a v1 id meant.
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';

/** Versioned so the derivation can change later without silently reinterpreting old identifiers. */
export const INSTALL_ID_DOMAIN_SEPARATOR = 'traceitx-install-id-v1';

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Unpadded base64url. Hand-rolled (not `btoa`/`Buffer`) for the same reason
 * `device-token.ts` hand-rolls its own: sdk-core stays DOM-free and
 * Node-free, so it may reach for neither.
 */
function base64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64URL_ALPHABET[b0 >> 2];
    out += BASE64URL_ALPHABET[((b0 & 0b11) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    out += BASE64URL_ALPHABET[((b1 & 0b1111) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += BASE64URL_ALPHABET[b2 & 0b111111];
  }
  return out;
}

/**
 * Derive a URL-safe, ≤128-char install identifier from platform-supplied
 * entropy (`seed`). Deterministic (same seed ⇒ same id, so it stays stable
 * across launches when the platform's seed is itself stable) and one-way:
 * `seed` cannot be recovered from the returned string.
 *
 * `seed` need not be secret or even CSPRNG-quality — unlike
 * `ReporterCredentialStore.randomBytes`, there is no "must be strong or omit
 * entirely" contract here, because this value authenticates nothing. A
 * weak or predictable seed only costs distinctness in the metering count,
 * never confidentiality of anything.
 */
export function deriveInstallId(seed: Uint8Array): string {
  const message = new TextEncoder().encode(INSTALL_ID_DOMAIN_SEPARATOR);
  const digest = hmac(sha256, seed, message);
  return base64url(digest);
}
