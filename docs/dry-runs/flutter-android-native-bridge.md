<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Flutter Android native bridge dry run

Updated: 2026-09-29. Public feature branch in the main worktree. Status: **BLOCKED** for Flutter Android launch; this is an unreleased dry run.

The sample used Flutter 3.47.5, Dart 3.13.4, an Android 16/API 36 Pixel 9 Pro XL emulator, and disposable `dev.everframe:*:0.9.0-DEV` debug artifacts built with `EVERFRAME_DEV_INGEST_URL=http://10.0.2.2:8937`. The debug sample permits cleartext traffic for that local stub. No development backend or real key was used. The Android plugin accepts only the development environment. `FlutterFragmentActivity` is required for the Compose reporter; the bridge returns `unsupported_host` for a default `FlutterActivity` instead of crashing. The Dart bridge captures a masked Flutter boundary PNG before opening the native reporter. Missing geometry or capture rejects the open. Additional native screenshots are hidden for this route because they would bypass the Flutter mask.

| Capability | Evidence | Result |
| --- | --- | --- |
| Native bridge build | Debug APK compiled against the local SDK AARs | **PASS** |
| Method channel | Emulator test called start, setUser, recordScreen, addBreadcrumb, kill; post-kill reporter open returned `not_started` | **PASS** for routing |
| Flutter visual replay | Emulator test retained two distinct renderer frames after a tap; public tile changed green to blue; sensitive tile pixels were black in both | **PASS** in this scene |
| Dynamic privacy bounds | Widget test moved a sensitive widget and checked the new mask; an exact capture-boundary edge is accepted; out-of-bound masks refuse capture | **PASS** in tested geometry |
| Native reporter screenshot | Emulator editor showed green Flutter UI and a black sensitive tile; manual cancel returned to Flutter | **PASS** in this scene |
| Additional screenshots | Disabled for the Flutter route to prevent an unmasked native recapture | **GATED** |
| Local submit | Native reporter returned `submitted`; a loopback fake ingest received a three-part multipart report: envelope, screenshot, and `replay.json` | **PASS** for local transport only |
| Replay attachment | Envelope and VTree passed shared protocol parsing; replay SHA-256 and byte count matched the multipart bytes. The timeline contained 109 frames and three PNG assets. Public tile pixels changed green to blue, while the sensitive tile was black in every asset. Local config enabled replay. | **PASS** in this scene |
| Production delivery and dashboard | No real backend or dashboard record checked | **BLOCKED** |
| Flutter identity | Local handled-error and manual reports identify `sdk.name=everframe-flutter`, `platform=android`; shared protocol parsing accepted both | **PASS** for local transport |
| Handled Dart error | Integration test received a true durable-capture acknowledgement; the normal sample then delivered `source=error`, `handled=true`, `fatal=false`, `mechanism=captureException`, and the Dart stack to local fake ingest | **PASS** for explicit errors only |
| Network context | Explicit `recordNetwork` call produced a `kind=network` breadcrumb with only method, URL origin, status, and duration. The private path, token query, and URL credentials were absent from the local envelope | **PASS** for opt-in context only |
| Offline retry and dashboard | No offline-to-online delivery or real backend/dashboard record checked | **BLOCKED** |

The screenshot proof covers Flutter framework pixels inside the registered boundary, not embedded Android platform views, video, rotation, or real devices. The initial PixelCopy path returned a black Flutter screenshot; the masked Flutter PNG path produced the readable editor image. The first local submit queued with no replay before the debug cleartext/config dry run was corrected; the later submit reached the fake ingest with replay. A later local manual report after recording Dart context included a masked screenshot and correct identity, but omitted replay; the bounded recorder had refused at least one frame or export, and this case is under investigation. Native `sdk.version` is the underlying Android SDK version in this dry run. No all-platform launch action was taken.
