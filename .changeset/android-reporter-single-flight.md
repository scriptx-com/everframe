---
"@everframe/sdk-android": patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Opening the reporter while one is already open no longer presents a second reporter on Android. A caller that opens it while the reporter is on screen now waits for that report and receives its result. After Send, while the report is still uploading, a new open resolves at once as cancelled with reason `already_presenting`. Either way, that caller's own pending `setExtra` value is discarded instead of shipping with a later, unrelated report. If the activity showing the reporter finishes or is destroyed before Send, the next open presents a new reporter instead of waiting, and callers already waiting resolve as cancelled with reason `activity_destroyed`. Previously a host shake listener firing together with the SDK's own shake trigger opened two reporters: the one on top had an empty capture, so the submitted report lost its session replay, and the hidden one kept replay recording paused until it was closed.
