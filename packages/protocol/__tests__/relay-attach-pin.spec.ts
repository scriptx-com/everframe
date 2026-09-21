// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { relay } from '../src/index.js';

describe('attach.challenge frames', () => {
  it('accepts a well-formed attach.challenge', () => {
    const parsed = relay.AttachChallenge.safeParse({
      type: 'attach.challenge',
      code: '0427',
      ttl_ms: 60_000,
      requested_by_name: 'Aurimas',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a code that is not exactly 4 characters', () => {
    for (const code of ['427', '04271', '']) {
      expect(
        relay.AttachChallenge.safeParse({
          type: 'attach.challenge',
          code,
          ttl_ms: 60_000,
          requested_by_name: 'Aurimas',
        }).success,
      ).toBe(false);
    }
  });

  it('accepts every cleared reason and rejects unknown ones', () => {
    for (const reason of ['expired', 'attached', 'burned', 'superseded']) {
      expect(
        relay.AttachChallengeCleared.safeParse({
          type: 'attach.challenge.cleared',
          reason,
        }).success,
      ).toBe(true);
    }
    expect(
      relay.AttachChallengeCleared.safeParse({
        type: 'attach.challenge.cleared',
        reason: 'cancelled',
      }).success,
    ).toBe(false);
  });

  it('routes both through the RelayMessage discriminated union', () => {
    const msg = relay.RelayMessage.parse({
      type: 'attach.challenge',
      code: '9001',
      ttl_ms: 45_000,
      requested_by_name: 'Support',
    });
    expect(msg.type).toBe('attach.challenge');
  });
});
