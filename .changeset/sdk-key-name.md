---
"@everframe/sdk-core": minor
"@everframe/web": minor
"@everframe/react": minor
"@everframe/react-native": minor
"@everframe/sdk-ios-marker": minor
"@everframe/sdk-android": minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Breaking: renamed apiKey/appId to sdkKey. Every SDK now names the app's SDK key (`evf_live_…`) `sdkKey`, and `appId` means only the App ID (the UUID that symbol and source-map uploads take).

- Web, React and React Native: the config field `apiKey` is now `sdkKey`, for example `init({ sdkKey: 'evf_live_…' })` and `<EverframeProvider config={{ sdkKey: 'evf_live_…' }}>`.
- iOS and tvOS: `EverframeConfig(appId:)` is now `EverframeConfig(sdkKey:)`, the `appId` property is now `sdkKey`, and `EverframeConfigError.missingAppId` is now `EverframeConfigError.missingSdkKey`. `ReplaySession(baseURL:apiKey:locallyDisabled:)` is now `ReplaySession(baseURL:sdkKey:locallyDisabled:)`.
- Android: `EverframeConfig(appId, sdkKey)` already used these names and is unchanged. The internal `ReplaySession`, `ReplayConfigProvider` and `VitalsTransport` parameters named `apiKey` are now `sdkKey`.
- The Flutter and Kotlin Multiplatform bridges already took `appId` and `sdkKey`; they now pass the key to the iOS SDK and to `@everframe/web` under the new names.

There are no deprecated aliases: rename the field where you configure the SDK. Nothing on the wire changed. Requests still carry the key as `Authorization: Bearer <key>`, and the web vitals beacon still sends it in the `apiKey` body field, so clients on 1.1.0 and earlier keep working against the same server.
