<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# KMP mobile bridge dry run

Date: 2026-09-28. Public local branch: `codex/macos-desktop-probe`. No package release, backend submission, or production traffic.

The unreleased `packages/everframe_kmp` module declares Android, iOS simulator, iOS device, and JVM targets; Android, iOS simulator, and JVM were compiled here. The Android implementation calls the existing SDK. The iOS implementation is a Swift driver conforming to a Kotlin/Native-exported Objective-C protocol; both a SwiftUI host and a Compose Multiplatform host use it. This avoids direct Kotlin/Native interop with the Swift-only SDK. Native SDK screenshot and automatic crash flags are false, while the native reporter still takes a manual screenshot when opened.

| Target | Verified here | Still blocked |
| --- | --- | --- |
| Shared KMP | JVM contract tests pass; Android compilation and iOS simulator framework link pass | Package API, lifecycle, error and network context, exact `everframe-kmp` report identity |
| Android Compose | Debug APK built and installed on API 36 emulator; bridge started; tapped A→B; native reporter opened; `txSensitive()` blacked the magenta tile in the reporter editor while public Compose pixels remained visible | Two-frame report replay, cancel/submit outcome, outbox/retry, backend/dashboard, real device |
| iOS SwiftUI/UIKit host | Xcode app built and launched on iPhone 18 Pro simulator; UI test started the KMP bridge and tapped A→B | Reporter screenshot/privacy, replay, submit/outbox/backend, real device |
| iOS Compose host | Compose framework and Xcode app built; two UI tests passed for bridge start, A→B tap, and native reporter open; editor screenshot pixel test found visible green Compose pixels and zero magenta sentinel pixels after a UIKit sensitive marker followed Compose layout bounds | Full visual replay, popup/rotation/scale privacy geometry, submit/outbox/backend, real device |

The Android reporter initially exposed the magenta tile even with `CaptureConfig(screenshot = false)`. Adding the native SDK's `Modifier.txSensitive()` blacked it out in a second live reporter capture. The iOS Compose probe uses `onGloballyPositioned` to pass its tile bounds to a transparent marked `UIView`; the reporter editor then showed a black rectangle at that location. Both results cover only fixed sample scenes. A customer integration needs automatic registration and fail-closed handling of missing or invalid geometry.

Build inputs: Kotlin 2.4.20, AGP 8.7.2, Compose Multiplatform 1.13.0-alpha01, Gradle 8.10.2, Xcode 27.0, iOS 27.0 simulator, Android API 36 emulator. Android used disposable `0.9.0-DEV` SDK AARs from `/tmp/everframe-flutter-android-m2` with loopback ingest `http://10.0.2.2:8937`; iOS hosts used a fake validator-shaped key and `http://127.0.0.1:8937`. No development backend was running.

The focused commands were `jvmTest compileDebugKotlinAndroid linkDebugFrameworkIosSimulatorArm64` for the KMP module, `assembleDebug` for the Android host, `linkDebugFrameworkIosSimulatorArm64` for the Compose host, and `xcodebuild test` for both iOS schemes. The Compose iOS sample temporarily supplies the installed Xcode Swift library search path because a cached Compose library referenced removed Xcode 26.4; that hard-coded link option is sample-only. XcodeGen source and the generated project are in `examples/kmp-ios-probes`; build the two KMP frameworks before opening the Xcode project.

The reporter UI was **not** submitted. Screenshots inspected for this dry run live under `/tmp` and were not committed. Framework replay frames, handled errors, HTTP context, offline restart/retry, native-view mixtures beyond this sample, and dashboard appearance remain required before support can be claimed.
