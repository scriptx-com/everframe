<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Flutter Android native bridge dry run

Date: 2026-09-28. Public code revision: `8fda5b722d534a986b01cae09737e61ed65ef5db` on local branch `codex/macos-desktop-probe`. Status: **BLOCKED** for Flutter Android support; this is an unreleased dry run.

The sample used Flutter 3.47.5, Dart 3.13.4, an Android 16/API 36 Pixel 9 Pro XL emulator, and disposable `dev.everframe:*:0.9.0-DEV` debug artifacts built with `EVERFRAME_DEV_INGEST_URL=http://10.0.2.2:8937`. No development backend or real key was used. The Android plugin accepts only the development environment and disables native screenshot and automatic crash capture. The server-controlled native replay path has not been validated for Flutter privacy; use only a throwaway project for any further reporter test.

| Capability | Evidence | Result |
| --- | --- | --- |
| Native bridge build | Debug APK compiled against the local SDK AARs | **PASS** |
| Method channel | Emulator test called start, setUser, recordScreen, addBreadcrumb, kill; post-kill reporter open returned `not_started` | **PASS** for routing |
| Flutter visual replay | Emulator test retained two distinct renderer frames after a tap; public tile changed green to blue; sensitive tile pixels were black in both | **PASS** in this scene |
| Dynamic privacy bounds | Widget test moved a sensitive widget and checked the new mask; an exact capture-boundary edge is accepted; out-of-bound masks refuse capture | **PASS** in tested geometry |
| Native reporter open/annotate/cancel/submit | No live reporter completion or ingest record tested | **BLOCKED** |
| Native/Flutter visual merge | Safe Flutter frames are in memory only; native report capture does not consume them | **BLOCKED** |
| Identity, Dart errors, network, offline retry, dashboard | New `everframe-flutter` protocol identity is reserved, but native reports still default to `everframe-android`; other gates untested | **BLOCKED** |

`flutter test`, `flutter analyze`, Android debug build, two emulator integration tests, native protocol tests, Swift protocol target build, focused protocol schema tests, and the public boundary check passed. The screenshot and replay proof covers Flutter framework pixels, not embedded Android platform views or native reporter controls. No report was sent and no all-platform launch action was taken.
