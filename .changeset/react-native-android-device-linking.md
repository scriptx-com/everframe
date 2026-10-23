---
'@everframe/react-native': patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

README: quick capture on real Android devices. Link a phone from the dashboard and shake it to file a quick capture; debug builds on real Android devices also take a quick capture on shake, so `shakeToReport: { enabled: !__DEV__ }` now only stops shake from opening the reporter there. No API changes.
