<!-- SPDX-License-Identifier: MIT -->

## 1.2.0

### Minor Changes

- e0c884b: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Android crash capture is now on by default with `capture.crash`. `Everframe.start` captures JVM exceptions, native crashes (OS exit records on API 30+, with tombstone frames on API 31+) and ANRs on API 30+, without any other call. From OS exit records it reports native crashes, ANRs, and low-memory kills while the user could see or hear the app (foreground, foreground service or visible), the last as one fatal "Low memory kill" crash per app with importance, PSS/RSS and the exit description, and not when the JVM handler already reported that process's crash; background reclaims, user stops, JVM crash exits and other reasons are not sent. The protocol lets a crash envelope carry low-memory exit evidence. The optional `dev.everframe:native-crash` module (not yet on Maven Central) adds a fault frame for native faults on API 26–30. Native and OS exit capture run in the default app process. `setProcessExitDiagnosticsEnabled`, `setNativeCrashRecoveryEnabled`, `setNativeSignalCaptureEnabled` and their three readiness getters are removed; `Everframe.isNativeCrashCaptureReady()` replaces the getters. Start with `CaptureConfig(crash = false)` to turn capture off, or call `kill()`. The SDK now owns `ActivityManager.setProcessStateSummary` while capture is on and logs `process-state-summary-conflict` when another writer replaced it; a writer that runs before the SDK is overwritten. Flutter gains `start(crash:)` (default on), which reaches the native `capture.crash` on Android and iOS. In React Native, `crashReporting: { disabled: true }` now also turns off native crash and ANR capture on Android and iOS. A full OS exit journal no longer stops capture: arming frees only the slots it needs, records that can no longer be reported first, oldest first by arming order, never the newest, and logs a warning. Crash matching and expiry no longer depend on the wall clock: a matched crash is reported however far the clock jumped (and is never collected before its own exit time), and an unmatched record expires once the clock is more than 14 days from its creation in either direction.

- b90da7c: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Envelopes carry `context.app.debug` when the SDK detects a debug build, and release-health records move to schema version 5 with a required `app.debug`. Everframe never creates a release from a debug build.

- 423e77c: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Builds can upload their native symbols automatically, and a symbol problem never breaks a build by default.

  - `everframe dsym upload-build` finds the binaries and dSYMs itself: `--xcode` inside a Run Script phase, `--archive` for an `.xcarchive` (fastlane, Xcode Cloud, CI) and `--app` for any other layout. App and extension executables are required. Embedded frameworks are optional and warn when they have no dSYM. dSYM folders are searched recursively. iOS, tvOS and their simulators are supported.
  - `everframe setup xcode` adds an "Upload Everframe Symbols" phase to every application target, and `--print-script` prints it for XcodeGen. The phase turns off user script sandboxing on those targets and declares a dSYM input only for `dwarf-with-dsym` builds.
  - The React Native and Expo build phase also uploads iOS dSYMs, skips Debug builds, reads flavored Android variants such as `tvRelease`, and turns off user script sandboxing.
  - `everframe elf upload-build --binaries-dir` finds every shipped `.so`, limited to `--abi` when given. Prebuilt libraries without debug information are listed, not warned about; `--summary` prints one `detail:` line per library for build integrations.
  - In `--xcode` mode, `everframe dsym upload-build` also follows the app's run-path links to frameworks that are built but not embedded yet, such as CocoaPods frameworks under `use_frameworks!`, and uploads their dSYMs from the build products.
  - R8 mappings may be up to 512 MiB (from 32 MiB). The CLI streams them and sends them gzip-compressed when the server lists `gzip` in `uploadEncodings`. A mapping over the limit fails with `r8_mapping_too_large`, naming the file, its size and the limit.
  - The `dev.everframe` Gradle plugin uploads R8 mappings and native libraries after `assemble<Variant>` and `bundle<Variant>` of release builds through a new `everframe {}` block. The R8 mapping ID is the SHA-256 of `mapping.txt`, packaged with the app, so `Everframe.start` reports it without `r8MappingId`. `everframeR8 {}`, `EVERFRAME_R8_BUILD_ID` and the `EVERFRAME_R8_MAPPING_ID` BuildConfig field are removed. React Native and Expo projects apply the plugin. Native uploads consider only the ABIs the variant packages, and libraries without symbols produce one warning with a count; `--info` lists them.
  - Build integrations warn and exit 0 when `EVERFRAME_API_TOKEN` is missing or an upload fails. They upload every file that matches before reporting misses, and stop after `EVERFRAME_UPLOAD_TIMEOUT_SECONDS` (600 by default). `--strict` or `EVERFRAME_SYMBOLS_STRICT=1` turns these into failures.
  - Every request now has a timeout, and `upload_busy` responses are retried for as long as their `Retry-After` and the time budget allow.

