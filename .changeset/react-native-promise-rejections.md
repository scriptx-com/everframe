---
"@everframe/react-native": minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Add opt-in reporting of unhandled promise rejections on Hermes. With `crashReporting.promiseRejections.enabled: true`, a rejection still unhandled after 2 seconds is reported through the existing nonfatal error path; a handler attached within that interval cancels the report. Observation installs only on the verified runtime, `react-native-tvos@0.85.3-0` with Hermes `250829098.0.10` on Android and iOS, and reports `unsupported` elsewhere, including browser execution. At most 16 pending snapshots of up to 64 KiB each are kept, and work older than 30 seconds expires instead of being reported. Rejection reasons that are not `Error` objects are reported as a bounded primitive value or a type label such as `[object]`, never as serialized object contents.

`getPromiseRejectionStatus()` reports whether the observer is active, with counters for pending, accepted, cancelled, dropped, expired, suppressed, refused, failed and discarded rejections.
