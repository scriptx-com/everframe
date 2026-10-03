---
"@everframe/cli": minor
"@everframe/metro": minor
"@everframe/expo": minor
"@everframe/react-native": patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Publish the build-artifact tooling. `@everframe/metro` stamps a build identity into Hermes bundles at bundle time, `@everframe/expo` adds the native build steps that collect the bundle, source map and native identifiers, and `@everframe/cli` verifies and uploads them so release crashes symbolicate. `@everframe/react-native` now reads the identity injected by `@everframe/metro`, so no build ID needs to be passed at runtime.
