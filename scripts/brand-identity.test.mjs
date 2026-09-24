// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./brand-identity.mjs', import.meta.url));
const former = 'trace' + 'itx';
const formerDisplay = 'Trace' + 'ItX';

function fixture(files, exceptions = []) {
  const root = mkdtempSync(path.join(tmpdir(), 'everframe-brand-'));
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  writeFileSync(path.join(root, 'brand-identity.json'), JSON.stringify({ exceptions }));
  const init = spawnSync('git', ['init', '--quiet', root], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const add = spawnSync('git', ['-C', root, 'add', '.'], { encoding: 'utf8' });
  assert.equal(add.status, 0, add.stderr);
  return root;
}

function scan(root) {
  return spawnSync(process.execPath, [scanner, '--root', root], { encoding: 'utf8' });
}

function commitFixture(root) {
  const commit = spawnSync(
    'git',
    ['-C', root, '-c', 'user.name=Everframe Test', '-c', 'user.email=test@everframe.dev', 'commit', '--quiet', '-m', 'fixture'],
    { encoding: 'utf8' },
  );
  assert.equal(commit.status, 0, commit.stderr);
  return spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
}

function historicalFingerprintFixture(fingerprint) {
  const historicalPath = `legacy/${former}-client.ts`;
  const root = fixture({ [historicalPath]: "export const apiKey = 'synthetic';\n" });
  const commit = commitFixture(root);
  rmSync(path.join(root, historicalPath));
  writeFileSync(path.join(root, '.gitleaksignore'), `${fingerprint({ commit, historicalPath })}\n`);
  const add = spawnSync('git', ['-C', root, 'add', '--all'], { encoding: 'utf8' });
  assert.equal(add.status, 0, add.stderr);
  return { root, commit, historicalPath };
}

function run(files, exceptions = [], untrackedFiles = {}) {
  const root = fixture(files, exceptions);
  try {
    for (const [relativePath, contents] of Object.entries(untrackedFiles)) {
      const target = path.join(root, relativePath);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, contents);
    }
    return scan(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('rejects old identity text with file, match, and reason', () => {
  const result = run({ 'src/client.ts': `export const client = '@${former}/web';\n` });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, new RegExp(`src/client\\.ts:1:.*@${former}.*active identity`));
});

test('rejects old directory and filename segments', () => {
  const result = run({
    [`packages/${former}/index.ts`]: 'export const value = 1;\n',
    [`src/with-${former}.ts`]: 'export const value = 2;\n',
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, new RegExp(`packages/${former}/index\\.ts:.*${former}.*path`));
  assert.match(result.stderr, new RegExp(`src/with-${former}\\.ts:.*${former}.*path`));
});

test('recognizes native, generated, environment, and HTTP identity spellings', () => {
  const generated = 'Trace' + 'itxVideoV1';
  const header = `X-${formerDisplay}-Relay`;
  const result = run({
    'src/identities.txt': `com.${former}.sdk\n${generated}\n${former.toUpperCase()}_KEY\n${header}\n`,
  });
  assert.equal(result.status, 1, result.stderr);
  for (const spelling of [`com.${former}.sdk`, generated, `${former.toUpperCase()}_KEY`, header]) {
    assert.ok(result.stderr.includes(JSON.stringify(spelling)), `${spelling} was not reported`);
  }
});

test('does not include sentence punctuation in a package identity match', () => {
  const result = run({ 'docs/history.md': `Former package: @${former}/web.\n` });
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stderr.includes(JSON.stringify(`@${former}/web`)));
  assert.ok(!result.stderr.includes(JSON.stringify(`@${former}/web.`)));
});

test('accepts an exact persisted reader with a reason', () => {
  const legacy = `${former}-video-v1`;
  const result = run(
    { 'src/reader.ts': `export const legacy = '${legacy}';\n` },
    [{ path: 'src/reader.ts', pattern: legacy, reason: 'Read existing stored videos' }],
  );
  assert.equal(result.status, 0, result.stderr);
});

test('accepts one contextual historical phrase without suppressing other uses', () => {
  const phrase = `${formerDisplay} SDK v0.8.0`;
  const result = run(
    { 'docs/history.md': `Released ${phrase}.\nCurrent package: @${former}/web.\n` },
    [{ path: 'docs/history.md', pattern: phrase, reason: 'Historical release record' }],
  );
  assert.equal(result.status, 1, result.stderr);
  assert.doesNotMatch(result.stderr, new RegExp(`${formerDisplay}.*active identity`));
  assert.match(result.stderr, new RegExp(`@${former}.*active identity`));
});

test('accepts a commit-scoped Gitleaks fingerprint for a historical path and line', () => {
  const { root } = historicalFingerprintFixture(
    ({ commit, historicalPath }) => `${commit}:${historicalPath}:generic-api-key:1`,
  );
  try {
    const result = scan(root);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a valid historical fingerprint does not exempt adjacent old identity text', () => {
  const { root } = historicalFingerprintFixture(
    ({ commit, historicalPath }) =>
      `${commit}:${historicalPath}:generic-api-key:1\n# Do not restore ${former} branding`,
  );
  try {
    const result = scan(root);
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stderr, /\.gitleaksignore:1:.*active identity/);
    assert.match(result.stderr, /\.gitleaksignore:2:.*active identity/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [name, fingerprint] of [
  ['path-only fingerprint', ({ historicalPath }) => `${historicalPath}:generic-api-key:1`],
  ['unknown commit', ({ historicalPath }) => `${'0'.repeat(40)}:${historicalPath}:generic-api-key:1`],
  ['missing historical path', ({ commit }) => `${commit}:legacy/${former}-missing.ts:generic-api-key:1`],
  ['out-of-range historical line', ({ commit, historicalPath }) => `${commit}:${historicalPath}:generic-api-key:2`],
  ['malformed rule', ({ commit, historicalPath }) => `${commit}:${historicalPath}:Generic API Key:1`],
]) {
  test(`rejects a ${name} containing an old identity`, () => {
    const { root } = historicalFingerprintFixture(fingerprint);
    try {
      const result = scan(root);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /\.gitleaksignore:1:.*active identity/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('rejects stale exceptions after the old reader is removed', () => {
  const legacy = `${former}-video-v1`;
  const result = run(
    { 'src/reader.ts': "export const current = 'everframe-video-v1';\n" },
    [{ path: 'src/reader.ts', pattern: legacy, reason: 'Read existing stored videos' }],
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, new RegExp(`src/reader\\.ts:.*${legacy}.*stale exception.*Read existing stored videos`));
});

test('rejects directory-wide and wildcard exceptions', () => {
  const legacy = `${former}-video-v1`;
  const result = run(
    { 'src/reader.ts': `export const legacy = '${legacy}';\n` },
    [
      { path: 'src/', pattern: legacy, reason: 'All readers' },
      { path: 'src/reader.ts', pattern: `${former}.*`, reason: 'Every old name' },
    ],
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /src\/:.*invalid exception path/);
  assert.match(result.stderr, /src\/reader\.ts:.*invalid exception pattern/);
  assert.match(result.stderr, new RegExp(`src/reader\\.ts:1:.*${legacy}.*active identity`));
});

test('rejects generic name and empty-reason exceptions', () => {
  const result = run(
    { 'src/client.ts': `export const name = '${formerDisplay}';\n` },
    [{ path: 'src/client.ts', pattern: formerDisplay, reason: '' }],
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /invalid exception pattern/);
  assert.match(result.stderr, /missing reason/);
});

for (const [name, pattern] of [
  ['display punctuation', `${formerDisplay}.`],
  ['display whitespace', ` ${formerDisplay} `],
  ['lowercase punctuation', `${former}!`],
  ['generated-case punctuation', `Trace${former.slice(5)}.`],
  ['package-scope punctuation', `@${former},`],
  ['native-namespace punctuation', `com.${former}.`],
  ['environment-prefix punctuation', `${former.toUpperCase()}_.`],
  ['HTTP-header-prefix punctuation', `X-${formerDisplay}-.`],
]) {
  test(`rejects ${name} around a generic exception`, () => {
    const result = run(
      { 'docs/history.md': `${pattern}\n${pattern}\n` },
      [{ path: 'docs/history.md', pattern, reason: 'Historical text' }],
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /invalid exception pattern/);
    assert.match(result.stderr, /active identity in text/);
  });
}

test('scans tracked text only and orders diagnostics by path', () => {
  const root = fixture({
    'src/z.ts': `export const name = '${formerDisplay}';\n`,
    'src/a.ts': `export const key = '${former.toUpperCase()}_KEY';\n`,
    'assets/old.bin': Buffer.from([0, 255, 0]),
  });
  try {
    mkdirSync(path.join(root, 'node_modules', former), { recursive: true });
    writeFileSync(path.join(root, 'node_modules', former, 'index.js'), former);
    writeFileSync(path.join(root, 'src', 'untracked.ts'), former);
    const first = scan(root);
    const second = scan(root);
    assert.equal(first.status, 1, first.stderr);
    assert.equal(first.stderr, second.stderr);
    assert.ok(first.stderr.indexOf('src/a.ts') < first.stderr.indexOf('src/z.ts'));
    assert.doesNotMatch(first.stderr, /untracked|node_modules|old\.bin/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
