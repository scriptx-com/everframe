<!-- SPDX-License-Identifier: MIT -->

## 1.6.2

### Patch Changes

- cb15f65: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  The Android bridge compiles on React Native 0.88. The root-view check now calls `ReactRootView.getJSModuleName()` explicitly instead of using the Kotlin `jsModuleName` property, which the React Native 0.88 Kotlin toolchain no longer resolves. Apps that patched this line can drop the patch.
  - @everframe/react@1.7.0

## 1.6.1

### Patch Changes

- 64dd912: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Devices are linked from **Project settings → Devices** in the dashboard now, not the organization's Settings. The READMEs and the Companion deprecation message say so.

- 08eef46: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  A new `EverframeProvider` takes over from a still-mounted one instead of throwing "already mounted". Android recreates the activity while the JS runtime survives (for example after a system font or display size change), and the new root's provider can mount before the old root's cleanup runs; that threw from a layout effect and crashed the app. The replaced provider's late unmount is a no-op, and mounting the same provider twice still throws. This restores the 1.4.1 hotfix, which 1.5.0 and 1.6.0 did not carry.

- Updated dependencies [64dd912]
  - @everframe/react@1.6.1

## 1.6.0

### Minor Changes

- 9590c96: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  **Deprecated: Everframe Companion has been removed.** The `companion` namespace stays as deprecated no-op stubs, so apps that follow the docs keep compiling. Pairing calls do nothing: the first `companion.start()` logs one warning, "Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture.", and reaches no native code. `companion.stop()` does nothing, `onRunning`, `onState`, `onPairUrl`, `onCode`, `onAttachedUserName`, `onResolvedName` and `onAttachChallenge` return an unsubscribe and never call their handler, and `useCompanion()` returns the same idle object on every render (`state: 'unpaired'`, `running: false`, every other value `null`). The `attachPinUi`, `companionDeviceId` and `companionBadge` config options are accepted and no longer forwarded to native. These APIs are deleted at the next major version.

  The native SDKs no longer send the `X-Everframe-Companion-Attribution` header or declare the `companionbadge` capability, and crash-only sessions (`reporter: { disabled: true }`) no longer upgrade when a phone pairs. `ReporterTrigger` keeps `'companion'` for reports filed by older builds.

  Removed:
  - `companion.getEmitter` (`getEmitter` itself stays in the SDK's internals)
  - the `startCompanion`, `stopCompanion` and `signalCompanionReportRequestReady` TurboModule methods, and the `attachPinUi`, `companionDeviceId`, `companionBadgeEnabled` and `companionBadgePosition` `ConfigOpts` fields
  - the `everframe.companion.*` native events

- f62459b: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Quick capture and device linking on real phones arrive through the native iOS and Android SDKs, with no config change and no JavaScript API: link a phone from the dashboard (**Settings → Devices → Link a device**, then shake it and click the number its banner shows) and a shake files a quick capture for you in any build; a debug build (`__DEV__`, or `debugBuild`) also takes shared captures on shake without linking, alongside the React Native development menu. Release builds on end users' phones behave as before. `shakeToReport` now controls only whether shake opens the reporter on an unlinked release build; `quickCapture: { enabled: false }` turns off quick capture and linking together.

  On Android TV, a linked TV files a quick capture from the app's remote gesture, set per app on the dashboard (by default holding Play/Pause for 1.5 seconds, or recorded from the real remote with **Record on device**); an unlinked release TV shows nothing and only answers an open link window. Keys are swallowed only on linked TVs, and the first Play/Pause press still reaches the app, so playback toggles once before the capture. Apple TV is unchanged.

### Patch Changes

- 34e8648: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Quick capture on debug simulators and emulators is ⇧B inside the app on both platforms, skipped while a `TextInput` has focus (native iOS and Android SDK 1.5.1). `npx @everframe/cli capture` still works; `npx @everframe/cli hotkey` is no longer needed.

- Updated dependencies [9590c96]
- Updated dependencies [8d2b60a]
- Updated dependencies [bb52a6c]
  - @everframe/react@1.6.0

## 1.5.0

### Minor Changes

- 9691527: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Adds `quickCapture: { enabled }` to the provider config. Simulator and emulator quick capture is on by default in debug builds once the dashboard enables it; `quickCapture: { enabled: false }` opts the app out. The value reaches the native iOS and Android SDKs as `quickCaptureEnabled`, and a local `true` never overrides a dashboard disable.

## 1.4.0

### Minor Changes

- d0ed9cb: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Describe phone and TV interactions using available native control names, roles,
  IDs, collection metadata, and screen context. Add the optional
  `useEverframeTarget` ref hook for logical app metadata, with stale-host
  invalidation and sensitive-view masking. Automatic reporting remains available
  without annotations; the web hook is a no-op.

- e63aae4: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Add bounded typed state labels and automatic facts for React Native iOS/Android reports, with native snapshots, history checkpoints and persisted crash observations.

### Patch Changes

- @everframe/react@1.4.0

## 1.3.0

### Patch Changes

- 2e34dd5: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  A crash-only session (`reporter: { disabled: true }`) no longer shows the floating "Your reports" button or the inbox, even when the device has reply threads. The session has no on-device way to open the reporter, so it has no inbox either. Sessions with the reporter enabled are unchanged, including the read-only inbox after replies are switched off. On React Native this applies to React Native Web.

- Updated dependencies [2e34dd5]
- Updated dependencies [24769a6]
  - @everframe/react@1.2.2

## 1.2.1

### Minor Changes

- ceb86ab: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  New `reporter: { disabled: true }` config option for crash-only sessions. Such a session reports crashes and errors but has no on-device way to file a report: no hotkey, no "New report" button in the inbox, and `open()` rejects with the new `EverframeReporterDisabledError`. Session replay samples against the app's crash-only rate, which is 0 unless the dashboard raises it, and network bodies are not captured. A companion bond upgrades the session to the normal replay and network-body settings for the rest of the session, and recording starts at the bond. Errors carry a replay only while the session records. On React Native, the option is passed to the native SDKs, and `open()` maps their refusal to `EverframeReporterDisabledError`.

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

- 01c173d: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Every Everframe package now ships on one version line. The web, React, React Native, identity, Roku and Vega SDKs, the CLI, the Metro, bundler and Expo plugins, and the Android, iOS, Flutter and KMP SDKs all release with the same version number. The CLI and the Expo plugin pin the `dev.everframe` Gradle plugin of their own version.

  The SDK key is `sdkKey` everywhere. The `apiKey` config field is gone from `@everframe/web`, `@everframe/react` and `@everframe/react-native`, along with `resolveSdkKey`. On iOS, `EverframeConfig(appId:)`, its `appId` property and the `ReplaySession` initializers that took `apiKey` are gone; use `EverframeConfig(sdkKey:)`.

  `EverframeConfig` on Android has only its primary constructor and generated `copy`. The extra constructors and `copy` overloads that kept the signatures of earlier releases are removed, so Java callers pass every constructor argument. The generated protocol models on Android and iOS likewise keep only their current constructors and initializers.

  `attachReactTree` and `detachReactTree` are removed from the Android and iOS SDKs; nothing in a report used the tree. `@everframe/web` removes `handleReportSubmit`, `bakeBlurRegions` and `REPORTER_TOKEN_STORAGE_KEY`, and its reporter token is read only from the key scoped to the SDK key.

  `everframe setup react-native` and the Expo plugin write the short native setup and rewrite their own generated lines on a re-run.

  React Native configures native only through the blocking `configureSync`; the void `configure` method is gone from the TurboModule spec and both bridges. Error capture always uses the bridge's current methods, so `getErrorCaptureStatus()` no longer has a `legacyAttempted` counter, and `getReportDeliveryStatus()` reports a missing native getter as `unavailable/native-call-failed`. The Android bridge opens the reporter only through `ReporterResolverInstaller.openForActivity`.

  Android no longer imports the plaintext outbox files that earlier builds wrote. `CrashSidecar.hydrateInto` and the `Unit`-returning `CrashSidecar.appendSync` are removed; use `appendSyncAccepted`. The report delivery status drops the queue's `migration` field on Android, iOS and React Native.

### Patch Changes

- Updated dependencies [ceb86ab]
- Updated dependencies [01c173d]
  - @everframe/react@1.3.0

## 1.2.0

### Minor Changes

- e0c884b: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Android crash capture is now on by default with `capture.crash`. `Everframe.start` captures JVM exceptions, native crashes (OS exit records on API 30+, with tombstone frames on API 31+) and ANRs on API 30+, without any other call. From OS exit records it reports native crashes, ANRs, and low-memory kills while the user could see or hear the app (foreground, foreground service or visible), the last as one fatal "Low memory kill" crash per app with importance, PSS/RSS and the exit description, and not when the JVM handler already reported that process's crash; background reclaims, user stops, JVM crash exits and other reasons are not sent. The protocol lets a crash envelope carry low-memory exit evidence. The optional `dev.everframe:native-crash` module (not yet on Maven Central) adds a fault frame for native faults on API 26–30. Native and OS exit capture run in the default app process. `setProcessExitDiagnosticsEnabled`, `setNativeCrashRecoveryEnabled`, `setNativeSignalCaptureEnabled` and their three readiness getters are removed; `Everframe.isNativeCrashCaptureReady()` replaces the getters. Start with `CaptureConfig(crash = false)` to turn capture off, or call `kill()`. The SDK now owns `ActivityManager.setProcessStateSummary` while capture is on and logs `process-state-summary-conflict` when another writer replaced it; a writer that runs before the SDK is overwritten. Flutter gains `start(crash:)` (default on), which reaches the native `capture.crash` on Android and iOS. In React Native, `crashReporting: { disabled: true }` now also turns off native crash and ANR capture on Android and iOS. A full OS exit journal no longer stops capture: arming frees only the slots it needs, records that can no longer be reported first, oldest first by arming order, never the newest, and logs a warning. Crash matching and expiry no longer depend on the wall clock: a matched crash is reported however far the clock jumped (and is never collected before its own exit time), and an unmatched record expires once the clock is more than 14 days from its creation in either direction.

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

- 1ea29ae: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Android: JVM crashes, handled exceptions and React Native JavaScript crashes now report the device's `sdk.formFactor` (`tv` on Android TV and Fire TV, from the television UI mode or the leanback feature) instead of always `phone`. OS exit, ANR and reporter envelopes already did. `EnvelopeBuilder.buildEncoded` now requires `formFactor`, so no envelope path can fall back to a default.

- c6ecb05: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  React Native: an error that no error boundary catches (thrown while rendering, in an effect or in a lifecycle method) is now reported as a fatal JavaScript crash with its Hermes stack, and React's component stack follows the message after `This error is located at:`. Since React Native 0.78, React reports these through the root's `onUncaughtError` and React Native's `ExceptionsManager`, never the `ErrorUtils` handler, so they arrived only as React Native's native fatal (`RCTFatalException` on iOS and tvOS, `JavascriptException` on Android) with no JavaScript frames. Crash reporting now also hooks `ExceptionsManager.handleException`, and keeps the hook until the end of the task in which React unmounted `EverframeProvider`, because React reports the error after that unmount. The native fatal that follows is not reported again; on Android that match now also recognises React Native's wrapper when the title carries a component stack, when the message was cut at 4,096 characters, when the JavaScript stack contains native or internal frames, and when the message already starts with the error name. Errors a boundary catches are unchanged: report them with `captureReactError`.

- Updated dependencies [3cfc899]
- Updated dependencies [5ec828c]
- Updated dependencies [a6880a2]
  - @everframe/react@1.2.0

## 1.1.0

### Minor Changes

- a5e45fd: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Mobile crash reports now include the error's cause chain. React Native sends `Error.cause` chains through the existing native bridge, including the stacks Hermes exposes on `Error.prototype`. Android captures `Throwable` causes next to the existing JVM metadata, and iOS follows the `NSUnderlyingErrorKey` of `NSError` and `CustomNSError` errors. Each chain keeps at most 8 causes, 32 frames per cause and 65,536 serialized UTF-8 bytes, is redacted before it is stored, and marks anything it drops as truncated. Malformed cause data never discards the outer report, and causes do not change how errors are grouped.

  Cause redaction scans a bounded prefix of each field (8,192 characters) and of each JavaScript stack (32,768 characters). When either limit cuts the text, the cut token and any digit group before it are dropped before redaction, so a JWT, bearer token, card number or SSN split at the limit does not reach a report. The same holds for an email address when the web SDK's `redaction.maskInputs` includes `'email'`. This applies to web cause chains as well. Custom `redaction.customRules` patterns are matched only against the retained text, so when the limit cuts a custom match that contains spaces or other punctuation, the start of that match can remain unredacted.

- 18bcef7: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Add report delivery diagnostics. `getReportDeliveryStatus()` in `@everframe/react-native`, `Everframe.getReportDeliveryStatus()` on Android and `Everframe.shared.getReportDeliveryStatus()` on iOS return a detached snapshot of cached observations: native capture outcomes per entry path, report outbox operations with the last observed queue count, and settled upload outcomes for live submissions and outbox drains. Snapshots contain only fixed codes and counters, perform no storage or network work, and reset when the SDK starts or is killed. With an older native SDK the React Native getter returns `unsupported/native-method-missing`, and the browser export returns `unsupported/platform`.

- 7d000f6: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Add `captureReactError` at `@everframe/react-native/integrations/react` for an existing React error boundary's `componentDidCatch`. It reports the caught error as a handled exception with bounded, redacted component-stack metadata and shares accepted error identity with `captureException` and automatic capture. Render the boundary inside `EverframeProvider`. A boundary that wraps the provider reports only if its fallback mounts its own provider, and errors that a boundary inside the provider catches during the provider's first commit are not captured. The subpath is native-only; browser-conditioned resolution rejects it.

  Add `getErrorCaptureStatus()`, a detached, content-free snapshot of local JavaScript capture admission for the `handled`, `errorUtils` and `rejection` paths: attempts and their outcomes. `accepted` means the native SDK accepted the capture, not that the report was delivered. The browser entry returns `unsupported`.

- 551e3f7: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Add opt-in reporting of unhandled promise rejections on Hermes. With `crashReporting.promiseRejections.enabled: true`, a rejection still unhandled after 2 seconds is reported through the existing nonfatal error path; a handler attached within that interval cancels the report. Observation installs only on the verified runtime, `react-native-tvos@0.85.3-0` with Hermes `250829098.0.10` on Android and iOS, and reports `unsupported` elsewhere, including browser execution. At most 16 pending snapshots of up to 64 KiB each are kept, and work older than 30 seconds expires instead of being reported. Rejection reasons that are not `Error` objects are reported as a bounded primitive value or a type label such as `[object]`, never as serialized object contents, and their `cause` is not reported. Automatic reports keep their limit of 10 distinct errors per mount; non-Error reasons are deduplicated by value with digit runs ignored and use at most 5 of those 10.

  `getPromiseRejectionStatus()` reports whether the observer is active, with counters for pending, accepted, cancelled, dropped, expired, suppressed, refused, failed and discarded rejections.

### Patch Changes

- 93308e3: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Publish the build-artifact tooling. `@everframe/metro` stamps a build identity into Hermes bundles at bundle time, `@everframe/expo` adds the native build steps that collect the bundle, source map and native identifiers, and `@everframe/cli` verifies and uploads them so release crashes symbolicate. `@everframe/react-native` now reads the identity injected by `@everframe/metro`, so no build ID needs to be passed at runtime.

  `@everframe/bundler-plugin` adds Vite, Rollup, webpack, esbuild and Next.js plugins that stamp a build ID into web bundles and upload their source maps at the end of a production build. `everframe upload-expo-export` uploads the bundles and source maps from an `expo export` directory. `everframe setup react-native` patches the Gradle and Xcode build steps so native release builds collect and upload their artifacts.
  - @everframe/react@1.1.0

## 1.0.0

### Minor Changes

- ccc4581: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Add a React Native browser entry that re-exports the React SDK through the same package import. Align sensitive wrapper and ref names across native and web, and include the React SDK as a dependency so web hosts install one Everframe package.

### Patch Changes

- afb0687: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Fix regressions from the Everframe rename. The Android SDK (and React Native on Android) now sends the `X-Everframe-*` header names the API reads, so native video session replay, verified identity and companion report attribution work again. In development under React StrictMode, `EverframeProvider` no longer keeps running with a killed client after the double mount, so two-way replies reach the reporter again.

- Updated dependencies [e16f94b]
- Updated dependencies [afb0687]
- Updated dependencies [ccc4581]
- Updated dependencies [9a40051]
- Updated dependencies [9332f80]
  - @everframe/react@1.0.0

## 0.9.0

### Minor Changes

- b375364: <!-- SPDX-License-Identifier: MIT -->
    <!-- SPDX-FileCopyrightText: 2026 ScriptX -->
  Rename the public SDKs, native bridges, package coordinates, and documentation to Everframe.
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# @scriptx-com/traceitx-react-native

## 0.8.2

### Minor Changes

- d0b05a4: Add dashboard-controlled shake-to-report on Android and iOS phones and tablets.

  The trigger lives in the native SDKs, so bare native and React Native/Expo apps
  share the same implementation. It is enabled locally by default, requires no
  new permission, treats Android's accelerometer as optional, and excludes TV
  targets. The dashboard remains authoritative; local configuration can only opt
  out. React Native and Expo development builds should use
  `shakeToReport: { enabled: !__DEV__ }` to avoid overlapping with the development
  menu's shake gesture.

- 061f83a: Give `@traceitx/react` the host-facing API `@traceitx/react-native` already had, and fix `setExtra` corruption.
  - `recordScreen`, `useTXScreen` and `<TXScreen>` are now available on web, deriving the same `from → to` breadcrumb the native SDKs emit. Hosts previously hand-rolled this from a recipe in our own docstring, and different hosts got different subsets of the five rules right.
  - Top-level `setUser` on web; calling it with no argument clears, matching React Native.
  - `companion.start()` no longer requires `sdkKey` / `deviceLabel` when a `<TraceItXProvider>` is mounted — it defaults them from the provider config. Explicit arguments still win, and standalone `@traceitx/web` is unchanged.
  - `useCompanion()` now reports `running`, the session intent hosts previously had to track in a module-scoped flag.

  **`setExtra`, all four SDKs (web, React, React Native, and the protocol/native ceiling underneath them):** the `extra` cap is raised from 2000 characters to 16384 (16 KiB). The 2000-char figure had no storage or ingest justification — it only existed because the native SDKs happened to truncate there — and it was the tightest budget of anything in the report payload (a single breadcrumb message alone gets 2048). If you were ever hand-trimming your own `extra` object to survive the old limit, you almost certainly don't need to anymore.

  `setExtra` accepts an object as well as a string — `@traceitx/sdk-core`, `@traceitx/web` and `@traceitx/react` already had this, and `@traceitx/react-native` now does too — so hosts stop hand-serializing JSON themselves.

  **`setExtra` also accepts a resolver — `setExtra(() => buildExtra())` — and this is now the form to prefer.** It is invoked once per report, at assembly time, never at registration time, so what it returns reflects the host's state when the bug happened rather than whenever `setExtra` last ran. The string and object forms freeze a snapshot at call time, which goes stale the moment anything changes; a host that was re-calling `setExtra` on every state change to keep it fresh can replace all of those calls with one resolver registered at startup. React Native reaches the resolver through a native ask-and-wait seam, so it behaves the same there as on the web. An over-budget payload is never sliced (slicing serialized JSON produces a fragment nothing can parse); it is OMITTED from the report instead, with a warning logged at the `setExtra` call site naming the actual size and the limit. On React Native, an over-budget **string** still crosses the bridge as-is and is truncated by the native side's own raw character cut — that native behavior is unchanged; prefer the object form there.

  `EXTRA_MAX_CHARS` is now exported from `@traceitx/react` and `@traceitx/react-native` (it was already available from `@traceitx/sdk-core` and `@traceitx/web`), so a host that wants to trim its own `extra` object can check the real limit and decide for itself what to drop — that decision needs knowledge of what the host's own fields mean, which only the host has. The SDK does not attempt this on your behalf.

- 80ac7d9: **Session Vitals no longer ships CPU/memory samples.**

  Resource consumption is covered by the Report Resource Window: CPU and memory
  sampled every 2 seconds over the window before a report or crash. That is both
  finer than the vitals sample stream (which sampled every 30 seconds) and
  actually aligned to the failure it explains.

  The vitals stream cost nearly everything and explained little. Measured against
  real stored data: 79% of stored chunks came from sessions where no video ever
  played, and a single 10-hour session produced 1,154 stored objects containing
  nothing but samples and not one playback event.

  `recordSample` still exists and still runs the full entry path — session
  rotation, activity tracking and the summary accumulator — so session lifetimes
  are unchanged and `memPeak` / `memAvg` still land on the session summary. What
  stops is transport: samples no longer enter the chunk upload queue, and no
  longer enter the recent ring that gets stamped into a bug or crash report.

  Session Vitals is now playback-only: startup, buffering, bitrate and quality
  switches, errors and seeks. A session with no playback activity uploads nothing.

## 0.8.1

### Minor Changes

- bdd8ea3: **Session Vitals: React Native player tracking.**

  `@traceitx/react-native` inherits the native Session Vitals half
  automatically (background CPU/memory sampling, a session id on reports and
  crashes) with no code change, and gains a library-agnostic JS-to-native
  player bridge on top of it: `trackPlayer`/`PlayerHandle`/`useTrackPlayer`,
  `trackVitals`, and a `vitals` config passthrough (`enabled`, `sampleRate`,
  `captureSourceQuery`). Two adapters ship on top of that bridge —
  `@traceitx/react-native/integrations/react-native-video` (v7 headless
  `VideoPlayer`, `useVideoPlayerVitals`) and
  `@traceitx/react-native/integrations/theoplayer`
  (`attachTheoPlayerVitals`/`useTheoPlayerVitals`) — both pure translators;
  neither player library is imported at runtime or added as a dependency.

  Every JS event forwards through one small `RemotePlayerIntegration` +
  `RemotePlayerRegistry` pair, added to **both** native core SDKs
  (`com.traceitx.vitals` in `traceitx-core`, `TraceItXKit/Vitals` on iOS) —
  not the RN modules, which stay pure glue. This is a native SDK change, not
  only a JS one:
  - **Android (`@traceitx/sdk-android`) and iOS (`@traceitx/sdk-ios`) each
    gain two new public classes.** On Android specifically, `traceitx-core`'s
    R8 rules now keep `RemotePlayerRegistry`/`RemotePlayerIntegration`
    (`proguard-rules.pro` + `consumer-rules.pro`) — without them the published
    AAR renames these classes under minification, which is a shipped-AAR bug
    for any consumer, RN or not, that reflects on or subclasses them.
    Neither package is in this repo's changesets scope (native SDK versions
    are synced manually in lockstep with the JS release, not via changesets),
    so there is no separate changeset entry for them — this note is the
    release record.
  - **Both RN native modules now detach every live player on JS instance
    teardown.** A prior design gap left a full JS reload (Fast Refresh
    notwithstanding — this is a full instance reload) with stale player
    registrations attached and their spans still open in the native
    registry. `detachAll()` on each core registry now closes every handle
    (emitting `player_detach`) and clears the map, called from the RN
    module's own instance-teardown hook (`RCTInvalidating`/`invalidate()` on
    iOS, `NativeModule.invalidate()` on Android) — never from `configure()`,
    since child effects that register players run before the Provider's
    configure-on-mount and clearing there would drop legitimate
    registrations made during that same mount.
  - **`configure()` is idempotent.** A repeat `configure()` with the same
    config, against an already-started SDK, no longer calls
    `TraceItX.start(...)` — a start supersedes the running SDK and detaches
    every player integration it announced, which is a wildly expensive answer
    to a Provider that merely remounted with an unchanged config. Both native
    sides decide this against the _installed_ config, not against a cache of
    the options they were last handed. Known limitation: when the config DID
    change the SDK does restart, and players tracked before that restart stay
    untracked until their screens remount. Two React instances in one process
    are likewise uncoordinated — if a second one restarts the SDK, the first's
    players stay untracked until its own screens remount.

  Known gaps, not fixed here: `rate_change` was not observed from
  react-native-video v7 on Android in our Android emulator smoke — the library
  does forward ExoPlayer's `onPlaybackParametersChanged`, so this is a
  "not seen in our smoke run" result rather than a proven library gap;
  react-native-video v7 has no tvOS support at all (no podspec/target) — use
  THEOplayer or a custom adapter on Apple TV; a native react-native-video
  plugin attaching the real ExoPlayer/AVPlayer instance is a follow-up.

  **react-native-video adapter defaults.** `useVideoPlayerVitals` does NOT
  subscribe to `onError` unless you pass `captureErrors: true` — registering
  any `onError` listener makes react-native-video stop throwing synchronously
  from `play()`/`seek*()` for the whole app, so the adapter stays observationally
  neutral by default and reports fatal errors from `onStatusChange('error')`
  (no error code). `onBandwidthUpdate` is mapped per platform: rendition
  bitrate on iOS, bandwidth estimate on Android. An out-of-range
  `vitals.sampleRate` is ignored (server rate applies) instead of failing the
  SDK start.

