// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyMobileBundleArtifacts } from './mobile-bundle-artifacts.mjs';

const existing = ['protocol', 'core', 'reporter-ui', 'media3', 'gradle-plugin',
  'dev.everframe.gradle.plugin', 'kmp', 'kmp-android', 'kmp-iosarm64',
  'kmp-iossimulatorarm64', 'kmp-jvm', 'kmp-js'];
test('default bundle retains precisely the established publications', () => {
  assert.deepEqual(verifyMobileBundleArtifacts(existing).sort(), existing.slice().sort());
  assert.throws(() => verifyMobileBundleArtifacts([...existing, 'native-crash']));
});
test('explicit native bundle requires the optional artifact', () => {
  assert.deepEqual(verifyMobileBundleArtifacts([...existing, 'native-crash'], true).sort(), [...existing, 'native-crash'].sort());
  assert.throws(() => verifyMobileBundleArtifacts(existing, true));
});
test('both bundle modes reject arbitrary extra artifacts and missing existing artifacts', () => {
  for (const enabled of [false, true]) {
    const expected = enabled ? [...existing, 'native-crash'] : existing;
    assert.throws(() => verifyMobileBundleArtifacts([...expected, 'unexpected'], enabled));
    assert.throws(() => verifyMobileBundleArtifacts(expected.filter(x => x !== 'core'), enabled));
  }
});
