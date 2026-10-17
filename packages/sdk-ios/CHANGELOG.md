<!-- SPDX-License-Identifier: MIT -->

## 1.4.0

### Minor Changes

- d0ed9cb: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Describe phone and TV interactions using available native control names, roles,
  IDs, collection metadata, and screen context. Add the optional
  `useEverframeTarget` ref hook for logical app metadata, with stale-host
  invalidation and sensitive-view masking. Automatic reporting remains available
  without annotations; the web hook is a no-op.

## 1.3.0

### Patch Changes

- 792cdfb: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Enable native release-health foreground sessions on tvOS. Sessions use the installed app version, tvOS runtime identity, and immutable native fatal evidence. Debug and capture opt-outs remain enforced; inferred terminations stay outside the proven crash rate.

## 1.2.1

### Minor Changes

- 760242a: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  iOS and tvOS add crash-only sessions. `EverframeConfig(reporterEnabled: false)` turns the on-device reporter off: shake stays off, `report.open()` throws `EverframeReporterError.reporterDisabled`, network bodies are not captured, and session replay records only in the server's `crashOnlySamplingRate` share of sessions, which is 0 by default. The config request declares `crashonly`, so the server sends that rate only to SDKs that accept it. A companion bond, a phone scanning the QR code or a dashboard member attaching, upgrades the session until the next `start` or `kill`, and replay and network bodies then follow the normal server rules. Shake and `open()` stay off after an upgrade. In React Native, the iOS bridge reads `reporterDisabled` and rejects `openReporter` with `EVERFRAME_REPORTER_DISABLED` in a crash-only session.

- 56a3a9f: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Errors can carry a session replay.

  When replay is on, a handled error, and on React Native and the web an error
  the app survives, can carry the last seconds of replay from a recording
  session. There are at most 2 per session, including exports in progress. An
  open bug report that owns the buffer prevents an error replay. A replay that
  isn't ready within 3 seconds or is over 8 MB (8,000,000 bytes) is left off.
  Replay failure doesn't discard the original error: Android and iOS save it
  first with a hold of up to 5 seconds; the web queues it first and waits up to
  3 seconds before sending. Android and iOS take an independent snapshot while
  recording continues, so a later error or bug report still has the history.
  Fatal native and React Native errors and Flutter apps don't attach error
  replays. Web error replays require `CompressionStream`.

  Native video replay adds 1 and 2 frames per second, with 2 as the server
  default for SDKs that support it. The iOS fallback remains 5 fps when the
  server omits the native-video setting; Android requires that setting to record
  native video. The bitrate scales down below 5 fps. Recording now also pauses
  in iOS Low Power Mode, in Android Battery
  Saver and at Android's `MODERATE` thermal status or higher (Android 10+), and
  never starts on Android low-RAM devices. Web recording pauses while the tab
  is hidden.

  Web replay masks form input values again, leaves out elements marked
  sensitive, and removes recognized card-number, JWT, bearer-token and
  email-address patterns, while other text stays readable. Sensitive markers
  added during recording also apply.

  See [session replay](../docs/session-replay.md) for settings and privacy
  boundaries.

  Recording cost is unmeasured on physical devices: the numbers so far come from an Android emulator and the tvOS simulator, at 5 and 10 frames per second.

- 90f020f: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Handled errors captured with `captureException` on iOS and tvOS now carry a session replay of the seconds before them when the session records replay. At most 2 errors per SDK session get one, never while a bug report owns the replay buffer, and never crashes, Apple diagnostics or inferred terminations. The replay is a copy: recording continues, and a later error or bug report still has the whole window. The error is queued at once. If its replay is not ready within 3 seconds or exceeds 8,000,000 bytes, the error is sent without it and `captureControl.degradedReason` records why. `CrashReporter.captureFacts` and `CrashReporter.captureHandledFacts` gain an `attachReplay` parameter, off by default, so the React Native bridge can ask for the same replay on JavaScript errors.

- 143fb44: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  iOS and tvOS session replay can record at 1 or 2 frames per second as well as 5 and 10. The config request declares `nativevideolowfps`, so the server sends a low rate only to SDKs that accept it. Below 5 fps the encoder bitrate scales with the frame rate (1.2 Mbps × fps / 5). Recording also pauses while Low Power Mode is on, and drops its buffer as it already does for memory warnings and serious heat.

- 01c173d: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Every Everframe package now ships on one version line. The web, React, React Native, identity, Roku and Vega SDKs, the CLI, the Metro, bundler and Expo plugins, and the Android, iOS, Flutter and KMP SDKs all release with the same version number. The CLI and the Expo plugin pin the `dev.everframe` Gradle plugin of their own version.

  The SDK key is `sdkKey` everywhere. The `apiKey` config field is gone from `@everframe/web`, `@everframe/react` and `@everframe/react-native`, along with `resolveSdkKey`. On iOS, `EverframeConfig(appId:)`, its `appId` property and the `ReplaySession` initializers that took `apiKey` are gone; use `EverframeConfig(sdkKey:)`.

  `EverframeConfig` on Android has only its primary constructor and generated `copy`. The extra constructors and `copy` overloads that kept the signatures of earlier releases are removed, so Java callers pass every constructor argument. The generated protocol models on Android and iOS likewise keep only their current constructors and initializers.

  `attachReactTree` and `detachReactTree` are removed from the Android and iOS SDKs; nothing in a report used the tree. `@everframe/web` removes `handleReportSubmit`, `bakeBlurRegions` and `REPORTER_TOKEN_STORAGE_KEY`, and its reporter token is read only from the key scoped to the SDK key.

  `everframe setup react-native` and the Expo plugin write the short native setup and rewrite their own generated lines on a re-run.

  React Native configures native only through the blocking `configureSync`; the void `configure` method is gone from the TurboModule spec and both bridges. Error capture always uses the bridge's current methods, so `getErrorCaptureStatus()` no longer has a `legacyAttempted` counter, and `getReportDeliveryStatus()` reports a missing native getter as `unavailable/native-call-failed`. The Android bridge opens the reporter only through `ReporterResolverInstaller.openForActivity`.

  Android no longer imports the plaintext outbox files that earlier builds wrote. `CrashSidecar.hydrateInto` and the `Unit`-returning `CrashSidecar.appendSync` are removed; use `appendSyncAccepted`. The report delivery status drops the queue's `migration` field on Android, iOS and React Native.

## 1.2.0

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

## 1.1.0

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
