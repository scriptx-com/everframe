---
"@everframe/sdk-android": patch
"@everframe/react-native": patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Android: JVM crashes, handled exceptions and React Native JavaScript crashes now report the device's `sdk.formFactor` (`tv` on Android TV and Fire TV, from the television UI mode or the leanback feature) instead of always `phone`. OS exit, ANR and reporter envelopes already did. `EnvelopeBuilder.buildEncoded` now requires `formFactor`, so no envelope path can fall back to a default.
