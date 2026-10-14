<!-- SPDX-License-Identifier: MIT -->

## 1.3.0

### Patch Changes

- 8644592: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  The Xcode phase for React Native and Expo apps is now one line. `everframe setup react-native` and the Expo config plugin add an "Upload Everframe Build Artifacts" phase that runs `scripts/xcode-upload.sh` from the installed `@everframe/cli` with `/bin/bash` and the App ID. The script skips Debug builds, reads `NODE_BINARY` and `EVERFRAME_SYMBOLS_STRICT` from `.xcode.env`, and runs `everframe xcode build-phase`. A missing Node or a failed upload still warns and the build continues, unless `EVERFRAME_SYMBOLS_STRICT=1`. `@everframe/cli` must be installed in the app: without it the script does not exist and the iOS build fails.

  The setup finds `@everframe/cli` from the app root the way Node does, so a package hoisted to a monorepo root works. Without an installed package it writes the standard `node_modules` path, and `setup react-native` warns that builds fail until the package is installed.

  The Everframe phases, including the one from `everframe setup xcode`, declare the app's dSYM as their only input, so they run after Xcode writes it. The `EVERFRAME_DSYM_INPUT` build settings are no longer written. The targets keep `ENABLE_USER_SCRIPT_SANDBOXING = NO`, and React Native and Expo targets keep `SOURCEMAP_FILE` when they do not set it. Running the setup again replaces the phase in place.

- Updated dependencies [8644592]
  - @everframe/cli@1.2.2

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

- de4cb24: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Native setup is short, and the upload logic ships in the packages. `@everframe/expo` and `everframe setup react-native` now write `apply plugin: "dev.everframe"` and `everframe { appId = "…" }` to `android/app/build.gradle`, and the `dev.everframe` Gradle plugin of the same version uploads the Hermes map. The root `build.gradle` keeps its one classpath line. The Xcode "Upload Everframe Build Artifacts" phase is a few lines: Debug and `SKIP_BUNDLING` builds skip before Node starts, and other builds find `@everframe/cli` with Node and run the new `everframe xcode build-phase --app-id <uuid>`. That command skips Debug builds, then uploads the Hermes bundle with its `SOURCEMAP_FILE` map and the dSYMs. A missing token, a missing Node or CLI, a CLI that fails to start, or a failed upload still warns and the build continues, unless `EVERFRAME_SYMBOLS_STRICT=1`.

  Running `expo prebuild` or `everframe setup react-native` again rewrites the generated lines in place. Build settings, including a `SOURCEMAP_FILE` the app set, stay as they are. Fixes to the upload arrive with package updates, without another setup run.

  `buildPhaseScript` is removed from `@everframe/cli/native-setup` and `@everframe/expo`; `xcodePhaseScript` returns the new Xcode script.

### Patch Changes

- Updated dependencies [01c173d]
- Updated dependencies [de4cb24]
- Updated dependencies [de4cb24]
  - @everframe/cli@1.3.0

## 0.2.0

### Minor Changes

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

### Patch Changes

- be2860f: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  The iOS and tvOS SDK frameworks now ship their dSYMs, so crashes in apps that install the `Everframe` pod (including React Native and Expo apps) symbolicate the SDK's own frames. Every xcframework slice carries its dSYM; CocoaPods copies it into the build, where the app's symbol upload phase finds it. `EverframeProtocol` moves to its own `Everframe/Protocol` subspec, which `Everframe/Core` depends on, because CocoaPods copies a subspec's xcframeworks into one folder and the second one's dSYMs replaced the first one's. The release verifier rejects a CocoaPods archive with a slice that has none, the React Native example rebuilds a local SDK that predates them, and the Expo plugin's README says the SDK's dSYMs upload with the app's.

- Updated dependencies [c7d8662]
- Updated dependencies [423e77c]
- Updated dependencies [bf2c753]
- Updated dependencies [14609d8]
  - @everframe/cli@0.2.0

## 0.1.0

### Minor Changes

- 93308e3: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Publish the build-artifact tooling. `@everframe/metro` stamps a build identity into Hermes bundles at bundle time, `@everframe/expo` adds the native build steps that collect the bundle, source map and native identifiers, and `@everframe/cli` verifies and uploads them so release crashes symbolicate. `@everframe/react-native` now reads the identity injected by `@everframe/metro`, so no build ID needs to be passed at runtime.

  `@everframe/bundler-plugin` adds Vite, Rollup, webpack, esbuild and Next.js plugins that stamp a build ID into web bundles and upload their source maps at the end of a production build. `everframe upload-expo-export` uploads the bundles and source maps from an `expo export` directory. `everframe setup react-native` patches the Gradle and Xcode build steps so native release builds collect and upload their artifacts.

### Patch Changes

- Updated dependencies [93308e3]
  - @everframe/cli@0.1.0
