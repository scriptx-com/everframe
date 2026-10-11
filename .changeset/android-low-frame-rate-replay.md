---
"@everframe/sdk-android": minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Android session replay records at 1, 2, 5 or 10 frames per second. The SDK declares `nativevideolowfps`, so the server can send 1 or 2. The encoder keeps 1.5 Mbps at 5 fps and above and scales linearly below: 300 kbps at 1 fps and 600 kbps at 2 fps. Recording now also pauses while Battery Saver is on or the thermal status is MODERATE or higher (it used to pause only at SEVERE), and it never starts on a low-RAM device (`ActivityManager.isLowRamDevice()`).
