---
"@everframe/sdk-ios-marker": patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

`EFReporterPresenter.installResolver()` now exists on tvOS, where it does nothing, so the same launch code compiles in an iOS and a tvOS target. tvOS still has no on-device reporter: `report.open()` throws there and reports are filed through the companion.
