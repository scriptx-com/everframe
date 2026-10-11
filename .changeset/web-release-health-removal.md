---
"@everframe/web": minor
"@everframe/react": minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Web and React release health is removed. `setupReleaseHealth` and its `ReleaseHealthOptions`, `ReleaseHealthDiagnostics` and `ReleaseHealthHandle` types are no longer exported, the `releaseHealth` option is gone from `init()` and `EverframeProvider`, and the handle `init()` returns no longer has `releaseHealth`. A config that still passes the option is ignored and opens no browser storage. Release health now counts foreground sessions on Android, iOS and React Native only; errors in a web app still show up under Errors.
