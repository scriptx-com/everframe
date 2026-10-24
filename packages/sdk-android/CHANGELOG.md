<!-- SPDX-License-Identifier: MIT -->

## 1.6.0

### Minor Changes

- 47aeb5e: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Quick capture on real Android phones. Link a phone to yourself from the dashboard (**Settings → Devices → Link a device**, then shake the phone and click the number its banner shows, `Linking to Everframe · 47`); the phone shows `Linked to <name>`, and from then on a shake files a quick capture for you, in debug and release builds, with the toast `Captured · <name>` (`Captured · team device` for a team device). Debug builds on real devices also take shared captures on shake without linking. An unlinked release build behaves as before: shake opens the reporter if shake-to-report is on, and it also says hello to an open dashboard link window.
  - Shake now runs while quick capture is armed or device linking is on, whatever `shakeToReport`/`shakeToReportEnabled` say; those switches decide only whether an unlinked release build opens the reporter. A crash-only session (`reporterEnabled = false`) never listens for shake.
  - Linked devices and debug builds record replay while quick capture is armed when the capture hotkey's replay setting is on. Unlinked release builds never do.
  - A linked device can be taken over by another teammate, who opens **Link a device** while you shake.
  - An unlinked or revoked device shows `This device was unlinked` and falls back to unlinked behavior; the refused capture is not filed in the shared inbox.
  - The device token is encrypted under an AndroidKeyStore key in `noBackupFilesDir`, sent only to the ingest endpoint and SDK key that linked it, and never logged. A capture queued offline is sent later only while the same token is stored.
  - `GET /api/config` declares the `devicelinking` capability.

- 678b612: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Quick capture on Android TV. The gesture is a remote binding set per app on the dashboard, by default holding Play/Pause for 1.5 seconds. Link a TV like a phone: do the gesture while **Link a device** is open on the dashboard and click the number its banner shows. A linked TV then files a quick capture for you (`Captured · <name>`), a debug build files shared captures, and an unlinked release build shows nothing and only says hello to an open link window.
  - Bindings are a long press, a sequence (keys in order within a time window) or a chord (keys held together), over the contract key names (`DPAD_*`, `BACK`, `MENU`, `MEDIA_PLAY_PAUSE`, `MEDIA_FAST_FORWARD`, `MEDIA_REWIND`, `PROG_*`, `A`–`Z`, `0`–`9`, `SHIFT`). A binding the SDK cannot follow exactly is ignored.
  - Key handling: an unlinked device never has a key swallowed or changed. On a linked device the first press always reaches the app (so a Play/Pause long press toggles playback once at the start), then the long press's repeats are swallowed and its key-up arrives canceled; a sequence swallows only its last key and a chord only its completing key.
  - **Record on device**: a linked device asked by the dashboard records up to 32 key presses for 10 seconds (`Recording remote keys for 10 seconds`, then `Keys sent to Everframe`) while the keys still reach the app, so the dashboard can build a binding from the real remote. Linked devices now refresh their config when the app comes to the foreground, at most every 10 seconds.
  - Fire TV runs the same code; it is not verified yet.
  - `GET /api/config` declares the `capturegesture` capability.