## 0.7.0

### Minor Changes

- b3f851e: **Android: UI-tree capture is now opt-in, and tap targets resolve on device.**

  `CaptureConfig.uiTree` defaults to `false`. Until now the flag existed but
  nothing in the SDK read it — every reporter open walked the host activity's
  whole view hierarchy (including the Compose semantics tree) and shipped the
  result in the envelope, where it routinely dominated payload size to back a
  single admin view.

  Tap-to-identify does not need the tree on the wire any more.
  `payload.reportTarget[]` now carries the tapped node inline — `node`
  (children-stripped), `ancestors` (`{name, type}` from the root down to but not
  including the match) and `rootRect` — resolved on device by
  `FindPathAt.resolveEntry(tree, path, treeKind)`, which mirrors
  `resolveReportTargetEntry` in `@traceitx/protocol` and the iOS
  `FindPathAt.resolveEntry`, and is held to the same shared parity fixture. The
  walk itself is deferred to the first Select-tool tap and memoised for the
  reporter's lifetime, so a report with no tap never walks at all.

  **Host action 1 — the envelope no longer carries the tree by default.** If you
  rely on `payload.uiTree` reaching the envelope, pass
  `CaptureConfig(uiTree = true)` explicitly. Otherwise nothing changes: the
  resolved node ships either way.

  **Host action 2 — none. There is no source-breaking change.** The reporter
  composables that changed shape to take a tree _provider_ instead of a tree
  (`ReporterRoot`, `FocusedAnnotation`, `AnnotationCanvas`) are all `internal`,
  so no host can call them.

  The only public-surface change is additive: `UITreeCapture.captureForActivity`
  gains an optional `exclude: View?`, defaulting to `null`, which existing calls
  never have to pass. It exists because the lazy walk now runs while the reporter
  is on screen, and the reporter's own `ComposeView` is attached to
  `android.R.id.content` — the very view the walk roots at. Excluding it (rather
  than rooting the walk elsewhere) keeps the root node and every child index
  identical to a pre-reporter walk, so the lazy and eager paths produce the same
  paths.

  A failed walk now clears the tap highlight instead of leaving the previous
  tap's selection on screen, so a capture failure can no longer be mistaken for
  having picked the wrong element. The same fix landed on iOS and web.

