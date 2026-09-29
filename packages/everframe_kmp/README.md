<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Everframe KMP bridge (unreleased dry run)

`EverframeKmp` shares start, user, screen, breadcrumb, handled-error, safe network-operation, reporter, and kill calls. The Android driver delegates to the existing Android SDK. On iOS, `EverframeSwiftDriver` implements the Objective-C protocol exported by Kotlin/Native and delegates to the existing Swift SDK. This lets a SwiftUI/UIKit host use shared Kotlin logic without importing a Swift-only SDK into Kotlin/Native.

The bridge accepts only `development` and uses local development SDK artifacts. Automatic screenshots are off, but the native reporter takes a **manual** screenshot. Native crash capture is on because the native SDK gates handled-error capture behind the same flag. Network metadata is on and network bodies are vetoed. Android Compose hosts must use `Modifier.txSensitive()` for sensitive content; the iOS Compose probe demonstrates a marked UIKit overlay whose bounds follow a Compose element. Each host must verify its own privacy geometry. All three mobile hosts submitted to a local fake ingest; Android attached bounded masked image replay, while both iOS hosts used native video. Production delivery is unproven. Do not publish or use it with customer data.

`captureHandledError("catalog_load_failed")` accepts a stable lowercase code, not an exception message or user text. `captureException(caughtThrowable)` forwards the original Kotlin failure; on iOS, the Swift driver bridges its `KotlinThrowable.asError()` into the native handled-error path. Its message follows the native SDK's redaction and limits, so callers should still avoid putting secrets in exception text. `recordNetworkOperation("catalog_fetch", "GET", 503, 42)` adds a bounded network breadcrumb without a URL, headers, or body. It is not a replacement for the native SDK's OkHttp interceptor or iOS URLSession capture when full network rows are needed. These calls require a started client and still obey native capture gates.

See [mobile dry-run evidence](../../docs/dry-runs/kmp-mobile-bridge.md) for build commands and current gates.
