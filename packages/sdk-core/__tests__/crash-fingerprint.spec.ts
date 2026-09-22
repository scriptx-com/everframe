// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex, computeCrashFingerprint } from '../src/crash/fingerprint.js';

describe('sha256Hex (sync, dependency-free)', () => {
  it('matches node:crypto for assorted inputs', () => {
    for (const s of ['', 'abc', 'TypeError\nfoo|bar.ts', 'ünïcode ✓ 𝄞', 'a'.repeat(10_000)]) {
      expect(sha256Hex(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
    }
  });
});

describe('computeCrashFingerprint (spec rule — parity-locked)', () => {
  it('uses function|file when both present, digit-stripped raw otherwise; top 5 frames', () => {
    const fp = computeCrashFingerprint('TypeError', [
      { raw: 'at render (app.tsx:10:5)', function: 'render', file: 'app.tsx' },
      { raw: 'at main (index.ts:3:1)' },
    ]);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    // Line/col changes must NOT change the fingerprint.
    const fp2 = computeCrashFingerprint('TypeError', [
      { raw: 'at render (app.tsx:99:1)', function: 'render', file: 'app.tsx' },
      { raw: 'at main (index.ts:77:9)' },
    ]);
    expect(fp2).toBe(fp);
    // A different exception type MUST change it.
    expect(computeCrashFingerprint('RangeError', [])).not.toBe(fp);
  });

  it('matches the committed cross-SDK parity fixture', () => {
    const cases = JSON.parse(
      readFileSync(
        join(__dirname, '..', '..', 'protocol', '__tests__', 'fixtures', 'crash-fingerprint.json'),
        'utf8',
      ),
    ) as Array<{ exceptionType: string; frames: Array<{ raw: string; function?: string; file?: string }>; expected: string }>;
    expect(cases.length).toBeGreaterThanOrEqual(4);
    for (const c of cases) {
      expect(computeCrashFingerprint(c.exceptionType, c.frames)).toBe(c.expected);
    }
  });
});
