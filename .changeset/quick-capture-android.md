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
arrives, so it sends the capture without its replay. Native video replay never
records frames that show Jetpack Compose content, so quick captures taken on
Compose screens carry the screenshot, logs and metadata but no replay.

A session started with `capture.screenshot = false` ignores quick capture unless
the host has installed an evidence provider with
`Everframe.__setQuickCaptureEvidenceProvider`. That SDK seam is for host plugins,
such as Flutter's, that mask their own pixels and supply the screenshot and
replay themselves. Such a session never uploads an unmasked native screenshot.
`HostImageVTreeAttachment` is now public in `dev.everframe.transport`, and
`CompanionSubmissionComposer.Inputs` gained a defaulted `hostReplayVTree`
parameter. Both are SDK-internal and not for use by host code.

The public `ReporterTrigger` enum gained a `QuickCapture` case (raw value
`quick_capture`). Host code that uses an exhaustive `when` over `ReporterTrigger`
needs an `else` branch.

The public Kotlin functions `effectiveNativeVideo` and
`ReportAuthorizationFactory.forPending` gained a trailing defaulted parameter.
This is source-compatible; recompile callers outside the SDK for binary
compatibility.
