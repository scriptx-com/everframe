<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Flutter iOS native bridge dry run

Updated: 2026-09-29. Local `main` worktree. Status: **BLOCKED** for Flutter iOS launch; this is an unreleased dry run.

The sample used Flutter 3.47.5, Dart 3.13.4, the local Swift SDK through Swift Package Manager, and an iOS 27.0 iPhone 18 Pro simulator. `flutter build ios --simulator --debug --no-codesign`, widget tests, analysis, and two simulator integration tests passed. The plugin requires an absolute `EVERFRAME_SDK_IOS_ROOT` because Flutter links plugin packages into an ephemeral SwiftPM directory. The sample pins `EverframeDevIngestURL` to `http://127.0.0.1:8937`; the plugin refuses a non-loopback endpoint. Its key is a fake, validator-shaped `txx_live_` value accepted only by the local stub.

| Capability | Evidence | Result |
| --- | --- | --- |
| Native Swift bridge | iOS simulator app compiled against local `EverframeKit` and reporter UI; start, setUser, recordScreen, addBreadcrumb, and kill calls completed | **PASS** for routing |
| Flutter visual replay | Simulator test retained two distinct renderer frames after a tap; public tile changed green to blue and sensitive tile pixels were black in both | **PASS** in this scene |
| Native reporter screenshot | Simulator screenshot editor showed green Flutter UI and a black sensitive tile from the masked Flutter PNG; cancel returned to Flutter | **PASS** in this scene |
| Additional screenshots | Disabled for the Flutter route to prevent an unmasked UIKit recapture | **GATED** |
| Local submit | Native reporter returned `submitted`; a loopback fake ingest received a three-part multipart report: envelope, screenshot, and `replay.json` | **PASS** for local transport only |
| Replay attachment | Two simulator unit tests passed for native validation. The submitted envelope and VTree passed shared protocol parsing; replay SHA-256 and byte count matched the multipart bytes. Its 82 frames used six PNG assets. Public tile pixels changed green to blue, while the sensitive tile was black in every asset. | **PASS** in this scene |
| Production delivery and dashboard | No real backend or dashboard record checked | **BLOCKED** |
| Identity, Dart errors, network, offline retry, dashboard | Protocol accepts `everframe-flutter`, but native iOS reports still default to `everframe-ios`; other gates untested | **BLOCKED** |

The CocoaPods fallback podspec was added but not exercised; this measurement uses SwiftPM. The screenshot proof covers Flutter framework pixels inside the registered boundary, not a physical iPhone, UIKit platform view, rotation/scale geometry, or production delivery. The first attempt started the recorder during a changing frame and omitted Flutter replay; awaiting a stable frame fixed the sample. When safe Flutter replay is unavailable, the host-rendered reporter now suppresses native video instead of attaching it. Offline retry and the live production replay switch remain unverified. No package was published and no all-platform launch action was taken.
