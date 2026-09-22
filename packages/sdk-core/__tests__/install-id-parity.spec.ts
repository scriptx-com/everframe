// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Replays the cross-SDK install-identifier vector. Swift
// (InstallIdentifierTests) and Kotlin (InstallIdentifierTest) run the SAME
// cases against their own HMAC/base64url implementations — if this fixture
// changes, all three suites change together (fixture-sync.spec.ts enforces
// that the three physical copies stay identical).
//
// The vector fixes BYTES -> identifier, never a platform storage type ->
// identifier: the three platforms store their seed differently (localStorage
// hex, UserDefaults hex, SharedPreferences hex), so only the byte-level
// contract is testable in common.
import { describe, it, expect } from 'vitest';
import { deriveInstallId, INSTALL_ID_DOMAIN_SEPARATOR } from '../src/install-id.js';
import fixture from '../../protocol/__tests__/fixtures/install-id.v1.json';

interface Case {
  name: string;
  seedHex: string;
  expected: string;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const vector = fixture as { domainSeparator: string; cases: Case[] };

describe('install-id.v1.json parity', () => {
  it('pins the domain separator the natives hard-code', () => {
    expect(INSTALL_ID_DOMAIN_SEPARATOR).toBe(vector.domainSeparator);
  });

  for (const c of vector.cases) {
    it(c.name, () => {
      expect(deriveInstallId(hexToBytes(c.seedHex))).toBe(c.expected);
    });
  }
});
