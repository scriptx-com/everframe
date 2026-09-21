// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Shared shapes. The limits here are NOT independent choices — every one of
// them mirrors the server identity-token verifier, which is what actually
// verifies these tokens. Changing one here without changing it there produces
// tokens that mint cleanly and are rejected silently, which is the single
// worst failure mode this package exists to prevent.

/** The person a token is minted for. `id` becomes `sub`. */
export interface IdentityUser {
  /** Stable identifier. Non-empty, <=255 chars after trimming. */
  id: string;
  /** Optional. Dropped when empty or over 320 chars, never an error. */
  email?: string;
  /** Optional. Dropped when empty or over 320 chars, never an error. */
  name?: string;
}

/** `SUBJECT_MAX` in the server identity-token verifier. */
export const SUBJECT_MAX = 255;
/** `CLAIM_MAX` in the server identity-token verifier. */
export const CLAIM_MAX = 320;
/** `IDENTITY_TOKEN_MAX_TTL_SEC` in the server identity-token verifier. */
export const MAX_TTL_SECONDS = 600;
/** Well inside the ceiling, so ordinary clock drift never approaches it. */
export const DEFAULT_TTL_SECONDS = 300;

/**
 * Minimum accepted secret length. TraceItX mints 64 hex characters
 * (`randomBytes(32).toString('hex')`, the ingest API/src/reporter/identity-secret.ts).
 * 32 rejects "", "changeme", and an unset env var read with a non-null
 * assertion, without being brittle about a format the generator could
 * legitimately change.
 */
export const MIN_SECRET_LENGTH = 32;
