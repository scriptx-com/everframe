---
"@everframe/sdk-ios-marker": minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Debug iOS and tvOS simulator builds can file a report with a double Shift press,
with no reporter UI. The report carries the screenshot, replay, logs and
metadata, is marked `quickCapture`, and is attributed to the developer when
`$SIMULATOR_HOST_HOME/.everframe/credentials` holds a token. It needs the
dashboard's capture hotkey setting and can be turned off locally with
`quickCaptureEnabled = false`. Devices and release builds are unaffected.
