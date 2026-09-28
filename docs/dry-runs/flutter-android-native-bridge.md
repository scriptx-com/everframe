<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Flutter Android native bridge dry run

Date: 2026-09-28. Local branch: `codex/macos-desktop-probe`. Status: **BLOCKED** for Flutter Android launch; this is an unreleased dry run.

The sample used Flutter 3.47.5, Dart 3.13.4, an Android 16/API 36 Pixel 9 Pro XL emulator, and disposable `dev.everframe:*:0.9.0-DEV` debug artifacts built with `EVERFRAME_DEV_INGEST_URL=http://10.0.2.2:8937`. No development backend or real key was used. The Android plugin accepts only the development environment. `FlutterFragmentActivity` is required for the Compose reporter; the bridge returns `unsupported_host` for a default `FlutterActivity` instead of crashing. The Dart bridge captures a masked Flutter boundary PNG before opening the native reporter. Missing geometry or capture rejects the open. Additional native screenshots are hidden for this route because they would bypass the Flutter mask.

| Capability | Evidence | Result |
| --- | --- | --- |
| Native bridge build | Debug APK compiled against the local SDK AARs | **PASS** |
| Method channel | Emulator test called start, setUser, recordScreen, addBreadcrumb, kill; post-kill reporter open returned `not_started` | **PASS** for routing |
| Flutter visual replay | Emulator test retained two distinct renderer frames after a tap; public tile changed green to blue; sensitive tile pixels were black in both | **PASS** in this scene |
| Dynamic privacy bounds | Widget test moved a sensitive widget and checked the new mask; an exact capture-boundary edge is accepted; out-of-bound masks refuse capture | **PASS** in tested geometry |
| Native reporter screenshot | Emulator editor showed green Flutter UI and a black sensitive tile; manual cancel returned to Flutter | **PASS** in this scene |
| Additional screenshots | Disabled for the Flutter route to prevent an unmasked native recapture | **GATED** |
| Submit and delivery | No report sent or ingest record checked | **BLOCKED** |
| Replay attachment | Sample freezes its safe-frame ring while the reporter is open, then restarts it; frames are not attached to the native report and native server-controlled replay remains unverified | **BLOCKED** |
| Identity, Dart errors, network, offline retry, dashboard | New `everframe-flutter` protocol identity is reserved, but native reports still default to `everframe-android`; other gates untested | **BLOCKED** |

The screenshot proof covers Flutter framework pixels inside the registered boundary, not embedded Android platform views, video, rotation, or real devices. The initial PixelCopy path returned a black Flutter screenshot; the masked Flutter PNG path produced the readable editor image. No report was sent and no all-platform launch action was taken.
