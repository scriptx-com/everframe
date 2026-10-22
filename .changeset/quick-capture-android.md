---
"@everframe/sdk-android": minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Debug builds on Android emulators can file a report from a broadcast trigger,
with no reporter UI. The report carries the screenshot, replay, logs and
metadata, is marked `quickCapture`, and is attributed to the developer when a
capture token is available. It stays dark until the server sends `captureHotkey`
in the project config, and can be turned off locally with
`quickCaptureEnabled = false`. Physical devices and release builds are
unaffected.

When the block also sets `replay: true`, session replay records while quick
capture is armed, even if the app's `replayEnabled` is false and regardless of
its sampling rate. The flag never turns replay off; after a disarm, replay
follows `replayEnabled` again. A queued report with a native video replay from the same project and session
keeps it when a retry in that session runs while quick capture still forces
replay. A retry at the next app launch runs before the dashboard config
arrives, so it sends the capture without its replay.

The public `ReporterTrigger` enum gained a `QuickCapture` case (raw value
`quick_capture`). Host code that uses an exhaustive `when` over `ReporterTrigger`
needs an `else` branch.

The public Kotlin functions `effectiveNativeVideo` and
`ReportAuthorizationFactory.forPending` gained a trailing defaulted parameter.
This is source-compatible; recompile callers outside the SDK for binary
compatibility.
