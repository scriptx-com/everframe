<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Flutter iOS native bridge dry run

Date: 2026-09-28. Public code revision: `1486cbcc7929e722153fad05a84ba40929fe1a86` on local branch `codex/macos-desktop-probe`. Status: **BLOCKED** for Flutter iOS support; this is an unreleased dry run.

The sample used Flutter 3.47.5, Dart 3.13.4, the local Swift SDK through Swift Package Manager, and an iOS 27.0 iPhone 18 Pro simulator. `flutter build ios --simulator --debug --no-codesign`, widget tests, analysis, and two simulator integration tests passed. The plugin requires an absolute `EVERFRAME_SDK_IOS_ROOT` because Flutter links plugin packages into an ephemeral SwiftPM directory. The sample pins `EverframeDevIngestURL` to `http://127.0.0.1:8937`; the plugin refuses a non-loopback endpoint. Its key is a fake, validator-shaped `txx_live_` value and cannot authorize a report.

| Capability | Evidence | Result |
| --- | --- | --- |
| Native Swift bridge | iOS simulator app compiled against local `EverframeKit` and reporter UI; start, setUser, recordScreen, addBreadcrumb, and kill calls completed | **PASS** for routing |
| Flutter visual replay | Simulator test retained two distinct renderer frames after a tap; public tile changed green to blue and sensitive tile pixels were black in both | **PASS** in this scene |
| Native reporter open/annotate/cancel/submit | Only the post-kill `not_started` response was checked; no real report was sent | **BLOCKED** |
| Visual merge and privacy | Flutter frames remain in memory; native report capture does not consume them. Native screenshots and automatic crash capture are disabled for this dry run; server-controlled replay is unverified | **BLOCKED** |
| Identity, Dart errors, network, offline retry, dashboard | Protocol accepts `everframe-flutter`, but native iOS reports still default to `everframe-ios`; other gates untested | **BLOCKED** |

The CocoaPods fallback podspec was added but not exercised; this measurement uses SwiftPM. It does not cover a physical iPhone, UIKit platform view, rotation/scale geometry, or reporter delivery. No package was published and no all-platform launch action was taken.
