---
"@everframe/sdk-android": patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

`dev.everframe:core` now declares `android.permission.INTERNET`, and Gradle's manifest merger adds it to the app. A new Android Studio project declares no permissions, so an app that followed the install steps sent nothing until the developer added it by hand. The SDK declares no other permission.
