# @everframe/metro

## 0.1.0

### Minor Changes

- 93308e3: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Publish the build-artifact tooling. `@everframe/metro` stamps a build identity into Hermes bundles at bundle time, `@everframe/expo` adds the native build steps that collect the bundle, source map and native identifiers, and `@everframe/cli` verifies and uploads them so release crashes symbolicate. `@everframe/react-native` now reads the identity injected by `@everframe/metro`, so no build ID needs to be passed at runtime.

  `@everframe/bundler-plugin` adds Vite, Rollup, webpack, esbuild and Next.js plugins that stamp a build ID into web bundles and upload their source maps at the end of a production build. `everframe upload-expo-export` uploads the bundles and source maps from an `expo export` directory. `everframe setup react-native` patches the Gradle and Xcode build steps so native release builds collect and upload their artifacts.
