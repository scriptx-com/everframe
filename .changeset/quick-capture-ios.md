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
follows `replayEnabled` again. A key press that UIKit delivers twice is counted
once.

The public `ReporterTrigger` enum gained a `quickCapture` case (raw value
`quick_capture`). Host code that switches exhaustively over `ReporterTrigger`
needs a `default` branch.
