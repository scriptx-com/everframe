---
'@everframe/sdk-android': minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Quick capture on Android TV. The gesture is a remote binding set per app on the dashboard, by default holding Play/Pause for 1.5 seconds. Link a TV like a phone: do the gesture while **Link a device** is open on the dashboard and click the number its banner shows. A linked TV then files a quick capture for you (`Captured · <name>`), a debug build files shared captures, and an unlinked release build shows nothing and only says hello to an open link window.

- Bindings are a long press, a sequence (keys in order within a time window) or a chord (keys held together), over the contract key names (`DPAD_*`, `BACK`, `MENU`, `MEDIA_PLAY_PAUSE`, `MEDIA_FAST_FORWARD`, `MEDIA_REWIND`, `PROG_*`, `A`–`Z`, `0`–`9`, `SHIFT`). A binding the SDK cannot follow exactly is ignored.
- Key handling: an unlinked device never has a key swallowed or changed. On a linked device the first press always reaches the app (so a Play/Pause long press toggles playback once at the start), then the long press's repeats are swallowed and its key-up arrives canceled; a sequence swallows only its last key and a chord only its completing key.
- **Record on device**: a linked device asked by the dashboard records up to 32 key presses for 10 seconds (`Recording remote keys for 10 seconds`, then `Keys sent to Everframe`) while the keys still reach the app, so the dashboard can build a binding from the real remote. Linked devices now refresh their config when the app comes to the foreground, at most every 10 seconds.
- Fire TV runs the same code; it is not verified yet.
- `GET /api/config` declares the `capturegesture` capability.
