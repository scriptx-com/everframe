---
"@everframe/sdk-ios-marker": patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Keep up to 60 seconds of session replay on iOS and tvOS, matching Android and the dashboard's replay duration setting. The recorder, session and exporter each capped the window at 30 seconds regardless of the configured duration.
