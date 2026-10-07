---
"@everframe/react-native": minor
"@everframe/sdk-android": minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Add report delivery diagnostics. `getReportDeliveryStatus()` in `@everframe/react-native` and the native `Everframe.getReportDeliveryStatus()` on Android and iOS return a detached snapshot of cached observations: native capture outcomes per entry path, report outbox operations with the last observed queue count, and settled upload outcomes for live submissions and outbox drains. Snapshots contain only fixed codes and counters, perform no storage or network work, and reset when the SDK starts or is killed. With an older native SDK the React Native getter returns `unsupported/native-method-missing`, and the browser export returns `unsupported/platform`.
