// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const read = (file) => readFileSync(file, 'utf8');
const manifest = (dir) => JSON.parse(read(`packages/${dir}/package.json`));
const releaseVersion = manifest('sdk-web').version;

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

// Every file that carries the release version, and what it must contain for `version`. All
// expectations derive from the version, so a patch release (native SDK and bridges on x.y.z)
// and a minor release pass the same checks.
function versionAlignmentProblems(version, readFile) {
  const [major, minor, patch] = version.split('.').map(Number);
  const nativeRange = `[${version},${major}.${minor + 1}.0)`;
  const problems = [];
  const expect = (file, needle) => {
    const text = readFile(file);
    const ok = needle instanceof RegExp ? needle.test(text) : text.includes(needle);
    if (!ok) problems.push(`${file}: expected ${needle}`);
  };
  for (const dir of [...Object.values(published), ...Object.values(nativeMarkers)]) {
    const pkg = JSON.parse(readFile(`packages/${dir}/package.json`));
    if (pkg.version !== version)
      problems.push(`packages/${dir}/package.json: version ${pkg.version}`);
  }
  // `prebuild` rewrites these from package.json. A stale committed literal makes every build
  // dirty the tree, which blocks the next production deploy's fast-forward of the SDK checkout.
  for (const dir of ['sdk-web', 'sdk-react'])
    expect(`packages/${dir}/src/internal/version.ts`, `PKG_VERSION = '${version}';`);
  expect(
    'packages/sdk-roku/library/components/Everframe/lib/ef_version.brs',
    `return "${version}"`,
  );
  for (const line of [
    `major_version=${major}`,
    `minor_version=${minor}`,
    `build_version=${patch}`,
  ]) {
    expect('packages/sdk-roku/library/manifest', new RegExp(`^${line}$`, 'm'));
  }
  expect('packages/everframe_flutter/pubspec.yaml', `version: ${version}\n`);
  expect('packages/everframe_flutter/lib/src/web_sdk_web.dart', `sdkVersion: '${version}'.toJS`);
  expect('packages/everframe_flutter/android/build.gradle.kts', `version = "${version}"`);
  expect('packages/everframe_flutter/ios/everframe_flutter.podspec', `s.version = '${version}'`);
  expect('packages/sdk-android/android/gradle.properties', `everframeVersion=${version}\n`);
  expect(
    'packages/sdk-ios/Everframe.podspec',
    new RegExp(`^\\s*spec\\.version\\s*=\\s*"${version.replaceAll('.', '\\.')}"`, 'm'),
  );
  for (const file of ['packages/sdk-ios/Package.binary.swift', 'Package.swift'])
    expect(file, `let binaryVersion = "${version}"`);
  // The bridges accept native patches within the release's minor line, from this release on.
  for (const file of [
    'packages/everframe_flutter/android/build.gradle.kts',
    'packages/sdk-react-native/android/build.gradle.kts',
  ]) {
    expect(file, nativeRange);
  }
  expect(
    'packages/everframe_flutter/ios/everframe_flutter.podspec',
    `'Everframe/Core', '~> ${version}'`,
  );
  expect(
    'packages/everframe_flutter/ios/everframe_flutter.podspec',
    `'Everframe/ReporterUI', '~> ${version}'`,
  );
  expect('packages/sdk-react-native/EverframeRN.podspec', `'~> ${version}'`);
  expect(
    'packages/everframe_flutter/ios/everframe_flutter/Package.swift',
    `.upToNextMinor(from: "${version}")`,
  );
  return problems;
}

// What a release bump does to the version-bearing files: every literal of the old version
// becomes the new one, the bridges' native range moves its upper bound for a minor release, and
// the Roku manifest takes the new components.
function bumpedReader(from, to) {
  const [fromMajor, fromMinor] = from.split('.').map(Number);
  const [toMajor, toMinor, toPatch] = to.split('.').map(Number);
  return (file) => {
    let text = read(file);
    if (file.endsWith('package.json')) return JSON.stringify({ ...JSON.parse(text), version: to });
    text = text
      .replaceAll(`,${fromMajor}.${fromMinor + 1}.0)`, `,${toMajor}.${toMinor + 1}.0)`)
      .replaceAll(from, to);
    if (file === 'packages/sdk-roku/library/manifest') {
      text = text
        .replace(/^major_version=.*$/m, `major_version=${toMajor}`)
        .replace(/^minor_version=.*$/m, `minor_version=${toMinor}`)
        .replace(/^build_version=.*$/m, `build_version=${toPatch}`);
    }
    return text;
  };
}

// Private workspace markers whose CHANGELOGs record the native Android and iOS releases.
const nativeMarkers = {
  '@everframe/sdk-android': 'sdk-android',
  '@everframe/sdk-ios-marker': 'sdk-ios',
};

test('every published npm package and native marker is in the one fixed changeset group', () => {
  const { fixed } = JSON.parse(read('.changeset/config.json'));
  assert.equal(fixed.length, 1);
  assert.deepEqual(
    [...fixed[0]].sort(),
    [...Object.keys(published), ...Object.keys(nativeMarkers)].sort(),
  );
});

test('the native markers carry the release version, so their CHANGELOGs share its heading', () => {
  for (const [name, dir] of Object.entries(nativeMarkers)) {
    const pkg = manifest(dir);
    assert.equal(pkg.name, name, dir);
    assert.equal(pkg.version, releaseVersion, dir);
    assert.equal(pkg.private, true, dir);
  }
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
  const dirs = readdirSync('packages', { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const dir of dirs) {
    if (!existsSync(`packages/${dir}/package.json`)) continue;
    const pkg = manifest(dir);
    if (pkg.private !== true)
      assert.ok(pkg.name in published, `${pkg.name} is publishable but not on the release line`);
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

test('every file that carries the release version matches it', () => {
  assert.deepEqual(versionAlignmentProblems(releaseVersion, read), []);
});

test('the alignment checks hold for a patch release where native and bridges share the patch', () => {
  const [major, minor, patch] = releaseVersion.split('.').map(Number);
  const next = `${major}.${minor}.${patch + 1}`;
  assert.deepEqual(versionAlignmentProblems(next, bumpedReader(releaseVersion, next)), []);
  // A bridge left on the previous release's floor fails the patch check.
  const stale = bumpedReader(releaseVersion, next);
  const staleRange = (file) =>
    file === 'packages/sdk-react-native/android/build.gradle.kts' ? read(file) : stale(file);
  assert.equal(versionAlignmentProblems(next, staleRange).length, 1);
});

test('the alignment checks hold for a minor release', () => {
  const [major, minor] = releaseVersion.split('.').map(Number);
  const next = `${major}.${minor + 1}.0`;
  assert.deepEqual(versionAlignmentProblems(next, bumpedReader(releaseVersion, next)), []);
});

test('Gradle coordinates the release depends on', () => {
  assert.match(read('packages/everframe_kmp/build.gradle.kts'), /version = mobileReleaseVersion/);
  assert.match(read('packages/everframe_kmp/build.gradle.kts'), /\.orElse\(mobileReleaseVersion\)/);
  assert.match(read('packages/everframe_kmp/settings.gradle.kts'), /^rootProject\.name = "kmp"$/m);
  assert.match(
    read('packages/sdk-android/android/everframe-gradle-plugin/build.gradle.kts'),
    /artifactId = "gradle-plugin"/,
  );
});
