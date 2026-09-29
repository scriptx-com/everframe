<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# KMP mobile bridge dry run

Updated: 2026-09-29. Public local `main` worktree. No package release, real backend submission, or production traffic.

The unreleased `packages/everframe_kmp` module declares Android, iOS simulator, iOS device, and JVM targets; Android, iOS simulator, and JVM were compiled here. The Android implementation calls the existing SDK. The iOS implementation is a Swift driver conforming to a Kotlin/Native-exported Objective-C protocol; both a SwiftUI host and a Compose Multiplatform host use it. This avoids direct Kotlin/Native interop with the Swift-only SDK. Native SDK screenshot and automatic crash flags are false, while the native reporter still takes a manual screenshot when opened.

| Target | Verified here | Still blocked |
| --- | --- | --- |
| Shared KMP | JVM contract tests pass; Android compilation and iOS simulator framework link pass | Package API, lifecycle, error and network context, exact `everframe-kmp` report identity |
| Android Compose | API 36 emulator submitted a report to the loopback fake ingest with screenshot and 26 image replay frames. The shared protocol accepted the envelope and replay; attachment hashes and lengths matched. Both green and blue public frames were present, and the marked sensitive tile was black in every distinct replay image. | Dynamic privacy geometry, outbox/retry, backend/dashboard, real device |
| iOS SwiftUI/UIKit host | iPhone 18 Pro simulator submitted to the loopback fake ingest. The shared protocol accepted the envelope with screenshot and native-video replay; attachment hashes and lengths matched. | Secure-field/video privacy beyond this scene, outbox/retry, backend/dashboard, real device |
| iOS Compose host | Simulator submitted to the loopback fake ingest. The shared protocol accepted screenshot and native-video replay; hashes and lengths matched. The screenshot had visible blue Compose pixels and zero magenta sentinel pixels. One-second samples across the 27-second MP4 showed blue Compose content and zero magenta pixels. | Popup/rotation/scale privacy geometry, outbox/retry, backend/dashboard, real device |

The Android reporter initially exposed the magenta tile even with `CaptureConfig(screenshot = false)`. Adding the native SDK's `Modifier.txSensitive()` blacked it out in a second live reporter capture. The iOS Compose probe uses `onGloballyPositioned` to pass its tile bounds to a transparent marked `UIView`; the reporter editor then showed a black rectangle at that location. Both results cover only fixed sample scenes. A customer integration needs automatic registration and fail-closed handling of missing or invalid geometry.

Build inputs: Kotlin 2.4.20, AGP 8.7.2, Compose Multiplatform 1.13.0-alpha01, Gradle 8.10.2, Xcode 27.0, iOS 27.0 simulator, Android API 36 emulator. Android used disposable `0.9.0-DEV` SDK AARs from `/tmp/everframe-flutter-android-m2` with loopback ingest `http://10.0.2.2:8937`; iOS hosts used a fake validator-shaped key and `http://127.0.0.1:8937`. No development backend was running.

The focused commands were `jvmTest compileDebugKotlinAndroid linkDebugFrameworkIosSimulatorArm64` for the KMP module, `assembleDebug` for the Android host, `linkDebugFrameworkIosSimulatorArm64` for the Compose host, and `xcodebuild test` for both iOS schemes. The Compose iOS sample temporarily supplies the installed Xcode Swift library search path because a cached Compose library referenced removed Xcode 26.4; that hard-coded link option is sample-only. XcodeGen source and the generated project are in `examples/kmp-ios-probes`; build the two KMP frameworks before opening the Xcode project.

Reports went only to a local fake ingest. Android replay uses bounded, masked PNG frames and the `everframe-vtree-v1` attachment path. It requires a registered sensitive marker throughout sampling; missing geometry clears the replay ring. iOS replay used the existing native video path, which is not required for the eventual KMP design. Screenshots and payloads inspected for this dry run live under `/tmp` and were not committed. Handled errors, HTTP context, offline restart/retry, native-view mixtures beyond this sample, exact `everframe-kmp` identity, and real dashboard appearance remain required before support can be claimed.
