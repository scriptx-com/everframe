---
"@everframe/sdk-ios-marker": minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

iOS and tvOS: report a previous foreground process that the OS ended with `SIGKILL` (low memory, unresponsive or unexplained) on the next launch as one anonymous, stackless fatal labelled as inferred, with the last sampled memory footprint. It follows `capture.crash`, evaluates only the previous run, and is off in app extensions, Mac Catalyst, iOS apps on a Mac and, unless opted in for qualification, the simulator. On iOS with release health it counts as an other exit, never as a crash.