- 0fd1ce9: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Release health is keyed by app version. It is on by default; see the release health on-by-default changeset for how to configure or turn it off.

  Release-health records are schema version 4 only, for Android and iOS foreground sessions. Each record carries `app: { version, build }`, which the SDK reads itself: Android's `versionName` (or `versionCode` as text when there is no usable `versionName`) and `versionCode`, and iOS's `CFBundleShortVersionString` (or `CFBundleVersion`) and `CFBundleVersion`. `nativeRelease`, the version 1–3 records and the web records are removed, so a receiver accepts version 4 only. Crash and error reports' `context.app.version` follows the same rule: an Android app without a usable `versionName` now reports its `versionCode` there, and an iOS app without `CFBundleShortVersionString` its `CFBundleVersion`, instead of `0.0.0`.

  The crash pointer, `NativeExposurePointerSchema`, carries the same `app` in place of `nativeBuildId`. `build` is always present and is `null` when there is none. The generated Kotlin `NativeExposureApp` and Swift `EverframeNativeExposureApp` write that null explicitly, and the generated `App` and `EverframeApp` keep their names.

  The `release_health.threshold_reached` webhook moves to event schema 2.0. One project rule sends one event per app version that drops below its crash-free target, with the version's platforms, the target, the last 7 days' session counts and `crashFreeSessions`. `RELEASE_HEALTH_ALERT_SCHEMA_VERSION` and `ReleaseHealthAlertTargetSchema` are new. The cohort schema and the `release_health.rate_threshold_reached` event are removed, and every other webhook event stays at 1.2.

  `nativeBuildId` is removed from every SDK. In React Native, the unused `appVersion` and `appBuild` options are removed too.

- afb5433: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Release health is on by default on Android, iOS and React Native, and debug builds aren't counted.

  Android's `EverframeConfig.releaseHealth` defaults to `ReleaseHealthConfig()`, including through the 15-argument constructor; `releaseHealth = null` turns it off. iOS's `EverframeConfig` gains `releaseHealth: ReleaseHealthConfiguration? = ReleaseHealthConfiguration()`, which `Everframe.shared.start` applies, so the separate `setReleaseHealth` call after every `start` is no longer needed; `setReleaseHealth(_:)` still changes it until the next `start`, and `releaseHealth: nil` turns it off. In React Native a configuration without `releaseHealth` is on, and `releaseHealth: { enabled: false }` turns it off.

  The SDK records nothing from a debug build (Android: a debuggable app; iOS: the simulator, or a `get-task-allow` development profile) and logs `[everframe] Release health is off in debug builds.` once per start. `includeDebugBuilds` on `ReleaseHealthConfig`, `ReleaseHealthConfiguration` or the React Native option counts them. Turning release health off, or skipping a debug build, erases undelivered local records.

