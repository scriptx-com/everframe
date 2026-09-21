// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(path, 'utf8');

test('CI runs public boundary, license, secret, JavaScript, and Android gates', () => {
  const workflow = read('.github/workflows/ci.yml');

  assert.match(workflow, /permissions:\s*\n\s+contents:\s*read/);
  assert.match(workflow, /node --test scripts\/public-boundary\.test\.mjs/);
  assert.match(workflow, /node scripts\/public-boundary\.mjs/);
  assert.match(workflow, /reuse lint/);
  assert.match(workflow, /gitleaks dir/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /pnpm (?:run )?build:packages/);
  assert.match(workflow, /pnpm (?:run )?test:packages/);
  assert.match(workflow, /pnpm (?:run )?typecheck:packages/);
  assert.match(workflow, /pnpm (?:run )?check:publish/);
  assert.match(workflow, /\.\/gradlew test assembleRelease publishAllToMavenLocal/);
  assert.match(workflow, /verify-android-publication\.sh/);
});

test('Apple CI covers SwiftPM and the credential-free tvOS sample only', () => {
  const workflow = read('.github/workflows/apple.yml');

  assert.match(workflow, /permissions:\s*\n\s+contents:\s*read/);
  assert.match(workflow, /swift test --package-path packages\/sdk-ios/);
  assert.match(workflow, /TRACEITX_DEV_INGEST_URL: http:\/\/127\.0\.0\.1:9/);
  assert.match(workflow, /xcodegen generate --spec examples\/tvos-replay\/project\.yml/);
  assert.match(workflow, /xcodebuild test/);
  assert.match(workflow, /-scheme ReplayTV/);
  assert.doesNotMatch(workflow, /admin|TRACEITX_ADMIN|drive-xctest|benchmark-runner|dashboard/i);
});

test('Dependabot covers each public dependency ecosystem', () => {
  const config = read('.github/dependabot.yml');

  for (const ecosystem of ['npm', 'gradle', 'swift', 'github-actions']) {
    assert.match(config, new RegExp(`package-ecosystem: ["']?${ecosystem}["']?`));
  }
});

test('published metadata points to the public MIT-licensed repository', () => {
  const manifests = execFileSync('rg', ['--files', 'packages', '-g', 'package.json'], {
    encoding: 'utf8',
  }).trim().split('\n');

  for (const path of manifests) {
    const manifest = JSON.parse(read(path));
    if (manifest.license !== undefined) {
      assert.equal(manifest.license, 'MIT', `${path} must publish as MIT`);
    }
  }

  const publishingFiles = execFileSync(
    'rg',
    ['--files', 'packages/sdk-android/android', '-g', '*.gradle.kts', '-g', 'README.md'],
    { encoding: 'utf8' },
  ).trim().split('\n');
  const publishingText = publishingFiles.map(read).join('\n');

  assert.doesNotMatch(publishingText, /binary-only|binary-distribution/i);
  assert.doesNotMatch(publishingText, /emptySourcesJar|emptyJavadocJar/);
  assert.doesNotMatch(publishingText, /github\.com\/scriptx\/traceitx(?:\.git|\/|\b)/);
  assert.doesNotMatch(publishingText, /name\.set\("Apache-2\.0"\)/);
  assert.match(read('packages/sdk-android/android/build.gradle.kts'), /withSourcesJar\(\)/);
  assert.match(read('packages/sdk-android/android/build.gradle.kts'), /org\.jetbrains\.dokka-javadoc/);
  assert.match(read('packages/sdk-android/android/build.gradle.kts'), /dokkaGeneratePublicationJavadoc/);
  assert.match(read('packages/sdk-android/android/build.gradle.kts'), /archiveClassifier\.set\("javadoc"\)/);

  const publicMetadata = execFileSync(
    'rg',
    ['--files', 'packages', '-g', 'package.json', '-g', '*.podspec', '-g', 'README.md', '-g', 'NOTICE'],
    { encoding: 'utf8' },
  ).trim().split('\n').map(read).join('\n');

  assert.doesNotMatch(publicMetadata, /github\.com\/scriptx-com\/traceitx(?!-releases)/);
  assert.doesNotMatch(publicMetadata, /github\.com\/scriptx\/traceitx/);
  assert.doesNotMatch(publicMetadata, /Apache-2\.0/);
});
