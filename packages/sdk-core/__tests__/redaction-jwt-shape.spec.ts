// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The engine masks JWTs and JWEs whose header decodes to a JOSE header and keeps dotted class,
// package and module names: the named cases of the shared corpus, through redactStringContent.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { redactStringContent } from '../src/redaction/engine.js';

interface Corpus { replacement: string; cases: Array<{ name: string; input: string; expected: string }> }
const corpus = JSON.parse(readFileSync(new URL('../../protocol/__tests__/fixtures/jwt-redaction-corpus.v1.json', import.meta.url), 'utf8')) as Corpus;
const named = corpus.cases.filter((entry) => !entry.name.startsWith('random'));
const redact = (value: string) => redactStringContent(value, {});

describe('JWT redaction in the engine', () => {
  it('uses the corpus replacement', () => {
    expect(corpus.replacement).toBe('[REDACTED:JWT]');
  });
  it.each(named.filter((entry) => entry.expected !== entry.input).map((entry) => [entry.name, entry.input, entry.expected]))(
    'redacts: %s', (_name, input, expected) => {
      expect(redact(input)).toBe(expected);
    });
  it.each(named.filter((entry) => entry.expected === entry.input).map((entry) => [entry.name, entry.input]))(
    'keeps: %s', (_name, input) => {
      expect(redact(input)).toBe(input);
    });
  it('redacts a megabyte of eyJ- in linear time', () => {
    const value = 'eyJ-'.repeat(262_144);
    const started = performance.now();
    expect(redact(value)).toBe(value);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
