// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import {
  createNonce,
  displayName,
  isDeviceToken,
  linkScope,
  originOf,
  parseOwner,
  randomBytes,
  tokenFingerprint,
} from '../src/link-token.js';

const TOKEN = 'evf_dev_' + 'a1B2'.repeat(8);

function lcg(seed = 7): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

describe('link token primitives', () => {
  it('tokenFormat', () => {
    expect(isDeviceToken(TOKEN)).toBe(true);
    for (const bad of [
      null,
      undefined,
      42,
      '',
      'evf_dev_short',
      'evf_cap_' + 'a'.repeat(32),
      'evf_dev_' + 'a'.repeat(31) + '-',
      ' evf_dev_' + 'a'.repeat(32),
      'evf_dev_' + 'a'.repeat(33),
    ])
      expect(isDeviceToken(bad)).toBe(false);
  });

  it('scopeDependsOnOriginAndKey', () => {
    expect(linkScope('https://A.dev:443', 'k')).toBe(linkScope('https://a.dev', 'k'));
    expect(linkScope('https://a.dev/api/ingest', 'k')).toBe(linkScope('https://a.dev', 'k'));
    expect(linkScope('http://a.dev:80', 'k')).toBe(linkScope('http://a.dev', 'k'));
    expect(linkScope('https://a.dev', 'k')).not.toBe(linkScope('https://b.dev', 'k'));
    expect(linkScope('https://a.dev', 'k')).not.toBe(linkScope('https://a.dev:8443', 'k'));
    expect(linkScope('https://a.dev', 'k')).not.toBe(linkScope('https://a.dev', 'k2'));
    expect(linkScope('http://a.dev', 'k')).not.toBe(linkScope('https://a.dev', 'k'));
    expect(linkScope('not a url', 'k')).toBeNull();
    expect(linkScope('https://a.dev', '')).toBeNull();
    expect(linkScope('https://a.dev', 'k')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('originOfParsesWithoutUrlHost', () => {
    expect(originOf('https://Everframe.DEV')).toBe('https://everframe.dev:443');
    expect(originOf('http://127.0.0.1:8790/api/ingest')).toBe('http://127.0.0.1:8790');
    expect(originOf('http://[::1]:8790/x')).toBe('http://[::1]:8790');
    expect(originOf('https://user:pw@a.dev/x')).toBeNull();
    expect(originOf('ftp://a.dev')).toBeNull();
    expect(originOf('https://a.dev:99999')).toBeNull();
    expect(originOf('https://')).toBeNull();
    expect(originOf(42 as unknown as string)).toBeNull();
  });

  it('displayNameIsBoundedAndNeverBlank', () => {
    expect(displayName('  ')).toBe('teammate');
    expect(displayName(' Ann\nLee ')).toBe('Ann Lee');
    expect(displayName('A\u0000\u001fB')).toBe('A B');
    expect(displayName('x'.repeat(80))).toHaveLength(41);
    expect(displayName('x'.repeat(80)).endsWith('…')).toBe(true);
    expect(displayName('x'.repeat(40))).toBe('x'.repeat(40));
  });

  it('parsesOwner', () => {
    expect(parseOwner({ kind: 'user', name: 'Aurimas' })).toEqual({
      kind: 'user',
      name: 'Aurimas',
    });
    expect(parseOwner({ kind: 'team' })).toEqual({ kind: 'team' });
    expect(parseOwner({ kind: 'team', name: 'x' })).toEqual({ kind: 'team' });
    expect(parseOwner({ kind: 'user' })).toBeNull();
    expect(parseOwner({ kind: 'user', name: 42 })).toBeNull();
    expect(parseOwner({ kind: 'org' })).toBeNull();
    expect(parseOwner(null)).toBeNull();
    expect(parseOwner('team')).toBeNull();
  });

  it('nonceShape', () => {
    const env = { crypto: undefined, random: lcg(), now: () => 1_700_000_000_000 };
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const nonce = createNonce((n) => randomBytes(n, env));
      expect(nonce).toMatch(/^[0-9A-Za-z]{40}$/);
      seen.add(nonce);
    }
    expect(seen.size).toBe(1000);
  });

  it('usesGetRandomValuesWhenPresent', () => {
    let calls = 0;
    const crypto = {
      getRandomValues(array: Uint8Array) {
        calls++;
        for (let i = 0; i < array.length; i++) array[i] = (i * 31 + calls) & 0xff;
        return array;
      },
    };
    let randomCalls = 0;
    const env = {
      crypto,
      random: () => {
        randomCalls++;
        return 0.5;
      },
      now: () => 0,
    };
    const bytes = randomBytes(48, env);
    expect(bytes).toHaveLength(48);
    expect(calls).toBeGreaterThan(0);
    expect(randomCalls).toBe(0);
  });

  it('fallsBackWhenGetRandomValuesThrows', () => {
    const crypto = {
      getRandomValues() {
        throw new Error('no entropy');
      },
    };
    const bytes = randomBytes(40, { crypto, random: lcg(3), now: () => 5 });
    expect(bytes).toHaveLength(40);
  });

  it('fingerprintIs16Hex', () => {
    const a = tokenFingerprint(TOKEN);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(tokenFingerprint(TOKEN)).toBe(a);
    expect(tokenFingerprint('evf_dev_' + 'z'.repeat(32))).not.toBe(a);
    expect(a).not.toContain(TOKEN.slice(8, 24));
  });
});