- 4f4e48d: **iOS: UI-tree capture is now opt-in, and tap targets resolve on device.**

  `CaptureConfig.uiTree` defaults to `false`. Until now the flag existed but
  nothing in the SDK read it — every reporter open walked the host's entire view
  hierarchy and shipped the whole tree in the envelope, where it routinely
  dominated payload size to back a single admin view.

  Tap-to-identify does not need the tree on the wire any more. `payload.reportTarget[]`
  now carries the tapped node inline — `node` (children-stripped), `ancestors`
  (`{name, type}` from the root down to but not including the match) and
  `rootRect` — resolved on device by `FindPathAt.resolveEntry(tree:path:treeKind:)`,
  which mirrors `resolveReportTargetEntry` in `@traceitx/protocol` and is held to
  the same shared parity fixture. The walk itself is deferred to the first
  Select-tool tap and memoised for the presentation, so a report with no tap never
  walks at all.

  **Host action 1 — the envelope no longer carries the tree by default.** If you
  rely on `payload.uiTree` reaching the envelope, pass `CaptureConfig(uiTree: true)`
  explicitly. Otherwise nothing changes: the resolved node ships either way, and a
  missing tree is no longer reported as
  `captureControl.degradedReason = "ui_tree_unavailable"` unless capture was
  actually requested and failed.

  **Host action 2 — `FocusedAnnotationViewController.init` is source-breaking.**
  Deferring the walk means the editor can no longer be handed an
  already-captured tree, so its `uiTree:` parameter is replaced by
  `uiTreeProvider:`, which takes a closure that produces the tree on demand:

  ```swift
  // before
  FocusedAnnotationViewController(sourceImage: image, uiTree: tree, …)

  // after — pass a closure returning the tree instead of the tree itself
  FocusedAnnotationViewController(sourceImage: image, uiTreeProvider: { tree }, …)
  ```

  The closure is `(@MainActor () -> UITree?)?`. It is called at most once per
  presentation, on the first Select-tool tap; returning `nil` means the walk
  failed and the tap is a no-op, and passing `nil` for the whole parameter hides
  the Select tool. Wrapping an existing tree in `{ tree }` reproduces the old
  behaviour exactly. This affects only hosts that construct the fullscreen
  annotation editor directly — hosts going through
  `TraceItX.shared.report.open()` need no change.

