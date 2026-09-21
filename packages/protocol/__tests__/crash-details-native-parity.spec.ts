// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CrashDetails, normalizeCrashDetails } from '../src/index.js';

interface FixtureCase {
  name: string;
  input: unknown;
  expected: unknown;
}

interface FixtureCorpus {
  schemaVersion: number;
  cases: FixtureCase[];
}

const corpus = JSON.parse(readFileSync(
  new URL('./fixtures/crash-details-native-parity.json', import.meta.url),
  'utf8',
)) as FixtureCorpus;

describe('native crash details parity corpus', () => {
  it('has the supported schema and all required unique cases', () => {
    expect(corpus.schemaVersion).toBe(1);
    expect(corpus.cases.length).toBeGreaterThan(0);
    const names = corpus.cases.map(fixture => fixture.name);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(names)).toEqual(new Set([
      'default',
      'masked-key',
      'nested',
      'repaired-text',
      'bounded-loss',
      'prototype-keys',
    ]));
  });

  it('matches the shared normalizer and schema', () => {
    for (const fixture of corpus.cases) {
      const actual = normalizeCrashDetails(fixture.input, value => value, 'error');
      expect(actual, fixture.name).toEqual(fixture.expected);
      expect(CrashDetails.safeParse(actual).success, fixture.name).toBe(true);
    }
  });
});
