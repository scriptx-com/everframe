---
"@everframe/sdk-android": patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Android: `reporter-ui` now builds with Compose BOM 2025.07.00 (Compose 1.8.3, Material3 1.3.2), which needs androidx.lifecycle 2.8.7 instead of 2.9.4. With 2.9.4, an app on AGP 8.7 failed `assembleRelease` in `lintVitalAnalyzeRelease` (`IncompatibleClassChangeError` in `NonNullableMutableLiveDataDetector`): the lint checks shipped with lifecycle 2.9 and Compose runtime 1.9 need a newer AGP. Apps that use newer Compose or lifecycle versions themselves still resolve those. The reporter uses no Compose 1.9 or Material3 1.4 API.
