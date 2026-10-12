<!-- SPDX-License-Identifier: MIT -->

## 0.2.0

### Minor Changes

- b90da7c: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Envelopes carry `context.app.debug` when the SDK detects a debug build, and release-health records move to schema version 5 with a required `app.debug`. Everframe never creates a release from a debug build.

- e9e1b8d: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  iOS and tvOS: report a previous foreground process that the OS ended with `SIGKILL` (low memory, unresponsive or unexplained) on the next launch as one anonymous, stackless fatal labelled as inferred, with the last sampled memory footprint. It follows `capture.crash`, evaluates only the previous run, and is off in app extensions, Mac Catalyst, iOS apps on a Mac and, unless opted in for qualification, the simulator. On iOS with release health it counts as an other exit, never as a crash.

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

- 4fc7221: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Android OS exit evidence (`payload.diagnostic.android`) gains an optional `mappingId`: the R8 mapping ID of the build the exited process ran, in the same format and from the same source as a JVM crash's `payload.crash.jvm.mappingId` (the ID the Everframe Gradle plugin packages in the APK, or `EverframeConfig.r8MappingId`). The SDK freezes it when the process arms exit capture, so an ANR, a low-memory kill or a native crash reported on the next launch names its own build's mapping even after an update, and an ANR stack can be retraced without a Java crash from that build. The generated Kotlin `Android` and Swift `EverframeAndroid` evidence types gain the field.

- 0e870a2: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  iOS and tvOS: a main-thread stall of 5 seconds or more that recovered no longer turns a later force-quit, before the next 5-second sample, into an "Unresponsive termination". The stored stall is cleared as soon as the main thread answers.

- be2860f: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  The iOS and tvOS SDK frameworks now ship their dSYMs, so crashes in apps that install the `Everframe` pod (including React Native and Expo apps) symbolicate the SDK's own frames. Every xcframework slice carries its dSYM; CocoaPods copies it into the build, where the app's symbol upload phase finds it. `EverframeProtocol` moves to its own `Everframe/Protocol` subspec, which `Everframe/Core` depends on, because CocoaPods copies a subspec's xcframeworks into one folder and the second one's dSYMs replaced the first one's. The release verifier rejects a CocoaPods archive with a slice that has none, the React Native example rebuilds a local SDK that predates them, and the Expo plugin's README says the SDK's dSYMs upload with the app's.

- 7210db5: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  The built-in JWT redaction now checks structure instead of a regex. A header.payload.signature (or five-segment JWE) is redacted only when its header decodes to a JOSE header: optional JSON whitespace, `{`, and an `"alg"` member, as RFC 7515 and RFC 7516 require. Tokens with whitespace in or before the header JSON, an empty payload object (`e30`), an empty signature, or text glued before them (`x_`, `token`, `%3D`, `=`, `\n`) are redacted, and only the token is replaced. Dotted class, package and module names, bundle IDs and version strings, such as `dev.example.app.MainActivity$onCreate$2`, `kotlinx.coroutines.internal.DispatchedTask` or `1.2.3.4567890`, are no longer replaced with `[REDACTED:JWT]` in stack frames, messages, breadcrumbs and logs. The Android, iOS and JavaScript SDKs run the same linear-time scanner (`redactJwt` in `@everframe/protocol`, `JwtScan` on Android and iOS), checked against one shared corpus; the `jwt` entry in the shared redaction patterns names the scanner and keeps only a candidate regex.

- 565b4bd: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  `EFReporterPresenter.installResolver()` now exists on tvOS, where it does nothing, so the same launch code compiles in an iOS and a tvOS target. tvOS still has no on-device reporter: `report.open()` throws there and reports are filed through the companion.

## 0.1.0

### Minor Changes

- a5e45fd: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Mobile crash reports now include the error's cause chain. React Native sends `Error.cause` chains through the existing native bridge, including the stacks Hermes exposes on `Error.prototype`. Android captures `Throwable` causes next to the existing JVM metadata, and iOS follows the `NSUnderlyingErrorKey` of `NSError` and `CustomNSError` errors. Each chain keeps at most 8 causes, 32 frames per cause and 65,536 serialized UTF-8 bytes, is redacted before it is stored, and marks anything it drops as truncated. Malformed cause data never discards the outer report, and causes do not change how errors are grouped.

  Cause redaction scans a bounded prefix of each field (8,192 characters) and of each JavaScript stack (32,768 characters). When either limit cuts the text, the cut token and any digit group before it are dropped before redaction, so a JWT, bearer token, card number or SSN split at the limit does not reach a report. The same holds for an email address when the web SDK's `redaction.maskInputs` includes `'email'`. This applies to web cause chains as well. Custom `redaction.customRules` patterns are matched only against the retained text, so when the limit cuts a custom match that contains spaces or other punctuation, the start of that match can remain unredacted.

### Patch Changes

- bab392e: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Keep up to 60 seconds of session replay on iOS and tvOS, matching Android and the dashboard's replay duration setting. The recorder, session and exporter each capped the window at 30 seconds regardless of the configured duration.

  Player controls drawn over a video now stay visible in iOS and tvOS replays. The video surface is still recorded as a black box; before, its whole area was blacked out after rendering, which on a full-screen player blacked out the entire frame.

- 7e6e74e: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Fix a tvOS crash on the first remote press in apps that use scene-based focus. The press breadcrumb read `UIScreen.focusedView`, which UIKit refuses with "screen-based focus unsupported"; it now reads the focused view from the window's focus system.
