---
'@everframe/vega': minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Configurable capture gesture and Record on device on Vega OS. The SDK now negotiates `capturegesture` and follows the app's remote binding from the dashboard: a long press, a sequence (for example ↑↑↓↓ within a second) or a chord, over the keys a Vega remote can send (D-pad, Select, Back, Menu, Play/Pause, Fast forward, Rewind, digits). A binding that uses keys a Vega remote does not have (color keys, letters, Shift) turns the gesture off on the device, with one warning in debug builds; a missing or malformed binding keeps the default long press of Play/Pause. A linked device asked to record a gesture shows `Recording remote keys for 10 seconds`, records up to 32 key presses for 10 seconds, uploads them with its device token and shows `Keys sent to Everframe`; the capture gesture pauses meanwhile and keys still reach the app.
