---
"@everframe/sdk-ios-marker": patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

iOS and tvOS: a main-thread stall of 5 seconds or more that recovered no longer turns a later force-quit, before the next 5-second sample, into an "Unresponsive termination". The stored stall is cleared as soon as the main thread answers.