- 9590c96: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  **Deprecated: Everframe Companion has been removed.** The documented Companion API stays as deprecated no-op stubs, so apps that follow the docs keep compiling. Pairing calls do nothing: the first `Everframe.startCompanion()` in a process logs one warning, "Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture.", and no socket, announce or timer is ever started. `Everframe.companion`'s flows hold their idle values forever (`state` is `CompanionState.Unpaired`; `pairUrl`, `code`, `attachedUserName`, `resolvedName` and `attachChallenge` are `null`), `Everframe.stopCompanion()` does nothing, and the `companionDeviceId`, `companionBadgeEnabled` and `companionBadgePosition` `EverframeConfig` parameters keep their positions and are ignored. These APIs are deleted at the next major version.

  The SDK no longer sends the `X-Everframe-Companion-Attribution` header or declares the `companionbadge` capability; a config that still carries a `companionBadge` block decodes and the block is ignored. Crash-only sessions (`reporterEnabled = false`) no longer upgrade when a phone pairs. `ReporterTrigger.Companion` stays for reports filed by older builds.

  Kept, deprecated: `Everframe.companion` (`dev.everframe.companion.Companion`), `AttachChallengeInfo`, `CompanionState`, `Everframe.startCompanion()` and `Everframe.stopCompanion()`. The quick-capture submit pipeline moved from `dev.everframe.companion.CompanionSubmissionComposer` to `dev.everframe.quickcapture.SubmissionComposer`, with the same API minus `companionAttribution`.

  Removed (undocumented plumbing):
  - `RelayWSClient` and `AttachPinUi`
  - `CompanionBadge`, `CompanionBadgeLabel`, `CompanionBadgeOptions`, `CompanionBadgePosition`, `parseCompanionBadgePosition`, `parseCompanionBadgePositionOrNull` and `CompanionBadgeServerConfigSignal`
  - `AnnounceDevice`, `CompanionDeviceId` and `CompanionDeviceFacts`
  - `PreviewCapture`, `NormalizedRect`, `PreviewStopReason`, `CompanionPreviewSession` and `CompanionPreviewSessionApi`, and `ScreenshotCapture.capturePreviewFrame(...)`
  - `CompanionCaptureBridge`
  - `dev.everframe.companion.CompanionSubmissionComposer` (now `dev.everframe.quickcapture.SubmissionComposer`)
  - `Everframe.__registerCompanionClient`, `__unregisterCompanionClient`, `__attachPinUiInstalled` and `__attachPinUiSuppressed`
  - the `companionAttribution` parameter of `MultipartUploader.upload(...)` and `ReportSubmitter.submit(...)`
  - the generated relay types in `dev.everframe.protocol.generated` (`RelayMessage`, `PairCreated`, `ReportSubmit`, `ReportAssembled` and their siblings)

### Patch Changes

- 34e8648: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Quick capture on debug Android emulators now triggers from inside the app: press ⇧B (on phone and TV emulators). The chord is skipped while a text field has focus (an `EditText`, a React Native `TextInput`, a Compose or Flutter text field), so typing a capital B stays typing; otherwise the key press is kept from the app. The dashboard's capture hotkey binding is used when it is Shift plus a letter or digit (such as `Shift+K`); any other binding (double Shift, ⌘, ⌃ or ⌥ combos, which the emulator cannot deliver) falls back to ⇧B. While a dialog or a React Native `Modal` is in front, ⇧B is not seen; the `com.everframe.CAPTURE` broadcast and `npx @everframe/cli capture` still trigger a capture there, but its screenshot shows the screen under the dialog.

  The `Captured · <device name>` toast now appears as soon as the capture is taken and handed to the upload, instead of after the upload finishes. A queued upload adds no second toast (the `Captured · uploads when online` toast is gone), and an upload that is rejected and not queued follows with `Capture didn't upload`.

## 1.5.0

### Minor Changes

- 903854c: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Debug builds on Android emulators can file a report from a broadcast trigger,
  with no reporter UI. The report carries the screenshot, replay, logs and
  metadata, is marked `quickCapture`, and is attributed to the developer when a
  capture token is available. It stays dark until the server sends `captureHotkey`
  in the project config, and can be turned off locally with
  `quickCaptureEnabled = false`. Physical devices and release builds are
  unaffected.

  When the block also sets `replay: true`, session replay records while quick
  capture is armed, even if the app's `replayEnabled` is false and regardless of
  its sampling rate. The flag never turns replay off; after a disarm, replay
  follows `replayEnabled` again. A queued report with a native video replay from the same project and session
  keeps it when a retry in that session runs while quick capture still forces
  replay. A retry at the next app launch runs before the dashboard config
  arrives, so it sends the capture without its replay. Native video replay never
  records frames that show Jetpack Compose content, so quick captures taken on
  Compose screens carry the screenshot, logs and metadata but no replay.

  `npx @everframe/cli capture` (and, on macOS, `npx @everframe/cli hotkey`) sends the `com.everframe.CAPTURE` broadcast to a running emulator. `npx @everframe/cli login` and `link` set the emulator's `everframe_token` and `everframe_token_origin` settings, and the token is only sent to the server it was issued by; the manual `adb shell settings put global everframe_token <token>` still works without the CLI.

  A session started with `capture.screenshot = false` ignores quick capture unless
  the host has installed an evidence provider with
  `Everframe.__setQuickCaptureEvidenceProvider`. That SDK seam is for host plugins,
  such as Flutter's, that mask their own pixels and supply the screenshot and
  replay themselves. Such a session never uploads an unmasked native screenshot. The `dev.everframe.quickcapture.QuickCaptureHostEvidence` class carries that evidence and is SDK-internal, for host plugins only.
  `HostImageVTreeAttachment` is now public in `dev.everframe.transport`, and
  `CompanionSubmissionComposer.Inputs` gained defaulted `hostReplayVTree` and
  `sdkName` parameters. Both are SDK-internal and not for use by host code.

  The public `ReporterTrigger` enum gained a `QuickCapture` case (raw value
  `quick_capture`). Host code that uses an exhaustive `when` over `ReporterTrigger`
  needs an `else` branch.

  The public Kotlin functions `effectiveNativeVideo` and
  `ReportAuthorizationFactory.forPending` gained a trailing defaulted parameter.
  This is source-compatible; recompile callers outside the SDK for binary
  compatibility.

  Kotlin Multiplatform apps start sessions with screenshots off, so quick capture is ignored for them (`screenshot_disabled`) for now.

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

