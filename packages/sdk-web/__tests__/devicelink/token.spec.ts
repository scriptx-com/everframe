// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@everframe/sdk-core';
import {
  DEVICE_TOKEN_RE,
  deviceLinkScope,
  isDeviceToken,
  newLinkNonce,
  ownerDisplayName,
  parseOwner,
  tokenFingerprint,
} from '../../src/devicelink/token.js';

const TOKEN = 'evf_dev_' + 'aB3'.repeat(10) + 'xY';
const SERVER_NONCE_RE = /^[A-Za-z0-9_-]{32,128}$/;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('device token', () => {
  it('accepts only evf_dev_ plus 32 alphanumerics', () => {
    expect(TOKEN).toHaveLength(40);
    expect(isDeviceToken(TOKEN)).toBe(true);
    expect(DEVICE_TOKEN_RE.test(TOKEN)).toBe(true);
    expect(isDeviceToken('evf_cap_' + 'a'.repeat(32))).toBe(false);
    expect(isDeviceToken('evf_dev_' + 'a'.repeat(31))).toBe(false);
    expect(isDeviceToken('evf_dev_' + 'a'.repeat(33))).toBe(false);
    expect(isDeviceToken('evf_dev_' + 'a'.repeat(15) + '-' + 'a'.repeat(16))).toBe(false);
    expect(isDeviceToken(42)).toBe(false);
    expect(isDeviceToken(null)).toBe(false);
  });

  it('fingerprint is the first 16 hex characters of SHA-256', () => {
    expect(tokenFingerprint(TOKEN)).toBe(sha256Hex(TOKEN).slice(0, 16));
    expect(tokenFingerprint(TOKEN)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('owner', () => {
  it('parses a user and a team, and refuses anything else', () => {
    expect(parseOwner({ kind: 'user', name: 'Aurimas' })).toEqual({
      kind: 'user',
      name: 'Aurimas',
    });
    expect(parseOwner({ kind: 'team' })).toEqual({ kind: 'team' });
    expect(parseOwner({ kind: 'user' })).toBeNull();
    expect(parseOwner({ kind: 'user', name: 7 })).toBeNull();
    expect(parseOwner({ kind: 'org' })).toBeNull();
    expect(parseOwner(null)).toBeNull();
    expect(parseOwner('team')).toBeNull();
  });

  it('display name collapses control characters and caps at 40', () => {
    expect(ownerDisplayName('  Au\u0000ri\nmas  ')).toBe('Au ri mas');
    expect(ownerDisplayName('x'.repeat(50))).toBe('x'.repeat(40) + '…');
    expect(ownerDisplayName('x'.repeat(40))).toBe('x'.repeat(40));
    expect(ownerDisplayName(' \t ')).toBe('teammate');
    expect(ownerDisplayName('')).toBe('teammate');
  });
});

describe('scope', () => {
  it('scope differs by ingest origin and by SDK key, and normalizes default ports', () => {
    const a = deviceLinkScope('https://everframe.dev', 'key-1');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(sha256Hex('https://everframe.dev:443\nkey-1'));
    expect(deviceLinkScope('https://everframe.dev:443/api', 'key-1')).toBe(a);
    expect(deviceLinkScope('https://EVERFRAME.dev/', 'key-1')).toBe(a);
    expect(deviceLinkScope('http://everframe.dev', 'key-1')).not.toBe(a);
    expect(deviceLinkScope('http://everframe.dev', 'key-1')).toBe(
      sha256Hex('http://everframe.dev:80\nkey-1'),
    );
    expect(deviceLinkScope('https://everframe.dev:8443', 'key-1')).not.toBe(a);
    expect(deviceLinkScope('https://everframe.dev', 'key-2')).not.toBe(a);
  });

  it('an unparseable ingest URL or an empty key has no scope', () => {
    expect(deviceLinkScope('not a url', 'key-1')).toBeNull();
    expect(deviceLinkScope('https://everframe.dev', '')).toBeNull();
    expect(deviceLinkScope('ftp://everframe.dev', 'key-1')).toBeNull();
  });
});

describe('link nonce', () => {
  it('a nonce is 40 chars of [0-9A-Za-z], matches the server pattern, and two differ', () => {
    const a = newLinkNonce();
    const b = newLinkNonce();
    expect(a).toMatch(/^[0-9A-Za-z]{40}$/);
    expect(a).toMatch(SERVER_NONCE_RE);
    expect(b).toMatch(/^[0-9A-Za-z]{40}$/);
    expect(a).not.toBe(b);
  });

  it('nonce generation rejects bytes ≥ 248', () => {
    const random = (n: number): Uint8Array => {
      const out = new Uint8Array(n);
      out[0] = 248;
      out[1] = 255;
      out[2] = 61;
      for (let i = 3; i < n; i++) out[i] = i % 248;
      return out;
    };
    const nonce = newLinkNonce(random);
    expect(nonce).not.toBeNull();
    expect(nonce!.startsWith('z')).toBe(true);
    expect(nonce).toHaveLength(40);
  });

  it('a source that only yields rejected bytes gives no nonce instead of spinning', () => {
    expect(newLinkNonce((n) => new Uint8Array(n).fill(250))).toBeNull();
  });

  it('a throwing source gives no nonce', () => {
    expect(
      newLinkNonce(() => {
        throw new Error('nope');
      }),
    ).toBeNull();
  });

  it('without crypto.getRandomValues there is no nonce', () => {
    vi.stubGlobal('crypto', undefined);
    expect(newLinkNonce()).toBeNull();
    vi.stubGlobal('crypto', {});
    expect(newLinkNonce()).toBeNull();
  });

  it('never uses Math.random', () => {
    const spy = vi.spyOn(Math, 'random');
    newLinkNonce();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
