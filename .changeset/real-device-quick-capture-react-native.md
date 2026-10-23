---
'@everframe/react-native': minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Quick capture and device linking on real phones arrive through the native iOS and Android SDKs, with no config change and no JavaScript API: link a phone from the dashboard (**Settings → Devices → Link a device**, then shake it and click the number its banner shows) and a shake files a quick capture for you in any build; a debug build (`__DEV__`, or `debugBuild`) also takes shared captures on shake without linking, alongside the React Native development menu. Release builds on end users' phones behave as before. `shakeToReport` now controls only whether shake opens the reporter on an unlinked release build; `quickCapture: { enabled: false }` turns off quick capture and linking together.