## 1.2.1

### Minor Changes

- 50b3190: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Android: in a session that records replay, a handled error reported with `Everframe.captureException` (or the KMP equivalent) now carries the last seconds of video as a `session-replay` attachment, at most two per `start`. The snapshot leaves the recording running, so a later error or bug report still has the full history. The error is stored at once. Its replay is attached within 3 seconds; past that, or when the clip does not fit, the error ships without it and `captureControl.degradedReason` includes `replay_omitted`. No error takes a replay while a bug report is open. Crashes, recovered stalls and OS exit evidence never carry one. React Native gains internal bridge entry points for the same behaviour.

- f1cec02: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Android session replay records at 1, 2, 5 or 10 frames per second. The SDK declares `nativevideolowfps`, so the server can send 1 or 2. The encoder keeps 1.5 Mbps at 5 fps and above and scales linearly below: 300 kbps at 1 fps and 600 kbps at 2 fps. Recording now also pauses while Battery Saver is on or the thermal status is MODERATE or higher (it used to pause only at SEVERE), and it never starts on a low-RAM device (`ActivityManager.isLowRamDevice()`).

- 0eb9ff5: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Android: `EverframeConfig(reporterEnabled = false)` starts a crash-only session. Shake never installs and `Everframe.report.open()` throws `ReporterDisabledException` (`openAsync` passes it to `onError`). Network bodies stay off, and replay records at the dashboard's crash-only coverage, `crashOnlySamplingRate`, which is 0 by default and which the SDK requests with the `crashonly` feature token. A companion bond, by QR code or dashboard attach, gives the rest of that session normal replay coverage and server body rules; the on-device entry points stay off. Crash and error capture, breadcrumbs, vitals, release health and companion are unchanged. The React Native Android bridge maps `reporterDisabled` onto the switch and rejects `openReporter` with `EVERFRAME_REPORTER_DISABLED`.

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

- de4cb24: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  The `dev.everframe` Gradle plugin uploads React Native Hermes source maps. In an app that applies React Native's Gradle plugin, `uploadEverframe<Variant>HermesSourceMap` runs after `createBundle<Variant>JsAndAssets` for each uploading build type. It runs `build collect`, `build verify --release` and `sourcemaps upload-hermes` through the Everframe CLI. A missing `EVERFRAME_API_TOKEN` or a failed step warns and the build continues, unless `EVERFRAME_SYMBOLS_STRICT=1`. Each step gets `EVERFRAME_UPLOAD_TIMEOUT_SECONDS`, 600 by default. Apps without React Native get no Hermes task.

  The staging folder defaults to `.everframe` beside `android/`; set `everframe { hermesStagingDir }` to change it. The plugin now finds an installed `@everframe/cli` in `node_modules` of the app root or any parent folder, so hoisted monorepo installs no longer fall back to `npx`. The CLI runs with `NODE_BINARY` when it is set, as React Native's build scripts do, for every upload the plugin runs.

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
