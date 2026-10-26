---
'@everframe/roku': patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Roku: a channel can now report its own app version by adding `everframe_app_version=12.5.0` to the manifest. Roku limits the manifest version to `major.minor.build`, so this is the way to report a version like `12.5.0`. The value is used when it is 1-64 characters, not blank, and has no control characters; otherwise the SDK keeps using `roAppInfo.GetVersion()`. Crash reports, release health and the previous-session exit record all use it.
