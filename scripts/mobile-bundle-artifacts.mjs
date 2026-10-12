// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import assert from 'node:assert/strict';

export function verifyMobileBundleArtifacts(actual, nativeEnabled = false) {
  const artifacts = [
    'protocol', 'core', 'reporter-ui', 'media3', 'gradle-plugin',
    'dev.everframe.gradle.plugin',
    'kmp', 'kmp-android', 'kmp-iosarm64', 'kmp-iossimulatorarm64', 'kmp-jvm', 'kmp-js',
  ];
  if (nativeEnabled) artifacts.push('native-crash');
  assert.deepEqual(actual.slice().sort(), artifacts.slice().sort(), 'Mobile bundle has unexpected Maven artifacts');
  return artifacts;
}
