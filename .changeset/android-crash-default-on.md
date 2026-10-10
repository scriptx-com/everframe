---
"@everframe/sdk-android": minor
"@everframe/react-native": minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Android crash capture is now on by default with `capture.crash`. `Everframe.start` captures JVM exceptions, native crashes (OS exit records on API 30+, with tombstone frames on API 31+) and ANRs on API 30+, without any other call. Only native crash and ANR exits are reported from OS exit records; low-memory kills, user stops, JVM crash exits and other reasons are not sent. The optional `dev.everframe:native-crash` module (not yet on Maven Central) adds a fault frame for native faults on API 26–30. Native and OS exit capture run in the default app process. `setProcessExitDiagnosticsEnabled`, `setNativeCrashRecoveryEnabled`, `setNativeSignalCaptureEnabled` and their three readiness getters are removed; `Everframe.isNativeCrashCaptureReady()` replaces the getters. Start with `CaptureConfig(crash = false)` to turn capture off, or call `kill()`. The SDK now owns `ActivityManager.setProcessStateSummary` while capture is on and logs `process-state-summary-conflict` when another writer replaced it; a writer that runs before the SDK is overwritten. Flutter apps on Android get the same capture, because the Flutter bridge starts the native SDK with `capture.crash = true`. In React Native, `crashReporting: { disabled: true }` now also turns off native crash and ANR capture on Android and iOS.
