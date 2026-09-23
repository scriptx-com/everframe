// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const read = (path) => readFileSync(path, 'utf8');
const ignoredDirectories = new Set([
  '.build',
  '.git',
  '.gradle',
  '.swc',
  '.turbo',
  'DerivedData',
  'build',
  'dist',
  'node_modules',
  'target',
]);

function filesUnder(directory, include, output = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) {
      filesUnder(entryPath, include, output);
    } else if (entry.isFile() && include(entryPath)) {
      output.push(entryPath);
    }
  }
  return output.sort();
}

test('CI runs public boundary, license, secret, JavaScript, and Android gates', () => {
  const workflow = read('.github/workflows/ci.yml');

  assert.match(workflow, /permissions:\s*\n\s+contents:\s*read/);
  assert.match(workflow, /node --test scripts\/public-boundary\.test\.mjs/);
  assert.match(workflow, /node scripts\/public-boundary\.mjs/);
  assert.match(workflow, /pnpm check:brand/);
  assert.match(workflow, /reuse lint/);
  assert.match(workflow, /gitleaks dir/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /pnpm (?:run )?build:packages/);
  assert.match(workflow, /pnpm (?:run )?test:packages/);
  assert.match(workflow, /pnpm (?:run )?typecheck:packages/);
  assert.match(workflow, /pnpm (?:run )?check:publish/);
  assert.match(workflow, /\.\/gradlew test assembleRelease publishAllToMavenLocal/);
  assert.match(workflow, /-PeverframeVersion=0\.0\.0-ci/);
  assert.match(workflow, /verify-android-publication\.sh/);
});

test('Apple CI runs serialized SwiftPM unit tests only', () => {
  const workflow = read('.github/workflows/apple.yml');

  assert.match(workflow, /permissions:\s*\n\s+contents:\s*read/);
  assert.match(workflow, /swift test --package-path packages\/sdk-ios --no-parallel/);
  assert.match(workflow, /EVERFRAME_DEV_INGEST_URL: http:\/\/127\.0\.0\.1:9/);
  assert.doesNotMatch(workflow, /xcodegen|xcodebuild|ReplayTV/);
  assert.doesNotMatch(workflow, /admin|EVERFRAME_ADMIN|drive-xctest|benchmark-runner|dashboard/i);
});

test('Dependabot covers each public dependency ecosystem', () => {
  const config = read('.github/dependabot.yml');

  for (const ecosystem of ['npm', 'gradle', 'swift', 'github-actions']) {
    assert.match(config, new RegExp(`package-ecosystem: ["']?${ecosystem}["']?`));
  }
});

test('published metadata points to the public MIT-licensed repository', () => {
  const manifests = filesUnder('packages', (file) => path.basename(file) === 'package.json');

  for (const manifestPath of manifests) {
    const manifest = JSON.parse(read(manifestPath));
    if (manifest.license !== undefined) {
      assert.equal(manifest.license, 'MIT', `${manifestPath} must publish as MIT`);
    }
  }

  const publishingFiles = filesUnder(
    'packages/sdk-android/android',
    (file) => file.endsWith('.gradle.kts') || path.basename(file) === 'README.md',
  );
  const publishingText = publishingFiles.map(read).join('\n');

  assert.doesNotMatch(publishingText, /binary-only|binary-distribution/i);
  assert.doesNotMatch(publishingText, /emptySourcesJar|emptyJavadocJar/);
  assert.doesNotMatch(
    publishingText,
    new RegExp(`github\\.com/scriptx/${'trace' + 'itx'}(?:\\.git|/|\\b)`),
  );
  assert.doesNotMatch(publishingText, /name\.set\("Apache-2\.0"\)/);
  assert.match(read('packages/sdk-android/android/build.gradle.kts'), /withSourcesJar\(\)/);
  assert.match(read('packages/sdk-android/android/build.gradle.kts'), /org\.jetbrains\.dokka-javadoc/);
  assert.match(read('packages/sdk-android/android/build.gradle.kts'), /dokkaGeneratePublicationJavadoc/);
  assert.match(read('packages/sdk-android/android/build.gradle.kts'), /archiveClassifier\.set\("javadoc"\)/);

  const publicMetadata = filesUnder('packages', (file) => {
    const basename = path.basename(file);
    return basename === 'package.json'
      || basename === 'README.md'
      || basename === 'NOTICE'
      || file.endsWith('.podspec');
  }).map(read).join('\n');

  const former = 'trace' + 'itx';
  assert.doesNotMatch(publicMetadata, new RegExp(`github\\.com/scriptx-com/${former}`));
  assert.doesNotMatch(publicMetadata, new RegExp(`github\\.com/scriptx/${former}`));
  assert.doesNotMatch(publicMetadata, /Apache-2\.0/);
});
