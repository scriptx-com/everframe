---
"@everframe/sdk-android": minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

The `dev.everframe` Gradle plugin uploads React Native Hermes source maps. In an app that applies React Native's Gradle plugin, `uploadEverframe<Variant>HermesSourceMap` runs after `createBundle<Variant>JsAndAssets` for each uploading build type. It runs `build collect`, `build verify --release` and `sourcemaps upload-hermes` through the Everframe CLI. A missing `EVERFRAME_API_TOKEN` or a failed step warns and the build continues, unless `EVERFRAME_SYMBOLS_STRICT=1`. Each step gets `EVERFRAME_UPLOAD_TIMEOUT_SECONDS`, 600 by default. Apps without React Native get no Hermes task.

The staging folder defaults to `.everframe` beside `android/`; set `everframe { hermesStagingDir }` to change it. The plugin now finds an installed `@everframe/cli` in `node_modules` of the app root or any parent folder, so hoisted monorepo installs no longer fall back to `npx`.
