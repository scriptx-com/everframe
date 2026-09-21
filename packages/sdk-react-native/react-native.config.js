// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// React Native autolinking config for @traceitx/react-native.
//
// Why this file exists:
//   pnpm-workspace consumers symlink this package as
//   `node_modules/@traceitx/react-native -> ../../../../packages/sdk-react-native`.
//   Expo SDK 56 + RN community autolinking enumerate packages from the
//   consuming app's `node_modules` but skip symlinked scoped packages
//   without an explicit `react-native.config.js` marker — the package
//   is silently dropped from `Podfile.lock`, and `TurboModuleRegistry
//   .getEnforcing('TraceItX')` then throws at runtime because no native
//   module by that name was linked into the app binary.
//
// This file is the marker. The empty `platforms` blocks tell autolinking:
//   • iOS → discover via the existing `ios/TraceItX.podspec` (no overrides)
//   • Android → discover via the existing `android/build.gradle.kts` (no overrides)
//
// If you ever override codegen output paths, library name, etc., add the
// fields here; the schema is documented at
// https://github.com/react-native-community/cli/blob/main/docs/dependencies.md

module.exports = {
  dependency: {
    platforms: {
      ios: {},
      android: {},
    },
  },
};
