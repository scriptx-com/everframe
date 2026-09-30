// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (file) => readFileSync(file, 'utf8');
const packages = ['@everframe/web', '@everframe/react', '@everframe/react-native'];

test('Everframe npm SDKs remain on their fixed 0.9.0 release', () => {
  const config = JSON.parse(read('.changeset/config.json'));
  assert.deepEqual(config.fixed, [packages]);

  for (const file of ['packages/sdk-web/package.json', 'packages/sdk-react/package.json', 'packages/sdk-react-native/package.json']) {
    assert.equal(JSON.parse(read(file)).version, '0.9.0');
  }
  assert.equal(JSON.parse(read('packages/identity/package.json')).version, '0.3.0');
});

test('Flutter and KMP native dependencies match the native 0.10.1 release', () => {
  assert.match(read('packages/everframe_flutter/pubspec.yaml'), /^version: 0\.1\.1$/m);
  assert.match(read('packages/everframe_flutter/android/build.gradle.kts'), /^version = "0\.1\.1"$/m);
  assert.match(read('packages/everframe_flutter/ios/everframe_flutter.podspec'), /s\.version = '0\.1\.1'/);
  assert.match(read('packages/sdk-android/android/gradle.properties'), /^everframeVersion=0\.10\.1$/m);
  assert.match(read('packages/sdk-ios/Everframe.podspec'), /spec\.version\s+=\s+"0\.10\.1"/);
  assert.match(read('packages/sdk-ios/Package.binary.swift'), /let binaryVersion = "0\.10\.1"/);
  assert.match(read('packages/everframe_flutter/android/build.gradle.kts'), /\[0\.10\.0,0\.11\.0\)/);
  assert.match(read('packages/everframe_flutter/ios/everframe_flutter.podspec'), /~> 0\.10\.1/);
  assert.match(read('packages/everframe_kmp/build.gradle.kts'), /\[0\.10\.0,0\.11\.0\)/);
});
