// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const read = (file) => readFileSync(file, 'utf8');
const manifest = (dir) => JSON.parse(read(`packages/${dir}/package.json`));
const releaseVersion = manifest('sdk-web').version;
const [major, minor] = releaseVersion.split('.').map(Number);
const nativeRange = `[${releaseVersion},${major}.${minor + 1}.0)`;
// Every published npm package ships on one version line, which the native SDKs share.
const published = {
  '@everframe/web': 'sdk-web',
  '@everframe/react': 'sdk-react',
  '@everframe/react-native': 'sdk-react-native',
  '@everframe/identity': 'identity',
  '@everframe/roku': 'sdk-roku',
  '@everframe/vega': 'sdk-vega',
  '@everframe/cli': 'cli',
  '@everframe/metro': 'metro',
  '@everframe/bundler-plugin': 'bundler-plugin',
  '@everframe/expo': 'expo',
};

test('every published npm package is in the one fixed changeset group', () => {
  const { fixed } = JSON.parse(read('.changeset/config.json'));
  assert.equal(fixed.length, 1);
  assert.deepEqual([...fixed[0]].sort(), Object.keys(published).sort());
});

test('every published npm package is publishable at the release version', () => {
  for (const [name, dir] of Object.entries(published)) {
    const pkg = manifest(dir);
    assert.equal(pkg.name, name, dir);
    assert.equal(pkg.version, releaseVersion, dir);
    assert.notEqual(pkg.private, true, dir);
    assert.equal(pkg.publishConfig?.access, 'public', dir);
  }
});

test('no other workspace package is published', () => {
  const dirs = readdirSync('packages', { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  for (const dir of dirs) {
    if (!existsSync(`packages/${dir}/package.json`)) continue;
    const pkg = manifest(dir);
    if (pkg.private !== true) assert.ok(pkg.name in published, `${pkg.name} is publishable but not on the release line`);
  }
});

test('internal dependencies between published packages follow the workspace version', () => {
  for (const dir of Object.values(published)) {
    const pkg = manifest(dir);
    for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.peerDependencies })) {
      if (name in published) assert.equal(range, 'workspace:^', `${dir} -> ${name}`);
    }
  }
});

test('committed source versions match the release, so a build leaves the checkout clean', () => {
  // `prebuild` rewrites these from package.json. A stale committed literal makes every build
  // dirty the tree, which blocks the next production deploy's fast-forward of the SDK checkout.
  for (const dir of ['sdk-web', 'sdk-react']) {
    assert.ok(read(`packages/${dir}/src/internal/version.ts`).includes(`PKG_VERSION = '${releaseVersion}';`), dir);
  }
  assert.ok(read('packages/sdk-roku/library/components/Everframe/lib/ef_version.brs').includes(`return "${releaseVersion}"`));
  const [rokuMajor, rokuMinor, rokuBuild] = releaseVersion.split('.');
  const rokuManifest = read('packages/sdk-roku/library/manifest');
  for (const line of [`major_version=${rokuMajor}`, `minor_version=${rokuMinor}`, `build_version=${rokuBuild}`]) {
    assert.match(rokuManifest, new RegExp(`^${line}$`, 'm'));
  }
});

test('mobile versions and consumer dependency ranges match the release', () => {
  assert.ok(read('packages/everframe_flutter/pubspec.yaml').includes(`version: ${releaseVersion}\n`));
  assert.ok(read('packages/everframe_flutter/lib/src/web_sdk_web.dart').includes(`sdkVersion: '${releaseVersion}'.toJS`));
  assert.ok(read('packages/everframe_flutter/android/build.gradle.kts').includes(`version = "${releaseVersion}"`));
  assert.ok(read('packages/everframe_flutter/ios/everframe_flutter.podspec').includes(`s.version = '${releaseVersion}'`));
  assert.ok(read('packages/sdk-android/android/gradle.properties').includes(`everframeVersion=${releaseVersion}\n`));
  assert.equal(read('packages/sdk-ios/Everframe.podspec').match(/^\s*spec\.version\s*=\s*"([^"]+)"/m)?.[1], releaseVersion);
  for (const file of ['packages/sdk-ios/Package.binary.swift', 'Package.swift']) {
    assert.ok(read(file).includes(`let binaryVersion = "${releaseVersion}"`), file);
  }
  for (const file of ['packages/everframe_flutter/android/build.gradle.kts', 'packages/sdk-react-native/android/build.gradle.kts']) {
    assert.ok(read(file).includes(nativeRange), file);
  }
  for (const file of ['packages/everframe_flutter/ios/everframe_flutter.podspec', 'packages/sdk-react-native/EverframeRN.podspec']) {
    assert.ok(read(file).includes(`~> ${releaseVersion}`), file);
  }
  assert.ok(read('packages/everframe_flutter/ios/everframe_flutter/Package.swift').includes(`.upToNextMinor(from: "${releaseVersion}")`));
  assert.match(read('packages/everframe_kmp/build.gradle.kts'), /version = mobileReleaseVersion/);
  assert.match(read('packages/everframe_kmp/build.gradle.kts'), /\.orElse\(mobileReleaseVersion\)/);
  assert.match(read('packages/everframe_kmp/settings.gradle.kts'), /^rootProject\.name = "kmp"$/m);
  assert.match(read('packages/sdk-android/android/everframe-gradle-plugin/build.gradle.kts'), /artifactId = "gradle-plugin"/);
});
