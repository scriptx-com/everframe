// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBrs, brsString } from './brs-harness.js';

// Sibling package in the same workspace; the fixture is not part of protocol's published exports.
const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../protocol/__tests__/fixtures/crash-fingerprint.json');
const cases = JSON.parse(readFileSync(fixturePath, 'utf8')) as Array<{ exceptionType: string; frames: unknown[]; expected: string }>;

describe('EfFp_Compute parity with the cross-SDK fixture', () => {
  it('matches every fixture case', async () => {
    const body = cases
      .map((c) => `print "EFTEST:" + FormatJson(EfFp_Compute(${brsString(c.exceptionType)}, ParseJson(${brsString(JSON.stringify(c.frames))})))`)
      .join('\n');
    const { lines } = await runBrs(['ef_util.brs', 'ef_fingerprint.brs'], body);
    expect(lines).toEqual(cases.map((c) => c.expected));
  });
});
