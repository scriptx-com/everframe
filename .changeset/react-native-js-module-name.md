---
'@everframe/react-native': patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

The Android bridge compiles on React Native 0.88. The root-view check now calls `ReactRootView.getJSModuleName()` explicitly instead of using the Kotlin `jsModuleName` property, which the React Native 0.88 Kotlin toolchain no longer resolves. Apps that patched this line can drop the patch.