## 0.6.6

### Minor Changes

- 8159f83: Companion attach now requires device consent: attaching from the dashboard
  shows a 4-digit code on the device (rendered by the SDK by default;
  `attachPinUi: 'custom' | 'off'` to override) that the dashboard member must
  type. Devices on older SDK versions keep one-click attach.

### Patch Changes

- 19d6d10: Replay image capture: the asset byte budget is now scoped to the replay
  window rather than the whole session.

  `spentBytes` only ever grew and was reset only at a report boundary, while
  the buffer it feeds keeps a rolling last-N-seconds window. On an image-dense
  app the budget was exhausted by images belonging to frames long since pruned;
  capture then stopped entirely and every on-screen image degraded to a
  placeholder within about half a second, for the rest of the session.

  Assets now carry a last-seen timestamp keyed on their content hash, are swept
  at the start of each walk against a horizon of twice the replay window, and
  are evicted oldest-first under pressure. Defaults are unchanged.

## 0.6.4

## 0.6.3

### Patch Changes

- 16e10a6: Fixed: upgrading `@traceitx/react-native` did not upgrade the native SDK underneath it.

  The bridge derived its native dependency ranges from its own version as `~> X.Y.0` (CocoaPods) and `X.Y.+` (Gradle) — a ceiling with no floor. Both are satisfied by `X.Y.0` forever, so a project that had already resolved the native SDK once kept it:
  - **iOS.** CocoaPods only re-resolves a pod whose `Podfile.lock` entry no longer fits its constraint. `pod install` therefore kept returning the previously locked `TraceItX`, however far ahead the npm package moved. Nothing in the project surfaced the mismatch — every manifest read the new version and only the lockfile disagreed — so an app could sit on an older native SDK indefinitely, missing native fixes it appeared to have. Recovering needed an explicit `pod update TraceItX` (or deleting a generated `ios/` directory), which is not something a correctness property should depend on anyone remembering.
  - **Android.** Gradle resolves `X.Y.+` to the highest version it can currently see, so a stale dynamic-version cache — or a `mavenLocal` holding an older patch — could hand the bridge an AAR older than the JS half it shipped with. Gradle re-resolves upward once the cache expires, which narrowed the window rather than closing it.

  Both ranges now floor at the package's exact version: `~> X.Y.Z` and `[X.Y.Z, X.(Y+1).0)`. They still exclude every other minor, and a stale entry is now unsatisfiable, so an ordinary `pod install` or Gradle build picks up the matching native version with no second command and no cache expiry to wait on.

  **If you are upgrading from an affected version**, your existing lockfile may still pin the old native SDK until this release lands. On iOS, run `pod update TraceItX` once (or regenerate `ios/`); from this release onward `pod install` is enough.

  Every release publishes the native SDKs before the npm packages and verifies the exact version is fetchable from Maven Central and CocoaPods trunk first, so the tighter range always has something to resolve against. The `TRACEITX_NATIVE_POD_VERSION` and `traceitxNativeVersion` overrides are unchanged.

