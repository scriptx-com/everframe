---
"@everframe/protocol": patch
"@everframe/sdk-android": patch
"@everframe/sdk-ios-marker": patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Android OS exit evidence (`payload.diagnostic.android`) gains an optional `mappingId`: the R8 mapping ID of the build the exited process ran, in the same format and from the same source as a JVM crash's `payload.crash.jvm.mappingId` (the ID the Everframe Gradle plugin packages in the APK, or `EverframeConfig.r8MappingId`). The SDK freezes it when the process arms exit capture, so an ANR, a low-memory kill or a native crash reported on the next launch names its own build's mapping even after an update, and an ANR stack can be retraced without a Java crash from that build. The generated Kotlin `Android` and Swift `EverframeAndroid` evidence types gain the field.
