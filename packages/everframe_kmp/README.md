<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Everframe KMP bridge (unreleased dry run)

`EverframeKmp` shares start, user, screen, breadcrumb, reporter, and kill calls. The Android driver delegates to the existing Android SDK. On iOS, `EverframeSwiftDriver` implements the Objective-C protocol exported by Kotlin/Native and delegates to the existing Swift SDK. This lets a SwiftUI/UIKit host use shared Kotlin logic without importing a Swift-only SDK into Kotlin/Native.

The bridge accepts only `development` and uses local development SDK artifacts. Automatic native screenshots and crash capture are off, but opening the native reporter can still take a **manual** screenshot. Android Compose hosts must use `Modifier.txSensitive()` for sensitive content; the iOS Compose probe demonstrates a marked UIKit overlay whose bounds follow a Compose element. Each host must verify its own privacy geometry. All three mobile hosts submitted to a local fake ingest; Android attached bounded masked image replay, while both iOS hosts used native video. The library does not yet route handled Kotlin errors or network context, or prove production delivery. Do not publish or use it with customer data.

See [mobile dry-run evidence](../../docs/dry-runs/kmp-mobile-bridge.md) for build commands and current gates.
