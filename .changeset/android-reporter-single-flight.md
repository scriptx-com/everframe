---
"@everframe/sdk-android": patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Opening the reporter while one is already open no longer presents a second reporter on Android. The second caller now waits for the open report and receives its result. If the activity showing that reporter finishes or is destroyed before the report settles, the next open presents a new reporter instead of waiting, and callers already waiting resolve as cancelled with reason `activity_destroyed`. Previously a host shake listener firing together with the SDK's own shake trigger opened two reporters: the one on top had an empty capture, so the submitted report lost its session replay, and the hidden one kept replay recording paused until it was closed.
