---
"@everframe/cli": minor
"@everframe/expo": minor
"@everframe/sdk-android": minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Builds can upload their native symbols automatically, and a symbol problem never breaks a build by default.

- `everframe dsym upload-build` finds the binaries and dSYMs itself: `--xcode` inside a Run Script phase, `--archive` for an `.xcarchive` (fastlane, Xcode Cloud, CI) and `--app` for any other layout. App and extension executables are required. Embedded frameworks are optional and warn when they have no dSYM. dSYM folders are searched recursively. iOS, tvOS and their simulators are supported.
- `everframe setup xcode` adds an "Upload Everframe Symbols" phase to every application target, and `--print-script` prints it for XcodeGen. The phase turns off user script sandboxing on those targets and declares a dSYM input only for `dwarf-with-dsym` builds.
- The React Native and Expo build phase also uploads iOS dSYMs, skips Debug builds, reads flavored Android variants such as `tvRelease`, and turns off user script sandboxing.
- `everframe elf upload-build --binaries-dir` finds every shipped `.so`. Prebuilt libraries without debug information warn instead of failing.
- The `dev.everframe` Gradle plugin uploads R8 mappings and native libraries after `assemble<Variant>` and `bundle<Variant>` of release builds through a new `everframe {}` block. The R8 mapping ID is the SHA-256 of `mapping.txt`, packaged with the app, so `Everframe.start` reports it without `r8MappingId`. `everframeR8 {}`, `EVERFRAME_R8_BUILD_ID` and the `EVERFRAME_R8_MAPPING_ID` BuildConfig field are removed. React Native and Expo projects apply the plugin.
- Build integrations warn and exit 0 when `EVERFRAME_API_TOKEN` is missing or an upload fails. They upload every file that matches before reporting misses, and stop after `EVERFRAME_UPLOAD_TIMEOUT_SECONDS` (600 by default). `--strict` or `EVERFRAME_SYMBOLS_STRICT=1` turns these into failures.
- Every request now has a timeout, and `upload_busy` responses are retried for as long as their `Retry-After` and the time budget allow.
