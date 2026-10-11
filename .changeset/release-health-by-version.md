---
"@everframe/protocol": minor
"@everframe/sdk-android": minor
"@everframe/sdk-ios-marker": minor
"@everframe/react-native": minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Release health is keyed by app version. It is on by default; see the release health on-by-default changeset for how to configure or turn it off.

Release-health records are schema version 4 only, for Android and iOS foreground sessions. Each record carries `app: { version, build }`, which the SDK reads itself: Android's `versionName` (or `versionCode` as text when there is no usable `versionName`) and `versionCode`, and iOS's `CFBundleShortVersionString` (or `CFBundleVersion`) and `CFBundleVersion`. `nativeRelease`, the version 1–3 records and the web records are removed, so a receiver accepts version 4 only. Crash and error reports' `context.app.version` follows the same rule: an Android app without a usable `versionName` now reports its `versionCode` there, and an iOS app without `CFBundleShortVersionString` its `CFBundleVersion`, instead of `0.0.0`.

The crash pointer, `NativeExposurePointerSchema`, carries the same `app` in place of `nativeBuildId`. `build` is always present and is `null` when there is none. The generated Kotlin `NativeExposureApp` and Swift `EverframeNativeExposureApp` write that null explicitly, and the generated `App` and `EverframeApp` keep their names.

The `release_health.threshold_reached` webhook moves to event schema 2.0. One project rule sends one event per app version that drops below its crash-free target, with the version's platforms, the target, the last 7 days' session counts and `crashFreeSessions`. `RELEASE_HEALTH_ALERT_SCHEMA_VERSION` and `ReleaseHealthAlertTargetSchema` are new. The cohort schema and the `release_health.rate_threshold_reached` event are removed, and every other webhook event stays at 1.2.

`nativeBuildId` is removed from every SDK. In React Native, the unused `appVersion` and `appBuild` options are removed too.
