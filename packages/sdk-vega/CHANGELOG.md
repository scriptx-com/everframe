<!-- SPDX-License-Identifier: MIT -->

## 1.6.1

### Patch Changes

- 64dd912: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Devices are linked from **Project settings → Devices** in the dashboard now, not the organization's Settings. The READMEs and the Companion deprecation message say so.

## 1.6.0

### Minor Changes

- 5ff600d: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Configurable capture gesture and Record on device on Vega OS. The SDK now negotiates `capturegesture` and follows the app's remote binding from the dashboard: a long press, a sequence (for example ↑↑↓↓ within a second) or a chord, over the keys a Vega remote can send (D-pad, Select, Back, Menu, Play/Pause, Fast forward, Rewind, digits). A binding that uses keys a Vega remote does not have (color keys, letters, Shift) turns the gesture off on the device, with one warning in debug builds; a missing or malformed binding keeps the default long press of Play/Pause. A linked device asked to record a gesture shows `Recording remote keys for 10 seconds`, records up to 32 key presses for 10 seconds, uploads them with its device token and shows `Keys sent to Everframe`; the capture gesture pauses meanwhile and keys still reach the app.

- dbd5299: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Quick capture on linked Vega devices: device linking, long press Play/Pause, takeover. `init()` now installs a root wrapper with `AppRegistry.setWrapperComponentProvider` that listens to remote keys (never consuming one) and draws the linking banner and toasts. A long press of Play/Pause (about 1.5 s) on a device linked from the dashboard files a quick capture attributed to that person or team (`Captured · {name}`); an unlinked debug build files a shared draft, and an unlinked release build only offers itself for linking. The link token is stored in the `storage` you pass, bound to the endpoint and SDK key. A capture holds breadcrumbs, device, app and user details; there is no screenshot or replay on Vega OS. The SDK now makes one `GET /api/config` per launch; `quickCaptureEnabled: false` turns all of this off. `react` (>=18) is now a peer dependency.

## 1.5.0

No changes in this package; released with the other Everframe packages at this version.

## 1.4.0

## 1.3.0

### Patch Changes

- 81bd274: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Add anonymous foreground release-health sessions for native Vega apps. Fatal JavaScript reports carry their frozen session identity; handled errors, non-fatal rejections and unsupported native process failures do not lower the crash-free rate. Preserve browser Vega page sessions and respect debug and collection opt-outs.

## 1.2.1

### Minor Changes

- 01c173d: <!-- SPDX-License-Identifier: MIT -->
    <!-- SPDX-FileCopyrightText: 2026 ScriptX -->
  Every Everframe package now ships on one version line. The web, React, React Native, identity, Roku and Vega SDKs, the CLI, the Metro, bundler and Expo plugins, and the Android, iOS, Flutter and KMP SDKs all release with the same version number. The CLI and the Expo plugin pin the `dev.everframe` Gradle plugin of their own version.
  The SDK key is `sdkKey` everywhere. The `apiKey` config field is gone from `@everframe/web`, `@everframe/react` and `@everframe/react-native`, along with `resolveSdkKey`. On iOS, `EverframeConfig(appId:)`, its `appId` property and the `ReplaySession` initializers that took `apiKey` are gone; use `EverframeConfig(sdkKey:)`.
  `EverframeConfig` on Android has only its primary constructor and generated `copy`. The extra constructors and `copy` overloads that kept the signatures of earlier releases are removed, so Java callers pass every constructor argument. The generated protocol models on Android and iOS likewise keep only their current constructors and initializers.
  `attachReactTree` and `detachReactTree` are removed from the Android and iOS SDKs; nothing in a report used the tree. `@everframe/web` removes `handleReportSubmit`, `bakeBlurRegions` and `REPORTER_TOKEN_STORAGE_KEY`, and its reporter token is read only from the key scoped to the SDK key.
  `everframe setup react-native` and the Expo plugin write the short native setup and rewrite their own generated lines on a re-run.
  React Native configures native only through the blocking `configureSync`; the void `configure` method is gone from the TurboModule spec and both bridges. Error capture always uses the bridge's current methods, so `getErrorCaptureStatus()` no longer has a `legacyAttempted` counter, and `getReportDeliveryStatus()` reports a missing native getter as `unavailable/native-call-failed`. The Android bridge opens the reporter only through `ReporterResolverInstaller.openForActivity`.
  Android no longer imports the plaintext outbox files that earlier builds wrote. `CrashSidecar.hydrateInto` and the `Unit`-returning `CrashSidecar.appendSync` are removed; use `appendSyncAccepted`. The report delivery status drops the queue's `migration` field on Android, iOS and React Native.
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# @everframe/vega

## 0.2.0

### Minor Changes

- b90da7c: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Envelopes carry `context.app.debug` when the SDK detects a debug build, and release-health records move to schema version 5 with a required `app.debug`. Everframe never creates a release from a debug build.

- f5e6411: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  New package (preview): JavaScript crash and error reporting for Amazon Vega OS apps (React Native for Vega 0.72, Hermes 0.12) with no native module. Reports uncaught errors, unhandled promise rejections and `captureException`, stores each report in AsyncStorage before sending it as JSON, and names the bundle so uploaded source maps symbolicate the frames. Stored reports are only ever sent to the endpoint and under the SDK key they were captured with, and credential-named `captureException` metadata keys are masked before storage.
