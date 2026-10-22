---
"@everframe/protocol": minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Envelopes may carry an optional `quickCapture` boolean, set when a report is filed by the debug quick-capture trigger instead of the reporter UI. The generated Swift `EverframeReportEnvelope` memberwise initializer gains a `quickCapture` parameter, so code that constructs the envelope directly must pass it.