- 5ec828c: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  The SDK key is renamed to `sdkKey` in every SDK; `apiKey` and `appId` are still accepted but deprecated. `appId` now means only the App ID, the UUID that symbol and source-map uploads take.

  - Web, React and React Native: the config field is `sdkKey`, for example `init({ sdkKey: 'evf_live_…' })` and `<EverframeProvider config={{ sdkKey: 'evf_live_…' }}>`. A config that still passes `apiKey` keeps working: the SDK reads it as `sdkKey` and logs one deprecation warning. When both are set, `sdkKey` wins.
  - iOS and tvOS: `EverframeConfig(sdkKey:)` and `.sdkKey` replace `EverframeConfig(appId:)` and `.appId`, which still compile with a deprecation warning. `EverframeConfigError.missingAppId` is now `EverframeConfigError.missingSdkKey`. `ReplaySession(baseURL:sdkKey:locallyDisabled:)` replaces the deprecated `apiKey:` spelling.
  - Android: `EverframeConfig(appId, sdkKey)` already used these names and is unchanged. Internal `ReplaySession`, `ReplayConfigProvider` and `VitalsTransport` parameters named `apiKey` are now `sdkKey`.
  - React Native requires native Everframe 1.2 on iOS and Android, the release that adds `EverframeConfig(sdkKey:)`. The Flutter iOS plugin requires native 1.2 through CocoaPods and SwiftPM, and the KMP Swift driver needs it too. These bridges, and their web counterparts, pass the key under the new name.

  Nothing on the wire changed. Requests still carry the key as `Authorization: Bearer <key>`, and the web vitals beacon still sends it in the `apiKey` body field, so clients on 1.1.0 and earlier keep working against the same server.

### Patch Changes

- 4d93285: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Android: `reporter-ui` now builds with Compose BOM 2025.07.00 (Compose 1.8.3, Material3 1.3.2), which needs androidx.lifecycle 2.8.7 instead of 2.9.4. With 2.9.4, an app on AGP 8.7 failed `assembleRelease` in `lintVitalAnalyzeRelease` (`IncompatibleClassChangeError` in `NonNullableMutableLiveDataDetector`): the lint checks shipped with lifecycle 2.9 and Compose runtime 1.9 need a newer AGP. Apps that use newer Compose or lifecycle versions themselves still resolve those. The reporter uses no Compose 1.9 or Material3 1.4 API.

- d72f2b7: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Android crash capture: a replacement `start()` that is delayed past a newer start no longer clears the newer start's OS exit token while `Everframe.isNativeCrashCaptureReady()` still reports true. The token clear now checks, under the lock every token write takes, that its start is still the newest, and fences only owners of older starts. On API 30 with the optional native-crash module, an exception while setting up the signal collector no longer skips OS exit capture, so native crash and ANR capture stay on. A signal-collector delivery receipt now lasts as long as the OS exit record it settles instead of 14 days, so a launch reported by the signal collector is not reported a second time from its OS exit after a long gap or a clock change.

- 4fc7221: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Android OS exit evidence (`payload.diagnostic.android`) gains an optional `mappingId`: the R8 mapping ID of the build the exited process ran, in the same format and from the same source as a JVM crash's `payload.crash.jvm.mappingId` (the ID the Everframe Gradle plugin packages in the APK, or `EverframeConfig.r8MappingId`). The SDK freezes it when the process arms exit capture, so an ANR, a low-memory kill or a native crash reported on the next launch names its own build's mapping even after an update, and an ANR stack can be retraced without a Java crash from that build. The generated Kotlin `Android` and Swift `EverframeAndroid` evidence types gain the field.

- 565b4bd: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  `dev.everframe:core` now declares `android.permission.INTERNET`, and Gradle's manifest merger adds it to the app. A new Android Studio project declares no permissions, so an app that followed the install steps sent nothing until the developer added it by hand. The SDK declares no other permission.

- c7d8662: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Android symbol uploads: `bundle<Variant>` now uploads native symbols for every ABI the bundle packages (`ndk.abiFilters`), not only the APK split ABIs, and `assemble` with `bundle` in one build uploads the union. The Gradle plugin bounds npm's registry fetches for the `npx` fallback and stops the CLI process once it outlives `EVERFRAME_UPLOAD_TIMEOUT_SECONDS` plus up to a minute to fetch the CLI; a stalled registry then warns and the build continues (it fails with `EVERFRAME_SYMBOLS_STRICT=1`). Libraries the project's own CMake or ndk-build produced without debug information are no longer treated as quiet prebuilt libraries: the plugin passes its native build output folders to the CLI with the new `elf upload-build --project-native-dir`, and warns once with their names and the fix.

