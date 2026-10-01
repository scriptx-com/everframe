<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# @everframe/sdk-android

## 1.2.1

### Patch Changes

- afb0687: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Fix regressions from the Everframe rename. The Android SDK (and React Native on Android) now sends the `X-Everframe-*` header names the API reads, so native video session replay, verified identity and companion report attribution work again. In development under React StrictMode, `EverframeProvider` no longer keeps running with a killed client after the double mount, so two-way replies reach the reporter again.
