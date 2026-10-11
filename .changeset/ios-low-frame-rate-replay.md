---
"@everframe/sdk-ios-marker": minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

iOS and tvOS session replay can record at 1 or 2 frames per second as well as 5 and 10. The config request declares `nativevideolowfps`, so the server sends a low rate only to SDKs that accept it. Below 5 fps the encoder bitrate scales with the frame rate (1.2 Mbps × fps / 5). Recording also pauses while Low Power Mode is on, and drops its buffer as it already does for memory warnings and serious heat.
