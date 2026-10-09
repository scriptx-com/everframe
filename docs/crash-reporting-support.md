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
| React Native causes and React error boundary | Android/iOS optimized installed hosts, including encrypted retry/relaunch | Native transport in these rows uses Debug/local SDKs; physical-device and production-transport qualification remain open |
| RN automatic promise rejection | `react-native-tvos@0.85.3-0`, Hermes `250829098.0.10`, bytecode 98; Android API 35 arm64 emulator and iOS 26.5 arm64 simulator | Other versions, JSC, browser execution, tvOS and incompatible Promise hooks are unsupported by this observer; the broad RN peer range is not its support range |
| Android JVM exceptions | Handled/uncaught Throwable capture, bounded causes, exact R8 mapping | Suppressed-exception graphs are not linear causes; C/C++ signals require a separate collector |
| Android historical native exits | Opt-in OS recovery on API 31+, with installed API 35 arm64 SIGABRT/SIGSEGV evidence | Requires OS evidence and exact previous-process ownership; missing tombstones stay missing/raw |
| Android historical ANR/exit categories | Opt-in API 30+ OS exit diagnostics and bounded ANR trace projection | API 30 native exits carry metadata only; native tombstones need API 31. Hosts must grant exclusive process-state-summary ownership |
| Android recovered main-thread delay | Opt-in API 26+, foreground eligibility and bounded 5–60 second recovered observations | Not an OS-confirmed ANR or fatal crash. API 24/25 unsupported. Broad device false-positive and battery qualification remain open |
| Android signal collector Release lifecycle | [Draft #76](https://github.com/scriptx-com/everframe/pull/76): installed API 26/30 arm64 Release fault → relaunch → retry → exact ELF mapping | Separate prerequisite, not included merely by reading this document. API 24/25 unsupported; one-frame snapshot is not full unwinding. Other ABIs are compile-only; arbitrary-thread alternate stacks and collector coexistence are unqualified |
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
| Apple dSYM automation | Explicit selected binaries, UUID/CPU checks, private immutable upload/completeness gate and two optimized installed simulator builds | No automatic discovery of every archive/framework. [Draft #77](https://github.com/scriptx-com/everframe/pull/77) adds large-dSYM uploads; accepted size alone does not guarantee processing within runtime budgets |
| Android ELF automation | Exact build-ID/ABI selection, immutable upload/completeness and optimized artifacts | Four compiled ABIs are not four installed ABI results; unsupported/missing/wrong artifacts stay raw |

## Release health

[Reported launch sessions](release-health.md) and [fatal-count webhooks](release-health-alerts.md)
use explicitly observed starts and retained qualifying evidence. Supplied user IDs
are opt-in and their absence is not a distinct anonymous person. Missing outcomes
are unknown. Observed fractions and count thresholds do not establish population
crash-free rates, statistical regressions or healthy recovery.

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
