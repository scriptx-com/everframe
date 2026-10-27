<!-- SPDX-License-Identifier: MIT -->

## 1.6.4

### Patch Changes

- c9a61e9: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  The build tooling now supports Node 20: `@everframe/cli`, `@everframe/bundler-plugin`, `@everframe/metro` and `@everframe/expo` declare `node >=20` instead of `>=22`. Nothing in them needed Node 22, but the stricter range made `yarn install` fail outright on Node 20 projects that added one of them, as Yarn 1 enforces `engines` by default.

## 1.6.2

No changes in this package; released with the other Everframe packages at this version.

## 1.6.1

No changes in this package; released with the other Everframe packages at this version.

## 1.6.0

### Patch Changes

- 34e8648: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  `hotkey` is retired: quick capture now takes ⇧B inside the app on both the iOS simulator and the Android emulator. The command prints `The hotkey command is no longer needed: press Shift+B in the emulator (outside a text field) to capture. npx @everframe/cli capture still works.` and exits 0, still accepting its old `--key` flag. The macOS Swift helper is no longer built or shipped. `capture`, `login`, `link` and `logout` are unchanged.

## 1.5.0

### Minor Changes

- dc725fc: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  JavaScript source maps (web, Hermes and Vega) may be up to 256 MiB each (from 32 MiB), and a web build's maps up to 1 GiB together (from 256 MiB). Release React Native maps had grown past 32 MiB, so `build collect` and `sourcemaps upload-hermes` failed with `source_map_too_large`. The CLI now streams every source map from a private snapshot and sends it gzip-compressed when the server lists `gzip` in `uploadEncodings`. Upload these maps only to an Everframe API that accepts the larger limit.

- 9691527: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Adds simulator and emulator quick capture commands:
  - `login [--url <api-url>] [--no-browser]` signs in through your browser and saves a capture token in `~/.everframe/credentials` (directory `0700`, file `0600`). It also links running Android emulators, and still succeeds when `adb` is missing or no emulator is running.
  - `logout` revokes the token, removes the credentials file and clears running emulators.
  - `link` copies the saved token to running Android emulators only, never to physical devices. It also records the server that issued the token in `everframe_token_origin`: the token is only sent to the server it was issued by.
  - `capture [--device <udid|name|serial>]` triggers one capture on a booted iOS simulator (iOS only, not tvOS or watchOS; Darwin notification `com.everframe.capture`) or running Android emulator (broadcast `com.everframe.CAPTURE`). With several booted it lists them and exits 2.
  - `hotkey [--key <combo>]` (macOS) registers a global shortcut, default Cmd+Shift+B, while a standalone Android emulator window is in front, and sends the capture to that emulator. The combo needs Cmd or Ctrl. It compiles a small Swift helper into `~/.everframe/bin` on first run and needs the Xcode Command Line Tools. Emulators embedded in Android Studio need "Launch in the Running Devices tool window" turned off.

  The package now ships a `helpers` directory.

## 1.4.1

### Minor Changes

- 1418067: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Add `everframe device-builds upload` and `everframe device-builds status` for uploading runnable builds from CI and waiting for them to be ready for Try on device. Expo and React Native setup now writes the Gradle plugin version of the current Android release, so the CLI can release on its own.

## 1.4.0

## 1.3.0

### Patch Changes

- 8644592: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  The Xcode phase for React Native and Expo apps is now one line. `everframe setup react-native` and the Expo config plugin add an "Upload Everframe Build Artifacts" phase that runs `scripts/xcode-upload.sh` from the installed `@everframe/cli` with `/bin/bash` and the App ID. The script skips Debug builds, reads `NODE_BINARY` and `EVERFRAME_SYMBOLS_STRICT` from `.xcode.env`, and runs `everframe xcode build-phase`. A missing Node or a failed upload still warns and the build continues, unless `EVERFRAME_SYMBOLS_STRICT=1`. `@everframe/cli` must be installed in the app: without it the script does not exist and the iOS build fails.

  The setup finds `@everframe/cli` from the app root the way Node does, so a package hoisted to a monorepo root works. Without an installed package it writes the standard `node_modules` path, and `setup react-native` warns that builds fail until the package is installed.

  The Everframe phases, including the one from `everframe setup xcode`, declare the app's dSYM as their only input, so they run after Xcode writes it. The `EVERFRAME_DSYM_INPUT` build settings are no longer written. The targets keep `ENABLE_USER_SCRIPT_SANDBOXING = NO`, and React Native and Expo targets keep `SOURCEMAP_FILE` when they do not set it. Running the setup again replaces the phase in place.

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

- de4cb24: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  `everframe setup react-native` lists every file it patched, as `Updated <path>` or `No changes: <path>`. It used to list only changed files, so an app module that was already current did not appear.

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

- 14609d8: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  `everframe sourcemaps upload-vega` uploads the source maps of an Amazon Vega OS release build (`build/lib/rn-bundles/Release` by default), each under the bundle id its crash frames carry. `upload-hermes` accepts `--platform vega` for custom pipelines.

### Patch Changes

- c7d8662: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Android symbol uploads: `bundle<Variant>` now uploads native symbols for every ABI the bundle packages (`ndk.abiFilters`), not only the APK split ABIs, and `assemble` with `bundle` in one build uploads the union. The Gradle plugin bounds npm's registry fetches for the `npx` fallback and stops the CLI process once it outlives `EVERFRAME_UPLOAD_TIMEOUT_SECONDS` plus up to a minute to fetch the CLI; a stalled registry then warns and the build continues (it fails with `EVERFRAME_SYMBOLS_STRICT=1`). Libraries the project's own CMake or ndk-build produced without debug information are no longer treated as quiet prebuilt libraries: the plugin passes its native build output folders to the CLI with the new `elf upload-build --project-native-dir`, and warns once with their names and the fix.

- bf2c753: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Build integrations keep uploading past a single symbol problem instead of stopping at it.
  - `everframe elf upload-build --binaries-dir` uploads every library even when the service rejects one, then prints `warning: everframe: upload failed for <path>: …` for each rejection, also with `--summary`. `--strict`, `EVERFRAME_SYMBOLS_STRICT=1` and `--binary` still fail at the first rejection.
  - `everframe dsym upload-build` searches each `--dsym-dir` folder on its own in lenient mode: a missing or unreadable folder prints `warning: everframe: skipped <folder>: <code>` and the others are still searched. Strict mode still fails.
  - `everframe dsym upload-build --xcode` no longer gives up on the whole upload, including the app's own dSYM, when a symlink loop or a folder it may not read sits in the build products. It skips that entry with a warning and keeps the frameworks it did find. It also warns when the build products search stops at its 16384-entry limit. Strict mode still fails on an unreadable folder.

## 0.1.0

### Minor Changes

- 93308e3: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Publish the build-artifact tooling. `@everframe/metro` stamps a build identity into Hermes bundles at bundle time, `@everframe/expo` adds the native build steps that collect the bundle, source map and native identifiers, and `@everframe/cli` verifies and uploads them so release crashes symbolicate. `@everframe/react-native` now reads the identity injected by `@everframe/metro`, so no build ID needs to be passed at runtime.

  `@everframe/bundler-plugin` adds Vite, Rollup, webpack, esbuild and Next.js plugins that stamp a build ID into web bundles and upload their source maps at the end of a production build. `everframe upload-expo-export` uploads the bundles and source maps from an `expo export` directory. `everframe setup react-native` patches the Gradle and Xcode build steps so native release builds collect and upload their artifacts.

# @everframe/cli

## 0.0.2

### Patch Changes

- Updated internal dependencies.
