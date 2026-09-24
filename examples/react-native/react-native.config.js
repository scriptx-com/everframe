// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// RN community CLI / Expo autolinking config for the sample app.
//
// Why this file exists:
//   Expo SDK 56's autolinking enumerates `node_modules/` of the host app
//   and registers packages with `peerDependencies.react-native`. In pnpm
//   monorepos, scoped workspace packages live as symlinks at
//   `node_modules/@scope/name -> ../../../packages/name`. Some autolinking
//   codepaths skip these symlinks silently — the result is the SDK pod
//   never lands in `Podfile.lock`, and `TurboModuleRegistry
//   .getEnforcing('Everframe')` throws at runtime.
//
// This file forces the discovery by hand. The `root` path points at the
// real source location (not the symlink) so autolinking reads the
// `ios/Everframe.podspec` + `android/build.gradle.kts` directly. Empty
// platform blocks tell autolinking: "use the package's defaults — no
// overrides for codegen, components, or library name."

const path = require('path');

const workspaceRoot = path.resolve(__dirname, '../..');

module.exports = {
  dependencies: {
    '@everframe/react-native': {
      root: path.resolve(workspaceRoot, 'packages/sdk-react-native'),
      platforms: {
        ios: {},
        android: {},
      },
    },
  },
};
