---
'@everframe/react-native': patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Quick capture on debug simulators and emulators is ⇧B inside the app on both platforms, skipped while a `TextInput` has focus (native iOS and Android SDK 1.5.1). `npx @everframe/cli capture` still works; `npx @everframe/cli hotkey` is no longer needed.
