// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// JWT and JWE redaction by structure: a token is masked only when its header decodes to a JOSE
// header ({…"alg"…}). The shared corpus pins every engine to one reference implementation.
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { JWT_CANDIDATE_PATTERN, JWT_REPLACEMENT, redactJwt } from '../src/redaction.js';
import { referenceRedactJwt } from './jwt-reference.js';
import { b64, buildJwtCorpus, headers, type JwtCorpus } from './jwt-corpus.js';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const shared = JSON.parse(read('../data/redaction-patterns.json'));
const jwtRule = shared.patterns.find((p: { id: string }) => p.id === 'jwt');
const corpusUrl = new URL('./fixtures/jwt-redaction-corpus.v1.json', import.meta.url);

describe('shared JWT redaction', () => {
  it('names the scanner in the data file, with the candidate regex for engines that cannot run it', () => {
    expect(jwtRule.scanner).toBe('jwt');
    expect(jwtRule.regex).toBe(JWT_CANDIDATE_PATTERN);
    expect(jwtRule.replacement).toBe(JWT_REPLACEMENT);
  });
  it.each([
    '../../sdk-android/android/everframe-core/src/main/assets/everframe/redaction-patterns.json',
    '../../sdk-ios/Sources/Everframe/Resources/redaction-patterns.json',
  ])('ships the same bytes in %s', (copy) => {
    expect(read(copy)).toBe(read('../data/redaction-patterns.json'));
  });

  it('keeps the shared corpus equal to the reference implementation', () => {
    const built = buildJwtCorpus();
    if (process.env.UPDATE_JWT_CORPUS === '1') writeFileSync(corpusUrl, `${JSON.stringify(built, null, 2)}\n`);
    const stored = JSON.parse(readFileSync(corpusUrl, 'utf8')) as JwtCorpus;
    expect(stored).toEqual(built);
    // Named expectations were written by hand; the reference must agree with them.
    for (const entry of stored.cases) expect(referenceRedactJwt(entry.input, stored.replacement), entry.name).toBe(entry.expected);
    // The corpus has to exercise both outcomes.
    expect(stored.cases.filter((entry) => entry.expected !== entry.input).length).toBeGreaterThan(100);
    expect(stored.cases.filter((entry) => entry.expected === entry.input).length).toBeGreaterThan(100);
  });

  it('redactJwt gives the corpus output for every case', () => {
    const corpus = JSON.parse(readFileSync(corpusUrl, 'utf8')) as JwtCorpus;
    for (const entry of corpus.cases) expect(redactJwt(entry.input, corpus.replacement), entry.name).toBe(entry.expected);
  });

  it('every redacted named token is also a candidate for the data file regex', () => {
    const candidate = new RegExp(JWT_CANDIDATE_PATTERN);
    for (const entry of buildJwtCorpus().cases.filter((c) => !c.name.startsWith('random') && c.expected !== c.input)) {
      expect(candidate.test(entry.input), entry.name).toBe(true);
    }
  });

  it('gives exactly the reference output on 20,000 more random near-tokens', () => {
    let seed = 0x9e3779b9;
    const random = (n: number) => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
    const pieces = [...Object.values(headers), 'e30', b64(' {"x":1}'), 'eyJ', 'ewokFactory', 'abcdefgh', 'Zm9v', '.', '.', '.', '..',
      '-', '_', 'x', '%3D', ' ', 'é', '\\n'];
    let redacted = 0;
    for (let round = 0; round < 20_000; round++) {
      let value = '';
      for (let k = 1 + random(10); k > 0; k--) value += pieces[random(pieces.length)];
      const expected = referenceRedactJwt(value);
      expect(redactJwt(value), value).toBe(expected);
      if (expected !== value) redacted++;
    }
    expect(redacted).toBeGreaterThan(500);
  });

  it.each([
    ['eyJ- repeated', 'eyJ-'.repeat(262_144)],
    ['a long dotted run', 'a.'.repeat(524_288)],
    ['many x.y.z candidates', 'abcdefgh.ab.c '.repeat(74_899)],
    ['long base64 runs with dots that open a JSON object', `${'e30'.repeat(370)}.e30.x `.repeat(940)],
    ['long base64 runs with dots', `${'Zm9vYmFy'.repeat(140)}.YmF6.cXV4 `.repeat(925)],
    ['glue that never verifies', `${'x'.repeat(64)}e30e30e30e30.e30. `.repeat(12_337)],
    ['real tokens', `${headers.compact}.e30.sig `.repeat(23_000)],
    ['many long fake headers that open a JSON object', `${'eyJi'.repeat(250)}.e30.x `.repeat(1_000)],
    ['one fake header of a megabyte', `${'eyJi'.repeat(262_144)}.e30.x`],
    ['long headers that name "alg" at the end', `${b64(`{"kid":"${'k'.repeat(3_000)}","alg":"HS256"}`)}.e30.sig `.repeat(250)],
  ])('masks a megabyte of %s within budget', (_label, value) => {
    expect(value.length).toBeGreaterThanOrEqual(1_000_000);
    const started = performance.now();
    redactJwt(value);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