- 1ea29ae: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Android: JVM crashes, handled exceptions and React Native JavaScript crashes now report the device's `sdk.formFactor` (`tv` on Android TV and Fire TV, from the television UI mode or the leanback feature) instead of always `phone`. OS exit, ANR and reporter envelopes already did. `EnvelopeBuilder.buildEncoded` now requires `formFactor`, so no envelope path can fall back to a default.

- 7210db5: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  The built-in JWT redaction now checks structure instead of a regex. A header.payload.signature (or five-segment JWE) is redacted only when its header decodes to a JOSE header: optional JSON whitespace, `{`, and an `"alg"` member, as RFC 7515 and RFC 7516 require. Tokens with whitespace in or before the header JSON, an empty payload object (`e30`), an empty signature, or text glued before them (`x_`, `token`, `%3D`, `=`, `\n`) are redacted, and only the token is replaced. Dotted class, package and module names, bundle IDs and version strings, such as `dev.example.app.MainActivity$onCreate$2`, `kotlinx.coroutines.internal.DispatchedTask` or `1.2.3.4567890`, are no longer replaced with `[REDACTED:JWT]` in stack frames, messages, breadcrumbs and logs. The Android, iOS and JavaScript SDKs run the same linear-time scanner (`redactJwt` in `@everframe/protocol`, `JwtScan` on Android and iOS), checked against one shared corpus; the `jwt` entry in the shared redaction patterns names the scanner and keeps only a candidate regex.

- c6ecb05: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  React Native: an error that no error boundary catches (thrown while rendering, in an effect or in a lifecycle method) is now reported as a fatal JavaScript crash with its Hermes stack, and React's component stack follows the message after `This error is located at:`. Since React Native 0.78, React reports these through the root's `onUncaughtError` and React Native's `ExceptionsManager`, never the `ErrorUtils` handler, so they arrived only as React Native's native fatal (`RCTFatalException` on iOS and tvOS, `JavascriptException` on Android) with no JavaScript frames. Crash reporting now also hooks `ExceptionsManager.handleException`, and keeps the hook until the end of the task in which React unmounted `EverframeProvider`, because React reports the error after that unmount. The native fatal that follows is not reported again; on Android that match now also recognises React Native's wrapper when the title carries a component stack, when the message was cut at 4,096 characters, when the JavaScript stack contains native or internal frames, and when the message already starts with the error name. Errors a boundary catches are unchanged: report them with `captureReactError`.

## 1.1.0

### Minor Changes

- a5e45fd: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Mobile crash reports now include the error's cause chain. React Native sends `Error.cause` chains through the existing native bridge, including the stacks Hermes exposes on `Error.prototype`. Android captures `Throwable` causes next to the existing JVM metadata, and iOS follows the `NSUnderlyingErrorKey` of `NSError` and `CustomNSError` errors. Each chain keeps at most 8 causes, 32 frames per cause and 65,536 serialized UTF-8 bytes, is redacted before it is stored, and marks anything it drops as truncated. Malformed cause data never discards the outer report, and causes do not change how errors are grouped.

  Cause redaction scans a bounded prefix of each field (8,192 characters) and of each JavaScript stack (32,768 characters). When either limit cuts the text, the cut token and any digit group before it are dropped before redaction, so a JWT, bearer token, card number or SSN split at the limit does not reach a report. The same holds for an email address when the web SDK's `redaction.maskInputs` includes `'email'`. This applies to web cause chains as well. Custom `redaction.customRules` patterns are matched only against the retained text, so when the limit cuts a custom match that contains spaces or other punctuation, the start of that match can remain unredacted.

