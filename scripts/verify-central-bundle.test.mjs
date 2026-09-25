// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const verifier = path.join(root, 'scripts/verify-central-bundle.sh');

test('Central bundle verifier exists and rejects unsigned Maven artifacts', () => {
  assert.equal(existsSync(verifier), true, 'scripts/verify-central-bundle.sh must exist');
  const repository = mkdtempSync(path.join(tmpdir(), 'everframe-central-'));
  try {
    const directory = path.join(repository, 'dev/everframe/core/0.9.0');
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'core-0.9.0.pom'), '<project><groupId>dev.everframe</groupId></project>');
    const result = spawnSync('bash', [verifier, repository, '0.9.0'], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /signature|\.asc/i);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test('Gradle plugin applies Central-required ownership metadata to every publication', () => {
  const buildFile = readFileSync(
    path.join(root, 'packages/sdk-android/android/everframe-gradle-plugin/build.gradle.kts'),
    'utf8',
  );
  const configureEach = buildFile.slice(buildFile.indexOf('publications.withType<MavenPublication>().configureEach'));
  assert.match(configureEach, /developers\s*\{/);
  assert.match(configureEach, /scm\s*\{/);
  assert.match(configureEach, /issueManagement\s*\{/);
  assert.match(configureEach, /https:\/\/github\.com\/scriptx-com\/everframe/);
});
