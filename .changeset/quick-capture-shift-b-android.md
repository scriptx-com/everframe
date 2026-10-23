---
'@everframe/sdk-android': patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Quick capture on debug Android emulators now triggers from inside the app: press ⇧B (on phone and TV emulators). The chord is skipped while a text field has focus (an `EditText`, a React Native `TextInput`, a Compose or Flutter text field), so typing a capital B stays typing; otherwise the key press is kept from the app. The dashboard's capture hotkey binding is used when it is Shift plus a letter or digit (such as `Shift+K`); any other binding (double Shift, ⌘, ⌃ or ⌥ combos, which the emulator cannot deliver) falls back to ⇧B. The `com.everframe.CAPTURE` broadcast, and `npx @everframe/cli capture`, still work.

The `Captured · <device name>` toast now appears as soon as the capture is taken and handed to the upload, instead of after the upload finishes. A queued upload adds no second toast (the `Captured · uploads when online` toast is gone), and an upload that is rejected and not queued follows with `Capture didn't upload`.
