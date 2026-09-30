<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Everframe KMP bridge

`EverframeKmp` shares start, user, screen, breadcrumb, handled-error, safe network-operation, reporter, and kill calls. The Android driver delegates to the existing Android SDK. On iOS, `EverframeSwiftDriver` implements the Objective-C protocol exported by Kotlin/Native and delegates to the existing Swift SDK. This lets a SwiftUI/UIKit host use shared Kotlin logic without importing a Swift-only SDK into Kotlin/Native.

On Android, call `driver.bindActivity(activity)` when the host Activity resumes and `driver.bindActivity(null)` when it stops. A retained client can bind its replacement Activity after recreation; call `client.kill()` when the client is no longer needed. A screen known to contain no sensitive content can opt in with a route-aware `allowCaptureWithoutSensitiveMarkers` callback; otherwise an empty sensitive registry fails closed.

The bridge starts the native SDK in `production` by default and also accepts `development` and `staging`. Native release artifacts own the production ingest endpoint. Automatic screenshots are off, but the native reporter takes a **manual** screenshot. Native crash capture is on because the native SDK gates handled-error capture behind the same flag. Network metadata is on and network bodies are vetoed. Android Compose hosts must use `Modifier.txSensitive()` for sensitive content; the iOS Compose probe demonstrates a marked UIKit overlay whose bounds follow a Compose element. Each host must verify its own privacy geometry. Android attached bounded masked image replay in a local run, while both iOS hosts used native video. Physical-device privacy and production delivery have not been verified.

`captureHandledError("catalog_load_failed")` accepts a stable lowercase code, not an exception message or user text. `captureException(caughtThrowable)` forwards the original Kotlin failure; on iOS, the Swift driver bridges its `KotlinThrowable.asError()` into the native handled-error path. Its message follows the native SDK's redaction and limits, so callers should still avoid putting secrets in exception text. `recordNetworkOperation("catalog_fetch", "GET", 503, 42)` adds a bounded network breadcrumb without a URL, headers, or body. It is not a replacement for the native SDK's OkHttp interceptor or iOS URLSession capture when full network rows are needed. These calls require a started client and still obey native capture gates.

## Release status

The 0.1.1 source includes Activity rebinding and a fail-closed guard when Android sensitive markers are missing. Its Maven Central publication is pending. Maven Central currently offers 0.1.0, which lacks those guards; do not use that version for production capture. To test 0.1.1 now, build this source and its native dependencies into a local Maven repository.

Once 0.1.1 is available on Maven Central, add `implementation("dev.everframe:everframe-kmp:0.1.1")` to the shared Kotlin module with native Everframe `0.10.x`. Its Android driver needs native SDK `0.10.x`; use `-PeverframeNativeVersion=0.10.0-DEV` with local source artifacts during development. On iOS, use native Everframe `0.10.1` or newer and add `ios/EverframeSwiftDriver.swift` from the sources JAR to the host target alongside the KMP framework. The iOS host remains responsible for packaging the KMP framework and native Swift SDK.
