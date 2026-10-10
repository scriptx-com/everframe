// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { CrashDetails, normalizeCrashDetails } from '@everframe/protocol';
import { projectDetails } from '../src/envelope.js';

const identity = (value: string) => value;

describe('handled-error details', () => {
  it.each([
    [undefined, { severity: 'error' }],
    [{ severity: 'info' }, { severity: 'info' }],
    [{ severity: 'fatal' }, { severity: 'error', truncated: true }],
    [{ context: 'Player' }, { severity: 'error', context: 'Player' }],
    [{ context: 'x'.repeat(300) }, { severity: 'error', context: 'x'.repeat(256), truncated: true }],
    [{ context: 7 }, { severity: 'error', truncated: true }],
    [{ metadata: { a: 'b', n: 1, ok: true, none: null } }, { severity: 'error', metadata: { a: 'b', n: 1, ok: true, none: null } }],
    [{ metadata: { deep: { x: 1 }, list: [1], fn: () => 1, nan: Number.NaN } }, { severity: 'error', truncated: true }],
    [{ metadata: { bad: 'a\u0000b', lone: '\ud800' } }, { severity: 'error', truncated: true }],
  ] as const)('projects %j', (options, expected) => {
    const projected = projectDetails(options as never, identity);
    expect(projected).toEqual(expected);
    // Always inside the protocol contract the server enforces.
    expect(CrashDetails.safeParse(projected).success).toBe(true);
  });

  it('caps metadata keys and total size', () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, 'v']));
    const capped = projectDetails({ metadata: many }, identity);
    expect(Object.keys(capped.metadata ?? {})).toHaveLength(32);
    expect(capped.truncated).toBe(true);

    const large = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, 'v'.repeat(1000)]));
    const trimmed = projectDetails({ metadata: large }, identity);
    expect(trimmed.metadata).toBeUndefined();
    expect(trimmed.truncated).toBe(true);
    expect(CrashDetails.safeParse(trimmed).success).toBe(true);
  });

  it('redacts strings and never reads getters', () => {
    let read = false;
    const options = {
      context: 'mail viewer@example.com',
      metadata: Object.defineProperty({ ok: 'a@b.co' }, 'trap', { enumerable: true, get: () => { read = true; return 'x'; } }),
    };
    const projected = projectDetails(options as never, (v) => v.replace(/\S+@\S+/g, '[email]'));
    expect(projected.context).toBe('mail [email]');
    expect(projected.metadata).toEqual({ ok: '[email]' });
    expect(read).toBe(false);
  });

  it('agrees with the protocol normalizer on the common shape', () => {
    const options = { severity: 'warning', context: 'Player', metadata: { assetId: 'A-1', retries: 2 } } as const;
    expect(projectDetails(options, identity)).toEqual(normalizeCrashDetails(options, identity, 'error'));
  });
});
