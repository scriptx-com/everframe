<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->
# Crash-reporting support and qualification

This is the source-tree qualification boundary as of October 9, 2026. It is not
an SDK release announcement. An implementation, a compiled target, an installed
emulator test and a physical-device test are different kinds of evidence. A
platform listed below has only the evidence stated in its row.

## Capture and diagnostics

| Path | Implemented and exercised | Boundary |
| --- | --- | --- |
| Web / React errors and cause chains | Browser capture, durable delivery and exact uploaded-map processing; nested causes remain separate from the outer issue | Framework/runtime combinations require their own qualification; this is not a blanket browser support guarantee |
| React Native causes and React error boundary | Optimized apps for one pinned RN/Expo/Hermes host, installed on an Android API 35 arm64 emulator and an iOS 26.5 arm64 simulator, including encrypted retry/relaunch | Native transport in these rows uses Debug/local SDKs; other RN versions, physical-device and production-transport qualification remain open |
| RN automatic promise rejection | `react-native-tvos@0.85.3-0`, Hermes `250829098.0.10`, bytecode 98; Android API 35 arm64 emulator and iOS 26.5 arm64 simulator | Other versions, JSC, browser execution, tvOS and incompatible Promise hooks are unsupported by this observer; the broad RN peer range is not its support range |
| Android JVM exceptions | Handled/uncaught Throwable capture, bounded causes, exact R8 mapping | Suppressed-exception graphs are not linear causes; C/C++ signals require a separate collector |
| Android historical native exits | On by default with `capture.crash` in the default process: tombstone frames on API 31+, exit metadata only on API 30. Installed: SIGABRT/SIGSEGV on an API 35 arm64 emulator; SIGSEGV on API 35, API 31 Android TV and API 30 arm64 emulators from the default start alone | Requires OS evidence and exact previous-process ownership; missing tombstones stay missing/raw |
| Android historical ANR/exit categories | On by default with `capture.crash` in the default process: bounded ANR trace projection, API 30+. Only native crash and ANR exits are reported; low-memory kills, user stops, JVM crash exits and other reasons are not sent. Installed: OS-terminated ANRs recovered with main-thread frames on API 35, API 31 Android TV and API 30 arm64 emulators | API 30 native exits carry metadata only; native tombstones need API 31. Capture begins once the asynchronous arm after `start()` completes; a crash or ANR before that is not reported. The SDK owns the process-state summary; exits another writer overwrote are not reported and are logged as `process-state-summary-conflict`. A writer that always runs before the SDK is overwritten silently |
| Android recovered main-thread delay | Opt-in foreground eligibility and bounded 5–60 second recovered observations, supported on API 26+. Installed: one API 35 arm64 emulator | Not an OS-confirmed ANR or fatal crash. The API 26 floor is unit-tested only; API 24/25 unsupported. Broad device false-positive and battery qualification remain open |
| Android default crash capture | Fresh core-only Release app calling only `Everframe.start`: JVM crash, native SIGSEGV and OS-declared ANR delivered over HTTPS, installed on an API 35 arm64 phone emulator and an API 31 arm64 Android TV emulator (native frames from tombstones, symbolicated to the authored line), and on an API 30 arm64 phone emulator (native exit metadata only) | 32-bit ARM, physical devices and the API 26–30 signal collector in this default path are unqualified; JVM frames were not retraced in this run |
| Android signal collector Release lifecycle | Optional `dev.everframe:native-crash` module, armed by `start()` when present; it arms only on API 26–30 in the default app process (API 31+ uses the OS exit recovery above). Release fault → relaunch → retry → exact ELF mapping, installed on API 26 and API 30 arm64 emulators | API 24/25 unsupported; one-frame snapshot is not full unwinding. Other ABIs are compile-only; arbitrary-thread alternate stacks are unqualified. Another app-bundled crash collector makes activation fail closed; a collector installed before WebView's crash handler is not detected or refused |
| Apple native crash capture | Normal SDK startup, supported Swift/Objective-C/memory faults and relaunch recovery in an installed iOS Release simulator | Capture begins after durable context setup. Verified identity and continuously refreshed logs/breadcrumbs/replay are excluded. Physical lock/protection, stack overflow and broader OS/compiler checks remain open |
| tvOS native crash capture | Target compilation | Installed signal-path qualification remains open. The recorder has no tvOS Mach detector or alternate signal stack; stack-overflow capture is unsupported |
| Apple MetricKit | Opt-in iOS collector, synthetic receipt/retry/erasure checks and target compilation | Physical OS-produced hang/watchdog/memory-exit receipt delivery is unqualified. tvOS/macOS collectors are unavailable. Aggregate periods cannot be assigned to exact sessions |

The Apple collector admits only reporting intervals wholly inside the current
process's uninterrupted opt-in window and matching native version/build. Delayed
cross-launch intervals are rejected. Useful nonzero aggregate exit coverage is
therefore unproven; enabling the collector does not promise all OS diagnostics.
Apple also distinguishes daily metric reports from immediate diagnostic reports
on iOS 15+: see [MetricKit](https://developer.apple.com/documentation/metrickit).
OS delivery behavior does not establish that a report passes SDK ownership checks.

## Build and artifact identity

| Path | Evidence | Boundary |
| --- | --- | --- |
| Native versus loaded JavaScript build | Separate immutable identities retained through capture and retries | Native app version alone never identifies a loaded OTA bundle |
| Expo Updates Android | Optimized emulator embedded A → update B → cached B after service 503 → rollback A; queued B delivered under A with frozen identity | Cold-start captures; in-place runtime reload, whole-device offline, iOS and provider-hosted/signed production OTA are unqualified. Other OTA providers are unsupported integrations |
| Apple dSYM automation | Explicit selected binaries, UUID/CPU checks, private immutable upload/completeness gate and two optimized installed simulator builds | No automatic discovery of every archive/framework. Upload size is limited by the protocol's `DSYM_MAX_BYTES`; dSYMs above 64 MiB need the large-dSYM support in [#77](https://github.com/scriptx-com/everframe/pull/77). Accepted size alone does not guarantee processing within runtime budgets |
| Android ELF automation | Exact build-ID/ABI selection, immutable upload/completeness and optimized artifacts | Four compiled ABIs are not four installed ABI results; unsupported/missing/wrong artifacts stay raw |

## Release health

[Reported launch sessions](release-health.md), [fatal-count webhooks](release-health-alerts.md)
and [foreground crash-free target webhooks](release-health-rate-alerts.md) use
explicitly observed starts and retained qualifying evidence. Supplied user IDs
are opt-in and their absence is not a distinct anonymous person. Missing outcomes
are unknown; target alerts count them as healthy, so they fire only when the
target is missed even in that best case. Observed fractions, count thresholds and
target alerts do not establish population crash-free rates, statistical
regressions or healthy recovery.

## Promotion criteria

A production support claim needs the exact installed SDK/build/OS/ABI/runtime
combination to pass capture, offline/relaunch/retry, correct artifact mapping,
privacy/erasure and collector-coexistence checks. Physical-device overhead needs
baseline measurements and agreed startup/CPU/memory/disk/battery budgets.
Production runtime, load and rollout/rollback checks are additional gates.
Unsupported combinations remain excluded; unqualified combinations remain
unverified until their own evidence exists.

See the platform-specific configuration and limits in the
[Android](../packages/sdk-android/README.md), [Apple](../packages/sdk-ios/README.md)
and [React Native](../packages/sdk-react-native/README.md) guides.
