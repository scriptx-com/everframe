---
"@everframe/sdk-ios-marker": minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Handled errors captured with `captureException` on iOS and tvOS now carry a session replay of the seconds before them when the session records replay. At most 2 errors per SDK session get one, never while a bug report owns the replay buffer, and never crashes, Apple diagnostics or inferred terminations. The replay is a copy: recording continues, and a later error or bug report still has the whole window. The error is queued at once. If its replay is not ready within 3 seconds or exceeds 8,000,000 bytes, the error is sent without it and `captureControl.degradedReason` records why. `CrashReporter.captureFacts` and `CrashReporter.captureHandledFacts` gain an `attachReplay` parameter, off by default, so the React Native bridge can ask for the same replay on JavaScript errors.
