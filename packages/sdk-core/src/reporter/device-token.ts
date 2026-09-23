// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The reporter DEVICE TOKEN, client side.
//
// PROVENANCE. The client mints this token; the server stores only
// HMAC(token, pepper) and adopts the hash the first time it sees the token for
// an app. That inversion exists because a server-minted token was
// unrecoverable: only its hash was stored, so if the one ingest response
// carrying it was lost in transit, the retry found the existing thread, could
// be handed no credential, and that thread was unreadable by its own reporter
// forever. With the client as the source, a lost response costs nothing.
//
// The token is the SOLE authenticator for one device's threads, so the two
// obligations below are not optional:
//
//   1. GENERATE IT FROM A CSPRNG. `Math.random()` is not one. A platform that
//      cannot supply 32 cryptographically random bytes must not implement
//      `ReporterCredentialStore` at all — omitting it falls back to the
//      server-minted path, which is strictly better than a guessable token.
//   2. PERSIST IT SOMEWHERE APPROPRIATE TO THE PLATFORM. localStorage on web,
//      Keychain on iOS, Keystore/EncryptedSharedPreferences on Android. Losing
//      it is not fatal (the next report simply mints a new device and the old
//      threads become unreachable), but it silently orphans the reporter's
//      conversation history, so treat it as durable state.
//
// WHY THIS FILE IMPORTS NOTHING. sdk-core is DOM-free and Node-free by design,
// and both entropy and storage are platform concerns. They arrive through the
// injected `ReporterCredentialStore` interface (types/platform.ts), exactly as
// `OutboxAdapter` does — the interface lives in core, every implementation
// lives in a platform package.
import type { ReporterCredentialStore } from '../types/platform.js';

export const DEVICE_TOKEN_HEADER = 'X-Everframe-Device-Token';
export const DEVICE_TOKEN_PREFIX = 'evr_';
/** 32 random bytes → 43 base64url chars. Must match the server's constant. */
export const DEVICE_TOKEN_BODY_LENGTH = 43;
export const DEVICE_TOKEN_BYTES = 32;
export const DEVICE_TOKEN_LENGTH = DEVICE_TOKEN_PREFIX.length + DEVICE_TOKEN_BODY_LENGTH;

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const DEVICE_TOKEN_BODY_RE = new RegExp(`^[A-Za-z0-9_-]{${DEVICE_TOKEN_BODY_LENGTH}}$`);

/**
 * Unpadded base64url, hand-rolled rather than via `btoa` (DOM) or `Buffer`
 * (Node) — sdk-core may not reach for either.
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
 * The same shape check the server applies before it will store a presented
 * token's hash. Exported so a platform store can validate what it loaded: a
 * corrupted or truncated value read back from storage must be discarded and
 * replaced, not presented (the server would reject it and hand back a
 * server-minted token, quietly changing device identity).
 */
export function isWellFormedDeviceToken(token: string): boolean {
  return (
    token.length === DEVICE_TOKEN_LENGTH &&
    token.startsWith(DEVICE_TOKEN_PREFIX) &&
    DEVICE_TOKEN_BODY_RE.test(token.slice(DEVICE_TOKEN_PREFIX.length))
  );
}

/**
 * Mint a token from `DEVICE_TOKEN_BYTES` of platform-supplied entropy.
 *
 * Throws if the source returns the wrong number of bytes rather than padding
 * or truncating: a short read means the CSPRNG is not behaving, and silently
 * producing a lower-entropy credential is the one failure mode that would
 * never show up until it mattered.
 */
export function generateDeviceToken(randomBytes: (byteLength: number) => Uint8Array): string {
  const bytes = randomBytes(DEVICE_TOKEN_BYTES);
  if (bytes.length !== DEVICE_TOKEN_BYTES) {
    throw new Error(
      `device token entropy source returned ${bytes.length} bytes, expected ${DEVICE_TOKEN_BYTES}`,
    );
  }
  return `${DEVICE_TOKEN_PREFIX}${base64url(bytes)}`;
}

// Finding 4-SDK: ensureDeviceToken() below is a load->mint->save sequence.
// Mount, online, post-submit and crash drains plus manual submits can all
// call it concurrently. Without a lock, two concurrent calls against one
// empty store each see no stored token, each mint their own, and only the
// LAST save() wins — the earlier caller's token (and the conversation it
// started) is silently orphaned, since nothing ever reads it again. Keyed
// by the store instance (stable per platform adapter) rather than by any
// global lock, so unrelated stores (tests, multiple adapters) never
// contend with each other. A WeakMap lets an unused store's entry be
// collected once nothing else references it.
const inFlightMints = new WeakMap<ReporterCredentialStore, Promise<string>>();

async function mintAndPersist(store: ReporterCredentialStore): Promise<string> {
  const existing = await store.load();
  if (existing && isWellFormedDeviceToken(existing)) return existing;
  const token = generateDeviceToken(store.randomBytes);
  await store.save(token);
  return token;
}

/**
 * Load the stored token, or mint and persist one. Idempotent — the same device
 * keeps the same token across launches, which is exactly what makes its thread
 * history durable.
 *
 * A stored value that no longer passes `isWellFormedDeviceToken` is REPLACED
 * rather than presented: the server would refuse to adopt it and would mint
 * over it, so presenting it buys nothing and costs a round trip's confusion.
 *
 * Concurrent callers against the SAME store share one in-flight
 * load/mint/save and all resolve to the identical token (finding 4-SDK) —
 * deliberately synchronous up to the point the shared promise is recorded,
 * so two calls issued back to back (e.g. `Promise.all([...])`) can never
 * both observe an empty lock slot. The entry is cleared once the promise
 * settles, success or failure, so a rejected mint doesn't poison later
 * calls and a later call after `store.clear()` can mint afresh.
 */
export function ensureDeviceToken(store: ReporterCredentialStore): Promise<string> {
  const inFlight = inFlightMints.get(store);
  if (inFlight) return inFlight;
  const attempt = mintAndPersist(store).finally(() => {
    inFlightMints.delete(store);
  });
  inFlightMints.set(store, attempt);
  return attempt;
}
