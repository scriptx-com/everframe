---
'@everframe/vega': minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Quick capture on linked Vega devices: device linking, long press Play/Pause, takeover. `init()` now installs a root wrapper with `AppRegistry.setWrapperComponentProvider` that listens to remote keys (never consuming one) and draws the linking banner and toasts. A long press of Play/Pause (about 1.5 s) on a device linked from the dashboard files a quick capture attributed to that person or team (`Captured · {name}`); an unlinked debug build files a shared draft, and an unlinked release build only offers itself for linking. The link token is stored in the `storage` you pass, bound to the endpoint and SDK key. A capture holds breadcrumbs, device, app and user details; there is no screenshot or replay on Vega OS. The SDK now makes one `GET /api/config` per launch; `quickCaptureEnabled: false` turns all of this off. `react` (>=18) is now a peer dependency.
