---
"@everframe/sdk-android": minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Android: `EverframeConfig(reporterEnabled = false)` starts a crash-only session. Shake never installs and `Everframe.report.open()` throws `ReporterDisabledException` (`openAsync` passes it to `onError`). Network bodies stay off, and replay records at the dashboard's crash-only coverage, `crashOnlySamplingRate`, which is 0 by default and which the SDK requests with the `crashonly` feature token. A companion bond, by QR code or dashboard attach, gives the rest of that session normal replay coverage and server body rules; the on-device entry points stay off. Crash and error capture, breadcrumbs, vitals, release health and companion are unchanged. The React Native Android bridge maps `reporterDisabled` onto the switch and rejects `openReporter` with `EVERFRAME_REPORTER_DISABLED`.
