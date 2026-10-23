---
'@everframe/cli': patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

`hotkey` is retired: quick capture now takes ⇧B inside the app on both the iOS simulator and the Android emulator. The command prints `The hotkey command is no longer needed: press Shift+B in the emulator (outside a text field) to capture. npx @everframe/cli capture still works.` and exits 0, still accepting its old `--key` flag. The macOS Swift helper is no longer built or shipped. `capture`, `login`, `link` and `logout` are unchanged.
