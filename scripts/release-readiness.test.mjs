// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (file) => readFileSync(file, 'utf8');
const manifest = (dir) => JSON.parse(read(`packages/${dir}/package.json`));
const releaseVersion = manifest('sdk-web').version;
const [major, minor] = releaseVersion.split('.').map(Number);
const nativeRange = `[${releaseVersion},${major}.${minor + 1}.0)`;
const fixedPackages = ['@everframe/web', '@everframe/react', '@everframe/react-native'];

test('published npm SDK versions are aligned for the coordinated release', () => {
  assert.deepEqual(JSON.parse(read('.changeset/config.json')).fixed, [fixedPackages]);
  for (const dir of ['sdk-web', 'sdk-react', 'sdk-react-native', 'identity', 'sdk-roku']) {
    assert.equal(manifest(dir).version, releaseVersion, dir);
    assert.notEqual(manifest(dir).private, true, dir);
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

// The iOS bridges call EverframeConfig(sdkKey:), which first ships in native
// 1.2.0. A pin below that resolves a published SDK without the initializer, and
// the bridge stops compiling at the customer's `pod install` or package resolve.
test('iOS bridges that call EverframeConfig(sdkKey:) require native 1.2.0 or newer', () => {
  const firstWithSdkKey = [1, 2, 0];
  const atLeast = (version, floor) => {
    for (let i = 0; i < floor.length; i += 1) {
      if (version[i] !== floor[i]) return version[i] > floor[i];
    }
    return true;
  };
  const pins = [
    ['packages/sdk-react-native/EverframeRN.podspec', /native_version_override\.empty\? \? '~> (\d+)\.(\d+)\.(\d+)'/],
    ['packages/everframe_flutter/ios/everframe_flutter.podspec', /'Everframe\/Core', '~> (\d+)\.(\d+)\.(\d+)'/],
    ['packages/everframe_flutter/ios/everframe_flutter.podspec', /'Everframe\/ReporterUI', '~> (\d+)\.(\d+)\.(\d+)'/],
    ['packages/everframe_flutter/ios/everframe_flutter/Package.swift', /\.upToNextMinor\(from: "(\d+)\.(\d+)\.(\d+)"\)/],
  ];
  for (const [file, pattern] of pins) {
    const match = read(file).match(pattern);
    assert.ok(match, `${file}: native pin not found`);
    const version = match.slice(1).map(Number);
    assert.ok(atLeast(version, firstWithSdkKey), `${file} pins native ${version.join('.')}`);
  }
  for (const file of [
    'packages/sdk-react-native/ios/Sources/EverframeBridge.swift',
    'packages/everframe_flutter/ios/everframe_flutter/Sources/everframe_flutter/EverframeFlutterPlugin.swift',
    'packages/everframe_kmp/ios/EverframeSwiftDriver.swift',
  ]) {
    assert.match(read(file), /EverframeConfig\(\s*sdkKey:/, file);
  }
});