## 0.6.1

## 0.6.0

### Minor Changes

- d08a35f: Companion native device legs (tvOS/iOS, Android TV, and the React Native facade over both). A TV can now announce itself to the dashboard, render the short display code beside its QR, surface the name of the team member who attached, and carry that member's attribution through to ingest so the report is credited to them. Nothing here changes the QR/report path: a device that cannot announce — offline, revoked key, older server, timeout — falls through to the plain relay socket and behaves exactly as it did before, simply absent from the dashboard list.

  **This release is binary-breaking for prebuilt native consumers and versions all four SDKs to 0.5.0 in lockstep.** On iOS, `MultipartUploader.upload` and `ReportSubmitter.submit` gained a `companionAttribution:` parameter and `ReporterSubmission.Inputs` gained a public stored property; the XCFramework is built with `-enable-library-evolution`, so the old mangled symbols are gone and source compatibility does not imply binary compatibility — precompiled consumers must recompile, and the SDK and XCFramework must version together. On Android, `RelayWSClient.CLOSE_SERVER_SHUTDOWN` kept its name but changed value from `4006` to `4005` as part of realigning the close-code table to the relay's catalog; because it is a public `const val` it is inlined into consumer bytecode, so a consumer compiled against an earlier AAR still tests for `4006`. See CHANGELOG.md for the full close-code table and the recompile guidance.

  The JS SDK's only change is a defensive one: `companion.announce()` now treats a present-but-blank `ticket` or `code` as a failed announce and falls back to the ticketless path, matching the native ports.

