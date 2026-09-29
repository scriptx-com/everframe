<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Everframe KMP bridge

`EverframeKmp` shares start, user, screen, breadcrumb, handled-error, safe network-operation, reporter, and kill calls. The Android driver delegates to the existing Android SDK. On iOS, `EverframeSwiftDriver` implements the Objective-C protocol exported by Kotlin/Native and delegates to the existing Swift SDK. This lets a SwiftUI/UIKit host use shared Kotlin logic without importing a Swift-only SDK into Kotlin/Native.

The bridge starts the native SDK in `production` by default and also accepts `development` and `staging`. Native release artifacts own the production ingest endpoint. Automatic screenshots are off, but the native reporter takes a **manual** screenshot. Native crash capture is on because the native SDK gates handled-error capture behind the same flag. Network metadata is on and network bodies are vetoed. Android Compose hosts must use `Modifier.txSensitive()` for sensitive content; the iOS Compose probe demonstrates a marked UIKit overlay whose bounds follow a Compose element. Each host must verify its own privacy geometry. Android attached bounded masked image replay in a local run, while both iOS hosts used native video. Physical-device privacy and production delivery still need validation before release.

`captureHandledError("catalog_load_failed")` accepts a stable lowercase code, not an exception message or user text. `captureException(caughtThrowable)` forwards the original Kotlin failure; on iOS, the Swift driver bridges its `KotlinThrowable.asError()` into the native handled-error path. Its message follows the native SDK's redaction and limits, so callers should still avoid putting secrets in exception text. `recordNetworkOperation("catalog_fetch", "GET", 503, 42)` adds a bounded network breadcrumb without a URL, headers, or body. It is not a replacement for the native SDK's OkHttp interceptor or iOS URLSession capture when full network rows are needed. These calls require a started client and still obey native capture gates.

The module is not yet published. Its Android driver needs native SDK `0.10.x`; use `-PeverframeNativeVersion=0.10.0-DEV` with local source artifacts during development. On iOS, add the bundled `ios/EverframeSwiftDriver.swift` to the host target alongside the KMP framework and the native Everframe Swift SDK. Publish the native SDK first, then publish this module and validate a clean consumer install before merging.

See [mobile dry-run evidence](../../docs/dry-runs/kmp-mobile-bridge.md) for previous emulator/simulator results and their limits.
