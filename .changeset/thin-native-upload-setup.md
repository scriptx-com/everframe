---
"@everframe/cli": minor
"@everframe/expo": minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Native setup is short, and the upload logic ships in the packages. `@everframe/expo` and `everframe setup react-native` now write `apply plugin: "dev.everframe"` and `everframe { appId = "…" }` to `android/app/build.gradle`, and the `dev.everframe` Gradle plugin of the same version uploads the Hermes map. The root `build.gradle` keeps its one classpath line. The Xcode "Upload Everframe Build Artifacts" phase is a few lines: Debug and `SKIP_BUNDLING` builds skip before Node starts, and other builds find `@everframe/cli` with Node and run the new `everframe xcode build-phase --app-id <uuid>`. That command skips Debug builds, then uploads the Hermes bundle with its `SOURCEMAP_FILE` map and the dSYMs. A missing token, a missing Node or CLI, a CLI that fails to start, or a failed upload still warns and the build continues, unless `EVERFRAME_SYMBOLS_STRICT=1`.

Running `expo prebuild` or `everframe setup react-native` again rewrites the generated lines in place. Build settings, including a `SOURCEMAP_FILE` the app set, stay as they are. Fixes to the upload arrive with package updates, without another setup run.

`buildPhaseScript` is removed from `@everframe/cli/native-setup` and `@everframe/expo`; `xcodePhaseScript` returns the new Xcode script.
