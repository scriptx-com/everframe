// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (file) => readFileSync(file, 'utf8');
const packages = ['@everframe/web', '@everframe/react', '@everframe/react-native'];

test('Everframe npm SDKs form one fixed 0.9.0 release', () => {
  const config = JSON.parse(read('.changeset/config.json'));
  assert.deepEqual(config.fixed, [packages]);

  const changeset = read('.changeset/everframe-rebrand.md');
  for (const name of packages) assert.match(changeset, new RegExp(`"${name}": minor`));

  for (const file of ['packages/sdk-web/package.json', 'packages/sdk-react/package.json', 'packages/sdk-react-native/package.json']) {
    assert.equal(JSON.parse(read(file)).version, '0.8.2');
  }
});

test('native baselines remain unchanged and cutover properties are canonical', () => {
  assert.match(read('packages/sdk-android/android/gradle.properties'), /^everframeVersion=0\.8\.2$/m);
  assert.match(read('packages/sdk-ios/Everframe.podspec'), /s\.version\s+=\s+'0\.8\.2'/);
  assert.match(read('packages/sdk-ios/Package.binary.swift'), /let binaryVersion = "0\.8\.2"/);
});
