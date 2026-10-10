---
"@everframe/sdk-android": patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Android crash capture: a replacement `start()` that is delayed past a newer start no longer clears the newer start's OS exit token while `Everframe.isNativeCrashCaptureReady()` still reports true. The token clear now checks, under the lock every token write takes, that its start is still the newest, and fences only owners of older starts. On API 30 with the optional native-crash module, an exception while setting up the signal collector no longer skips OS exit capture, so native crash and ANR capture stay on. A signal-collector delivery receipt now lasts as long as the OS exit record it settles instead of 14 days, so a launch reported by the signal collector is not reported a second time from its OS exit after a long gap or a clock change.
