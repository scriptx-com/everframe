---
"@everframe/protocol": minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Add `payload.inferredTermination`, the next-launch evidence for an iOS or tvOS foreground process that the OS killed without a crash report (low memory, unresponsive or unexplained). It rides on its own anonymous, stackless fatal crash with mechanism `apple-termination-inference` and one fingerprint per cause, never Android's low-memory group. Generated Swift and Kotlin payloads keep their previous initializers and constructors.
