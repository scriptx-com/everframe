// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Synchronous SHA-256 for the crash path. Exists because the crash-envelope
// build path must be fully synchronous and crypto.subtle.digest is
// Promise-only; delegates to @noble/hashes — the audited dependency this
// package already ships (see transport/multipart.ts). Output parity with
// Kotlin MessageDigest / Swift CryptoKit is locked by the
// crash-fingerprint.json cross-SDK fixture.
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';

export function sha256Hex(input: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(input)));
}
