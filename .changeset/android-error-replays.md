---
"@everframe/sdk-android": minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Android: in a session that records replay, a handled error reported with `Everframe.captureException` (or the KMP equivalent) now carries the last seconds of video as a `session-replay` attachment, at most two per `start`. The snapshot leaves the recording running, so a later error or bug report still has the full history. The error is stored at once. Its replay is attached within 3 seconds; past that, or when the clip does not fit, the error ships without it and `captureControl.degradedReason` includes `replay_omitted`. No error takes a replay while a bug report is open. Crashes, recovered stalls and OS exit evidence never carry one. React Native gains internal bridge entry points for the same behaviour.