- 4058cf9: Renamed to the `@traceitx` scope and published to npmjs.org.

  `@scriptx-com/traceitx-react` is now `@traceitx/react`, and
  `@scriptx-com/traceitx-react-native` is now `@traceitx/react-native`. Both now
  publish publicly to npmjs.org instead of to GitHub Packages under a restricted
  grant, so `npm install` works with no `.npmrc` entry, no personal access token,
  and no access grant — matching the Android (Maven Central) and iOS (CocoaPods)
  SDKs. Update your import paths and remove any `@scriptx-com` registry mapping
  from your `.npmrc`.

  The scope now matches the product rather than the publishing entity, and the
  native coordinates it already used (`com.traceitx:core`, `pod TraceItX`). No
  API changed, and the report envelope is unaffected — `sdk.name` remains
  `traceitx-react`, so servers and dashboards keyed on it need no change.

- 7cb6d68: Automatic crash/error reporting, on by default. Uncaught errors now become unattended reports without any user interaction: on web, `window.onerror` and `unhandledrejection` are captured (exception type, message, redacted stack frames, breadcrumb trail snapshot), enqueued to the outbox, and drained immediately; on React Native, a default-on global ErrorUtils handler forwards the same facts synchronously to the native SDK (Android/iOS), which persists them crash-safely and delivers on next launch (fatal) or immediately (non-fatal). Fatal vs. non-fatal is expressed by the envelope's new `source` field (`"crash"` / `"error"`); error storms are throttled per fingerprint and per session (on React Native, fatal errors always report — only non-fatal ones count against the throttle).

  Everything in the report is data the SDK already captures, fully redacted — no screenshots, UI trees, logs, or network entries are attached to unattended reports. To opt out entirely, set `crashReporting: { disabled: true }` in the provider config (client veto only — it can turn capture off, never force anything on; the SDK-wide `disabled` flag also suppresses it).

## 0.4.2

### Patch Changes

- Lower the iOS/tvOS deployment target in `TraceItXRN.podspec` from 16.0 to 15.0 to match the native TraceItX iOS SDK (`TraceItX.podspec` / `Package.swift`, both iOS 15 / tvOS 15). The RN bridge wraps the native SDK, so its minimum must not exceed what it wraps — 16.0 needlessly excluded iOS/tvOS 15 host apps the native code already supports.

## 0.4.0

### Minor Changes

- 4299929: Remove the host-settable `sdkVersion` from the `TraceItXProvider` config. The SDK version is owned by the SDK and stamped per release on the native side (`TraceItX.SDK_VERSION`), never by the host. The field was already non-functional (the host-passed value landed in `TraceItXConfig.release` and never reached the report envelope), so dropping it is behavior-neutral — reports continue to carry the native SDK's own version.

## 0.3.1

### Patch Changes

- 68807ba: BREAKING: `apiKey` is now required on the host-facing `RuntimeConfig` (the `TraceItXProvider config` prop), matching the React SDK. A missing key is now a compile-time error instead of a runtime `Bearer undefined` / 401. The native bridge `ConfigOpts.apiKey` stays optional, so the generated TurboModule spec is unchanged.