- 18bcef7: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Add report delivery diagnostics. `getReportDeliveryStatus()` in `@everframe/react-native`, `Everframe.getReportDeliveryStatus()` on Android and `Everframe.shared.getReportDeliveryStatus()` on iOS return a detached snapshot of cached observations: native capture outcomes per entry path, report outbox operations with the last observed queue count, and settled upload outcomes for live submissions and outbox drains. Snapshots contain only fixed codes and counters, perform no storage or network work, and reset when the SDK starts or is killed. With an older native SDK the React Native getter returns `unsupported/native-method-missing`, and the browser export returns `unsupported/platform`.

### Patch Changes

- 66ba27b: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Android session replays now keep recording on screens with text fields, video players and sensitive views. Those areas are painted black in the replay instead of the whole frame being dropped, so a replay no longer freezes on the last safe screen. Because such screens are now recorded apart from the masked areas, mark any secret that is also shown outside an input, such as one-time-code digit cells or a card preview. A frame is still skipped when the SDK cannot prove where a sensitive view is drawn: during legacy view animations, layout transitions, shared-element transitions and container transforms (unless the app removed the container holding the sensitive view instead of hiding it); while a sensitive view or one of its containers is `INVISIBLE`, or fully transparent even when also `GONE` (as one-time-code inputs styled with `opacity: 0` are, and as a container faded to alpha 0 and then set `GONE` stays until its alpha is restored); while React Native content inside `<EverframeSensitive>` is hidden with `display: 'none'`; while the keyboard pans the window; and while a masked area moves on screen. A view inside another sensitive view is checked only as part of that view unless the SDK tracks it, as it does every view marked with `Everframe.markSensitive`. Its own transparency then skips no frames, and while a transition (a shared-element ghost, for example) or a container transform draws it elsewhere, `GONE` or not, frames can be recorded with only the outer mask, so mark such a container itself with `Everframe.markSensitive` (as `TXSensitiveView` and `<EverframeSensitive>` do); a bare `R.id.tx_sensitive` tag on a view inside another sensitive view is ignored. Compose and Flutter windows remain excluded, also in minified release builds, including ones that take Everframe's keep rules from its Gradle plugin. Frames are also no longer dropped just because the app redraws while a frame is being copied (focus moves, spinners), which left Android TV replays almost static.

- 847221a: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Destroying the activity that shows the reporter on Android now closes the reporter and resolves the pending open as cancelled with reason `activity_destroyed`. The report's frozen replay capture is released and the reporter can open again. Previously the open could stay pending, the reporter stayed marked as presenting, and shake-to-report could stay disabled until the app restarted. Backgrounding the app does not close the reporter, and a report that was already sent is not affected. Cancelling the coroutine that opened the reporter after Send no longer strips the session replay, breadcrumbs and network bodies from the report being submitted. The reporter also stays marked as presenting until that report finishes submitting, as it already did for a caller that keeps waiting, so shake-to-report stays disabled during that upload.

- 180b31d: <!-- SPDX-License-Identifier: MIT -->
    <!-- SPDX-FileCopyrightText: 2026 ScriptX -->
  Opening the reporter while one is already open no longer presents a second reporter on Android. A caller that opens it while the reporter is on screen now waits for that report and receives its result. After Send, while the report is still uploading, a new open resolves at once as cancelled with reason `already_presenting`. Either way, that caller's own pending `setExtra` value is discarded instead of shipping with a later, unrelated report. If the activity showing the reporter finishes or is destroyed before Send, the next open presents a new reporter instead of waiting, and callers already waiting resolve as cancelled with reason `activity_destroyed`. Previously a host shake listener firing together with the SDK's own shake trigger opened two reporters: the one on top had an empty capture, so the submitted report lost its session replay, and the hidden one kept replay recording paused until it was closed.
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# @everframe/sdk-android

## 1.0.0

### Patch Changes

- afb0687: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Fix regressions from the Everframe rename. The Android SDK (and React Native on Android) now sends the `X-Everframe-*` header names the API reads, so native video session replay, verified identity and companion report attribution work again. In development under React StrictMode, `EverframeProvider` no longer keeps running with a killed client after the double mount, so two-way replies reach the reporter again.
