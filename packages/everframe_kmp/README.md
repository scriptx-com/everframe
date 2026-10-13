<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Everframe KMP bridge

`EverframeKmp` shares start, user, screen, breadcrumb, handled-error, safe network-operation, reporter, and kill calls. The Android driver delegates to the existing Android SDK. On iOS, `EverframeSwiftDriver` implements the Objective-C protocol exported by Kotlin/Native and delegates to the existing Swift SDK. This lets a SwiftUI/UIKit host use shared Kotlin logic without importing a Swift-only SDK into Kotlin/Native.

On Android, call `driver.bindActivity(activity)` when the host Activity resumes and `driver.bindActivity(null)` when it stops. A retained client can bind its replacement Activity after recreation; call `client.kill()` when the client is no longer needed. A screen known to contain no sensitive content can opt in with a route-aware `allowCaptureWithoutSensitiveMarkers` callback; otherwise an empty sensitive registry fails closed.

The bridge starts the native SDK in `production` by default and also accepts `development` and `staging`. Native release artifacts own the production ingest endpoint. Automatic screenshots are off, but the native reporter takes a **manual** screenshot. `EverframeKmpConfig(debugBuild = ...)` says whether this is a debug build (leave null to use platform detection). All three drivers forward it to their platform SDK. Left null, each platform SDK detects it. Crash capture is on: on Android it covers JVM exceptions, native crashes and ANRs, and the native SDK gates handled-error capture behind the same flag. `client.kill()` stops it. Network metadata is on and network bodies are vetoed. Android Compose hosts must use `Modifier.txSensitive()` for sensitive content; the iOS Compose probe demonstrates a marked UIKit overlay whose bounds follow a Compose element. Each host must verify its own privacy geometry. Android attached bounded masked image replay in a local run, while both iOS hosts used native video. Physical-device privacy and production delivery have not been verified.

`captureHandledError("catalog_load_failed")` accepts a stable lowercase code, not an exception message or user text. `captureException(caughtThrowable)` forwards the original Kotlin failure; on iOS, the Swift driver bridges its `KotlinThrowable.asError()` into the native handled-error path. Its message follows the native SDK's redaction and limits, so callers should still avoid putting secrets in exception text. `recordNetworkOperation("catalog_fetch", "GET", 503, 42)` adds a bounded network breadcrumb without a URL, headers, or body. It is not a replacement for the native SDK's OkHttp interceptor or iOS URLSession capture when full network rows are needed. These calls require a started client and still obey native capture gates.

## Release health

`EverframeKmpConfig(releaseHealth = true)` is the default. Android and iOS use
native foreground sessions, app version/build metadata, crash recovery, and
health delivery. Native health sessions are anonymous: `setUser` still adds
report context, but does not identify health sessions or populate affected-user
metrics. Debug builds are excluded by the platform build gates. Leave `debugBuild` null
for platform detection, or pass the host build flag explicitly; `false` overrides
a detected debug build, so it must not be hard-coded in development.

Set `releaseHealth = false` to disable only health collection while keeping
reporting, handled errors, and crash capture available. `client.kill()` stops
the platform SDK, including health collection. `captureException` and
`captureHandledError` stay handled errors and do not mark a health session as
crashed. Native fatal crashes already captured by the platform SDK count;
this bridge installs no additional Kotlin fatal-exception observer.

Custom `EverframeNativeDriver` implementations must accept the new
`releaseHealth: Boolean` argument in `start` and forward that setting.

## Browser target

The package declares a Kotlin/JS browser target and an
`EverframeBrowserDriver`. It uses the same `EverframeKmp` calls as Android and
iOS. The browser host supplies `@everframe/web`'s `init` function and a
renderer-owned visual provider; `createCanvasVisualCapture` from the Web SDK
copies a Compose canvas and blacks sensitive rectangles before PNG encoding.
Its bounded image replay uses the same VTree attachment format as Flutter.
Capture refuses empty markers unless the host explicitly opts into a known-safe
screen, and it refuses invalid or missing geometry. The JS driver reports
`everframe-kmp` and platform `web` to the dashboard.

Browser hosts must provide the Web SDK module and mark sensitive canvas pixels
in canvas coordinates. `EverframeBrowserDriver(initWeb, visualCapture,
sdkVersion, appVersion)` is constructed in `jsMain`; pass it to
`EverframeKmp(driver)` and start with the KMP integration key. `appVersion` is
required and must be the nonblank version of the host app; the driver no longer
invents `0.0.0`. The browser requires `@everframe/web` 1.2.2 or newer, uses its release-health collector, and
forwards `releaseHealth` as its independent health opt-out. Repeating `start`
with the same configuration reuses the browser collector; changed settings
destroy it and start a new one, so opting out takes effect immediately. Only one
KMP browser driver owns the page SDK at a time: starting another driver retires
the old one and applies the new driver's settings. Let the driver own initialization;
do not also initialize `@everframe/web` separately on the same page. The Web SDK
owns the reporter UI, delivery, and retry. No screen-recording permission is
needed. The browser canvas report and replay passed a Chromium loopback probe;
an installed third-party Compose browser app has not been verified.

## Install

Maven Central publishes the shared module under `dev.everframe:kmp`, alongside `dev.everframe:core`, `reporter-ui`, `protocol`, `media3`, and `gradle-plugin`. The Kotlin/JS browser artifact is `dev.everframe:kmp-js`; use the matching version for all Maven modules.

Add `implementation("dev.everframe:kmp:<version>")` to the shared Kotlin module, using the Everframe release version. Gradle selects the matching `kmp-*` platform artifact. For local source testing, publish the Android modules of the same version first and point `MAVEN_LOCAL_REPOSITORY` at that repository. On iOS, link native Everframe of the same version and add `ios/EverframeSwiftDriver.swift` from the KMP sources JAR to the host target alongside the KMP framework. The iOS host remains responsible for packaging the KMP framework and native Swift SDK. Native dependencies must be version 1.2.1 or newer, which provides the release-health and debug-build APIs used by these drivers. The default Android dependency version follows the shared native release version (currently 1.2.1).
