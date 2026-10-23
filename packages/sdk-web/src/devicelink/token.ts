// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Real-device quick capture (web TVs): the device token, its owner, the
// per-origin-and-key storage scope, and the link nonce. Eager and DOM-free.
//
// The token and nonces are secrets: nothing here logs, traces or puts them in
// a URL. Hashing is sdk-core's synchronous SHA-256, because `crypto.subtle`
// is missing on hosted TV apps served over plain `http`.
import { sha256Hex } from '@everframe/sdk-core';
import { globalScope } from '../internal/global-scope.js';

export const DEVICE_TOKEN_RE = /^evf_dev_[0-9A-Za-z]{32}$/;

export function isDeviceToken(v: unknown): v is string {
  return typeof v === 'string' && DEVICE_TOKEN_RE.test(v);
}

export type DeviceLinkOwner = { kind: 'user'; name: string } | { kind: 'team' };

/** A `{ kind: 'user', name }` or `{ kind: 'team' }` owner, else null. */
export function parseOwner(raw: unknown): DeviceLinkOwner | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as { kind?: unknown; name?: unknown };
  if (o.kind === 'team') return { kind: 'team' };
  if (o.kind === 'user' && typeof o.name === 'string') return { kind: 'user', name: o.name };
  return null;
}

const NAME_MAX = 40;
// C0 and C1 control characters.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * The owner's name as shown on the TV: control characters become spaces,
 * whitespace is collapsed and trimmed, the name is cut at 40 characters plus
 * `…`, and a blank name becomes `teammate`.
 */
export function ownerDisplayName(name: string): string {
  const cleaned = String(name).replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return 'teammate';
  // Count code points so a cut never splits a surrogate pair.
  const chars = Array.from(cleaned);
  if (chars.length <= NAME_MAX) return cleaned;
  return chars.slice(0, NAME_MAX).join('').replace(/\s+$/, '') + '…';
}

const DEFAULT_PORTS: Record<string, string> = { http: '80', https: '443' };

/**
 * The storage scope of a device link: SHA-256 hex of
 * `<scheme>://<host>:<port>\n<sdkKey>`, with explicit default ports. Null for
 * an unparseable or non-http(s) ingest URL, or an empty key: then there is no
 * store and no token is ever sent.
 */
export function deviceLinkScope(ingestUrl: string, sdkKey: string): string | null {
  if (typeof sdkKey !== 'string' || sdkKey.length === 0) return null;
  try {
    const url = new URL(ingestUrl);
    const scheme = url.protocol.replace(/:$/, '').toLowerCase();
    const defaultPort = DEFAULT_PORTS[scheme];
    if (defaultPort === undefined || url.hostname.length === 0) return null;
    const port = url.port.length > 0 ? url.port : defaultPort;
    return sha256Hex(`${scheme}://${url.hostname.toLowerCase()}:${port}\n${sdkKey}`);
  } catch {
    return null;
  }
}

/** The first 16 hex characters of SHA-256 of the token. Safe to store. */
export function tokenFingerprint(token: string): string {
  return sha256Hex(token).slice(0, 16);
}

const NONCE_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const NONCE_LENGTH = 40;
// 248 = 4 × 62: bytes at or above it would bias the alphabet.
const NONCE_REJECT_FROM = 248;
const NONCE_MAX_ROUNDS = 8;

function defaultRandom(): ((n: number) => Uint8Array) | null {
  try {
    const c = (globalScope() as { crypto?: Crypto }).crypto;
    if (!c || typeof c.getRandomValues !== 'function') return null;
    return (n: number) => c.getRandomValues(new Uint8Array(n));
  } catch {
    return null;
  }
}

/**
 * 40 characters of `[0-9A-Za-z]` from `crypto.getRandomValues`, by rejection
 * sampling. Null when there is no secure random source (then there is no
 * hello and no link nonce). Never falls back to `Math.random`.
 */
export function newLinkNonce(random?: (n: number) => Uint8Array): string | null {
  const source = random ?? defaultRandom();
  if (!source) return null;
  try {
    let out = '';
    for (let round = 0; round < NONCE_MAX_ROUNDS && out.length < NONCE_LENGTH; round++) {
      const bytes = source(64);
      for (let i = 0; i < bytes.length && out.length < NONCE_LENGTH; i++) {
        const b = bytes[i]!;
        if (b >= NONCE_REJECT_FROM) continue;
        out += NONCE_ALPHABET.charAt(b % 62);
      }
    }
    return out.length === NONCE_LENGTH ? out : null;
  } catch {
    return null;
  }
}
