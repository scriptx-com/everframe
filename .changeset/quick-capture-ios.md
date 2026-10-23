---
"@everframe/sdk-ios-marker": minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Debug iOS simulator builds can file a report with a double Shift press,
with no reporter UI. The report carries the screenshot, replay, logs and
metadata, is marked `quickCapture`, and is attributed to the developer when
`$SIMULATOR_HOST_HOME/.everframe/credentials` holds a token. It stays dark until
the server sends `captureHotkey` in the project config, and can be turned off
locally with `quickCaptureEnabled = false`. Devices and release builds are
unaffected. The tvOS simulator is not yet verified.

When the block also sets `replay: true`, session replay records while quick
capture is armed, even if the app's `replayEnabled` is false and regardless of
its sampling rate. The flag never turns replay off; after a disarm, replay
follows `replayEnabled` again. A queued report with a native video replay from the same project and session
keeps it when a retry in that session runs while quick capture still forces
replay. A retry at the next app launch runs before the dashboard config
arrives, so it sends the capture without its replay, and the launch drain removes the replay from the queued
entry. A key press that UIKit delivers twice is counted
once.

A session started with `capture.screenshot = false` ignores quick capture unless
the host has installed an evidence provider with
`Everframe.__setQuickCaptureEvidenceProvider`. That SDK seam is for host plugins,
such as Flutter's, that mask their own pixels and supply the screenshot and
replay themselves. Such a session never uploads an unmasked native screenshot.

The public `ReporterTrigger` enum gained a `quickCapture` case (raw value
`quick_capture`). Host code that switches exhaustively over `ReporterTrigger`
needs a `default` branch.
