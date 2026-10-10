---
"@everframe/sdk-android": patch
"@everframe/cli": patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Android symbol uploads: `bundle<Variant>` now uploads native symbols for every ABI the bundle packages (`ndk.abiFilters`), not only the APK split ABIs, and `assemble` with `bundle` in one build uploads the union. The Gradle plugin bounds npm's registry fetches for the `npx` fallback and stops the CLI process once it outlives `EVERFRAME_UPLOAD_TIMEOUT_SECONDS` plus up to a minute to fetch the CLI; a stalled registry then warns and the build continues (it fails with `EVERFRAME_SYMBOLS_STRICT=1`). Libraries the project's own CMake or ndk-build produced without debug information are no longer treated as quiet prebuilt libraries: the plugin passes its native build output folders to the CLI with the new `elf upload-build --project-native-dir`, and warns once with their names and the fix.
