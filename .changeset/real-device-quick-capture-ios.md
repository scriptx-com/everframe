---
'@everframe/sdk-ios-marker': minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Quick capture on real iPhones and iPads: shake files a capture for the team member the device is linked to, for the team on a team device, or to the shared inbox from a debug build. An unlinked device links itself when a teammate clicks Link a device on the dashboard and shakes it; no app code is needed. Release builds on end users' devices behave as before. The device token is kept in the Keychain and sent only to the ingest origin that issued it.
