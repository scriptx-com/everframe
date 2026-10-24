// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Device link primitives: the token format, the owner shape, the scope a
// stored link is bound to, and nonces. A device token is a credential: none of
// these helpers ever logs or returns it in another form than a one-way
// fingerprint.
import { sha256Hex } from '@everframe/sdk-core';

export const DEVICE_TOKEN_PATTERN = /^evf_dev_[0-9A-Za-z]{32}$/;

export function isDeviceToken(raw: unknown): raw is string {
  return typeof raw === 'string' && DEVICE_TOKEN_PATTERN.test(raw);
}

export type LinkOwner = { kind: 'user'; name: string } | { kind: 'team' };

export function parseOwner(raw: unknown): LinkOwner | null {
  if (!raw || typeof raw !== 'object') return null;
  const owner = raw as { kind?: unknown; name?: unknown };
  if (owner.kind === 'team') return { kind: 'team' };
  if (owner.kind === 'user' && typeof owner.name === 'string' && owner.name.length <= 512)
    return { kind: 'user', name: owner.name };
  return null;
}

const NAME_MAX = 40;

/** A server-supplied name, made safe to show in one line. Never blank. */
export function displayName(name: string): string {
  const clean = String(name)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length === 0) return 'teammate';
  return clean.length > NAME_MAX ? `${clean.slice(0, NAME_MAX)}…` : clean;
}

// React Native 0.72's URL polyfill has no `host` or `port` (it throws), so
// the origin is parsed by hand.
const ORIGIN = /^(https?):\/\/([^/?#]*)/i;
const AUTHORITY = /^(\[[0-9a-f:.]+\]|[^:[\]@]+)(?::(\d{1,5}))?$/i;

/** `scheme://host:port`, lowercased, default port filled in; http/https only. */
export function originOf(url: string): string | null {
  if (typeof url !== 'string') return null;
  const match = ORIGIN.exec(url.trim());
  if (!match) return null;
  const scheme = match[1]!.toLowerCase();
  const authority = AUTHORITY.exec(match[2]!);
  if (!authority) return null;
  const host = authority[1]!.toLowerCase();
  const port = authority[2] === undefined ? (scheme === 'https' ? 443 : 80) : Number(authority[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `${scheme}://${host}:${port}`;
}

/**
 * What a stored link is bound to: the server origin plus the SDK key. A token
 * issued for one never reaches the other (staging and production on one TV).
 */
export function linkScope(endpoint: string, sdkKey: string): string | null {
  const origin = originOf(endpoint);
  if (!origin || typeof sdkKey !== 'string' || sdkKey.length === 0) return null;
  return sha256Hex(`everframe-vega/device-link\n${origin}\n${sdkKey}`);
}

/** First 16 hex chars of SHA-256: tells tokens apart, never usable as one. */
export function tokenFingerprint(token: string): string {
  return sha256Hex(token).slice(0, 16);
}

export interface RandomEnv {
  crypto?: unknown;
  random: () => number;
  now: () => number;
}

let mixCounter = 0;

/**
 * `n` random bytes. `crypto.getRandomValues` when the host has it (Vega OS
 * 1.1 does not); otherwise SHA-256 over successive `random()`/`now()`/counter
 * inputs, chained so that every block depends on all earlier ones.
 */
export function randomBytes(n: number, env: RandomEnv): Uint8Array {
  const out = new Uint8Array(n);
  const getRandomValues = (env.crypto as { getRandomValues?: unknown } | undefined)
    ?.getRandomValues;
  if (typeof getRandomValues === 'function') {
    try {
      for (let offset = 0; offset < n; offset += 65536) {
        const chunk = out.subarray(offset, Math.min(n, offset + 65536));
        getRandomValues.call(env.crypto, chunk);
      }
      return out;
    } catch {
      // Fall through to the mixer.
    }
  }
  let state = '';
  let filled = 0;
  while (filled < n) {
    mixCounter = (mixCounter + 1) % 0x7fffffff;
    state = sha256Hex(`${state}|${env.random()}|${env.random()}|${env.now()}|${mixCounter}`);
    for (let i = 0; i < 64 && filled < n; i += 2)
      out[filled++] = parseInt(state.slice(i, i + 2), 16);
  }
  return out;
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const NONCE_LENGTH = 40;

/** 40 base62 characters, by rejection sampling (no modulo bias). */
export function createNonce(bytes: (n: number) => Uint8Array): string {
  let nonce = '';
  while (nonce.length < NONCE_LENGTH) {
    const batch = bytes(64);
    for (let i = 0; i < batch.length && nonce.length < NONCE_LENGTH; i++) {
      const b = batch[i]!;
      if (b < 248) nonce += BASE62[b % 62];
    }
  }
  return nonce;
}
