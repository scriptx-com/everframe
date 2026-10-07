---
"@everframe/sdk-ios-marker": patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Keep up to 60 seconds of session replay on iOS and tvOS, matching Android and the dashboard's replay duration setting. The recorder, session and exporter each capped the window at 30 seconds regardless of the configured duration.

Player controls drawn over a video now stay visible in iOS and tvOS replays. The video surface is still recorded as a black box; before, its whole area was blacked out after rendering, which on a full-screen player blacked out the entire frame.
