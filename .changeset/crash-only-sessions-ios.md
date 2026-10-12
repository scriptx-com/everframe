---
"@everframe/sdk-ios-marker": minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

iOS and tvOS add crash-only sessions. `EverframeConfig(reporterEnabled: false)` turns the on-device reporter off: shake stays off, `report.open()` throws `EverframeReporterError.reporterDisabled`, network bodies are not captured, and session replay records only in the server's `crashOnlySamplingRate` share of sessions, which is 0 by default. The config request declares `crashonly`, so the server sends that rate only to SDKs that accept it. A companion bond, a phone scanning the QR code or a dashboard member attaching, upgrades the session until the next `start` or `kill`, and replay and network bodies then follow the normal server rules. Shake and `open()` stay off after an upgrade. In React Native, the iOS bridge reads `reporterDisabled` and rejects `openReporter` with `EVERFRAME_REPORTER_DISABLED` in a crash-only session.
