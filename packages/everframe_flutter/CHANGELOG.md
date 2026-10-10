<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

## Unreleased

- The bridge passes the SDK key to the iOS SDK as `EverframeConfig(sdkKey:)` and to `@everframe/web` as `sdkKey`, matching those SDKs' renamed config, so the iOS plugin now requires native Everframe 1.2 (CocoaPods `~> 1.2.0`, SwiftPM up to the next minor from 1.2.0). The Dart API (`appId`, `sdkKey`) is unchanged.
- `start(crash:)` turns native crash capture on or off (default on). On Android the native SDK now captures JVM exceptions, native crashes and ANRs by default.

## 1.0.0

- Stable Android, iOS, and web reporting with privacy masking and native SDK 1.0.0 integration.

## 0.1.1

- Document published installation, Flutter capture setup, privacy boundaries, and support limits.

## 0.1.0

- Initial Android and iOS bridge with masked Flutter screenshots, bounded image replay, and native reporter integration.
