---
'@everframe/sdk-android': minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Quick capture on real Android phones. Link a phone to yourself from the dashboard (**Settings → Devices → Link a device**, then shake the phone and click the number its banner shows, `Linking to Everframe · 47`); the phone shows `Linked to <name>`, and from then on a shake files a quick capture for you, in debug and release builds, with the toast `Captured · <name>` (`Captured · team device` for a team device). Debug builds on real devices also take shared captures on shake without linking. An unlinked release build behaves as before: shake opens the reporter if shake-to-report is on, and it also says hello to an open dashboard link window.

- Shake now runs while quick capture is armed or device linking is on, whatever `shakeToReport`/`shakeToReportEnabled` say; those switches decide only whether an unlinked release build opens the reporter. A crash-only session (`reporterEnabled = false`) never listens for shake.
- Linked devices and debug builds record replay while quick capture is armed when the capture hotkey's replay setting is on. Unlinked release builds never do.
- A linked device can be taken over by another teammate, who opens **Link a device** while you shake.
- An unlinked or revoked device shows `This device was unlinked` and falls back to unlinked behavior; the refused capture is not filed in the shared inbox.
- The device token is encrypted under an AndroidKeyStore key in `noBackupFilesDir`, sent only to the ingest endpoint and SDK key that linked it, and never logged. A capture queued offline is sent later only while the same token is stored.
- `GET /api/config` declares the `devicelinking` capability.
