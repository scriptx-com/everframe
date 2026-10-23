<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

## Unreleased

- Simulator quick capture for Flutter apps on the iOS simulator and Android emulator (debug builds only). The native SDK never takes its own screenshot in a Flutter app, so quick capture stays ignored until `enableQuickCapture(boundaryKey:, sensitiveRegions:, replayBuffer:)` supplies masked Flutter evidence. Each capture then sends the same masked screenshot as `openReporter`, plus, when session replay is enabled for the app, a snapshot of the replay buffer's masked frames. The dashboard's capture-hotkey replay force does not apply to Flutter replay. A capture whose masked frame cannot be produced safely fails, and no image is sent. `disableQuickCapture()` removes the registration.
- `start(quickCapture: false)` opts the app out of quick capture.

## 1.4.0

- Align the plugin and its Android, iOS, and web SDK dependency versions with the coordinated Everframe 1.4.0 release.
- The Dart API and Flutter bridge implementation are unchanged from 1.3.0.

## 1.3.0

- Native release-health sessions are enabled by default. `releaseHealth: false` opts out without disabling error reports; `crash: false` disables both. Native `start(debugBuild:)` forwards an explicit build flag. Dart errors remain outside the native crash rate.
- The web bridge forwards the health opt-out to Web SDK 1.2.2+, applies changed settings on repeated starts, and cancels deferred initialization when killed.

## 1.2.1

- The plugin ships on the same version as every other Everframe SDK. Its Android and iOS bridges resolve the native SDK of that exact version and any later patch on the same minor line.
- The native and web SDKs take the SDK key only as `sdkKey`: `EverframeConfig(appId:)` on iOS and the `apiKey` config field on the web are gone. The bridges already pass `sdkKey`, so the Dart API (`appId`, `sdkKey`) is unchanged.
- Errors captured with `captureException` from Flutter don't carry a session replay; the error-replay support in the native and web SDKs doesn't apply to Flutter apps.

## 1.2.0

- The Android bridge resolves native Everframe 1.2.x (`[1.2.0,1.3.0)`, was `[1.0.0,1.1.0)`) and, like the iOS bridge, turns release health off: native 1.2 enables it by default and this plugin has no option for it yet.
- `EverframeWebBridge.start(debugBuild:)` says whether this is a debug build; Everframe never turns a debug build into a release. It passes the value to `@everframe/web`; null leaves detection to the web SDK. The Android and iOS plugins have no `debugBuild` option: the native SDKs detect debug builds themselves.

- The bridge passes the SDK key to the iOS SDK as `EverframeConfig(sdkKey:)` and to `@everframe/web` as `sdkKey`, matching those SDKs' renamed config, so the iOS plugin now requires native Everframe 1.2 (CocoaPods `~> 1.2.0`, SwiftPM up to the next minor from 1.2.0). The Dart API (`appId`, `sdkKey`) is unchanged.
- `start(crash:)` turns native crash capture on or off (default on). On Android the native SDK now captures JVM exceptions, native crashes and ANRs by default.

## 1.0.0

- Stable Android, iOS, and web reporting with privacy masking and native SDK 1.0.0 integration.

## 0.1.1

- Document published installation, Flutter capture setup, privacy boundaries, and support limits.

## 0.1.0

- Initial Android and iOS bridge with masked Flutter screenshots, bounded image replay, and native reporter integration.
