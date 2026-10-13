---
"@everframe/cli": patch
"@everframe/expo": patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

The Xcode phase for React Native and Expo apps is now one line. `everframe setup react-native` and the Expo config plugin add an "Upload Everframe Build Artifacts" phase that runs `scripts/xcode-upload.sh` from the installed `@everframe/cli` with the App ID. The script skips Debug builds, reads `NODE_BINARY` from `.xcode.env`, and runs `everframe xcode build-phase`. A missing `@everframe/cli`, a missing Node or a failed upload still warns and the build continues, unless `EVERFRAME_SYMBOLS_STRICT=1`.

The setup finds `@everframe/cli` from the app root the way Node does, so a package hoisted to a monorepo root works. Without an installed package it writes the standard `node_modules` path, and `setup react-native` warns.

The Everframe phases, including the one from `everframe setup xcode`, declare the app's dSYM as their only input, so they run after Xcode writes it. The `EVERFRAME_DSYM_INPUT` build settings are no longer written. The targets keep `ENABLE_USER_SCRIPT_SANDBOXING = NO`, and React Native and Expo targets keep `SOURCEMAP_FILE` when they do not set it. Running the setup again replaces the phase in place.
