---
"@everframe/cli": minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Adds simulator and emulator quick capture commands:

- `login [--url <api-url>] [--no-browser]` signs in through your browser and saves a capture token in `~/.everframe/credentials` (directory `0700`, file `0600`). It also links running Android emulators, and still succeeds when `adb` is missing or no emulator is running.
- `logout` revokes the token, removes the credentials file and clears running emulators.
- `link` copies the saved token to running Android emulators only, never to physical devices.
- `capture [--device <udid|name|serial>]` triggers one capture on the booted iOS simulator (Darwin notification `com.everframe.capture`) or running Android emulator (broadcast `com.everframe.CAPTURE`). With several booted it lists them and exits 2.
- `hotkey [--key <combo>]` (macOS) registers a global shortcut, default Cmd+Shift+B, while a standalone Android emulator window is in front, and sends the capture to that emulator. The combo needs Cmd or Ctrl. It compiles a small Swift helper into `~/.everframe/bin` on first run and needs the Xcode Command Line Tools. Emulators embedded in Android Studio need "Launch in the Running Devices tool window" turned off.

The package now ships a `helpers` directory.
