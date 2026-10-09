<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Everframe Android SDK

Native Android SDK workspace for Everframe reporting, session evidence, and
playback diagnostics.

The implementation is a Gradle multi-module project under [`android`](android).
The [`package.json`](package.json) at this level is only a workspace marker: it
lets the repository-wide pnpm and Turbo commands invoke Gradle consistently.
Android applications consume the published `dev.everframe` Maven artifacts,
not the pnpm package.

See the [complete Android integration guide](android/README.md) for Maven
configuration, initialization, triggers, privacy controls, API usage, and
platform limitations.

## Modules

| Gradle module | Maven artifact | Purpose |
| --- | --- | --- |
| `everframe-protocol` | `dev.everframe:protocol` | Generated wire-protocol models |
| `everframe-core` | `dev.everframe:core` | Capture, envelope, transport, outbox, and SDK lifecycle |
| `everframe-reporter-ui` | `dev.everframe:reporter-ui` | Compose reporter and annotation UI |
| `everframe-media3` | `dev.everframe:media3` | Media3 and ExoPlayer session-vitals integration |
| `everframe-gradle-plugin` | `dev.everframe:gradle-plugin` | Build integration and optimized-build metadata |

## Development

From the repository root, use the workspace scripts:

```sh
pnpm --filter @everframe/sdk-android build
pnpm --filter @everframe/sdk-android test
pnpm --filter @everframe/sdk-android publish:maven-local
```

Or run Gradle directly:

```sh
cd packages/sdk-android/android
./gradlew test assembleRelease
./gradlew publishAllToMavenLocal
```

The repository CI additionally verifies that every published Android module
contains real source and API-documentation artifacts.

## Examples

- [`examples/android-compose`](../../examples/android-compose) demonstrates a
  native Jetpack Compose host.
- [`examples/android-views`](../../examples/android-views) demonstrates the
  Android Views integration.

## Error cause chains

Native handled and uncaught `Throwable` capture includes a generic `causeChain`
alongside the existing JVM metadata. Each cause is read once; generic fitting
does not reduce the independently retained JVM metadata or change its R8 mapping
identity. Suppressed-exception graphs are not traversed as linear causes.

Chains retain at most 8 causes, 32 frames per cause, and 65,536 serialized UTF-8
bytes after redaction. Cycles, unreadable fields and discarded data are marked
with truncation flags. Causes do not change the outer error's grouping key.

### OS process-exit diagnostics (opt in)

After `Everframe.start`, call `Everframe.setProcessExitDiagnosticsEnabled(true)` to recover previous-process diagnostics on Android11/API30 and later. `isProcessExitDiagnosticsReady()` becomes true after the encrypted context and opaque OS token are registered. This mode includes native crash recovery and replaces native-only mode. Call only one switch per start. A later call selects the other mode without erasing previous-process evidence, but native-only recovery drops unadmitted non-native exits, so diagnostics selected after native-only recovery ran can miss them. Native-only mode needs API31: on API30, `setNativeCrashRecoveryEnabled(true)` releases an active diagnostics mode and erases its unadmitted evidence, and otherwise does nothing. Either recovery switch set to false disables the shared owner and erases unadmitted evidence. The host grants exclusive use of `ActivityManager.setProcessStateSummary`; do not enable another writer concurrently.

ANR terminations use the OS exit reason, not a missing heartbeat. System low-memory exits, user-requested stops and unknown reasons remain separate diagnostics, not crashes. A recovered live stall produces no report in this mode. An ANR trace attached to an unrelated exit is never used to relabel that exit. API30 native exits have metadata only; native tombstones require API31. Reports are anonymous and preserve the previous process's destination and release; they do not acquire the new process's user, session or web exposure.

On API30, the optional `dev.everframe:native-crash` module's `setNativeSignalCaptureEnabled(true)` also records native faults. With both enabled, a fault its handler recorded is reported once, by the signal path with its fault frame: exit-info recovery leaves that exit undecided while the record awaits the next signal opt-in, then sends no second, frameless crash for it. A native exit the handler did not record is still reported from the OS exit.

Recovery reads at most32 historical records, matches the exact token/PID/process, and retains contexts for at most14 days in bounded encrypted journals (8 entries/2MiB each). ANR traces are read off the main thread, capped at256KiB and64 main-thread frames; only method names, source basenames and line numbers are retained. Raw trace text, OS descriptions and trace attachments are excluded. Missing, malformed, unsupported or truncated evidence is explicit. No main-thread watchdog is installed, and this mode is disabled by default. Readiness can remain false when consent is absent, the OS/API is unsupported, or bounded durable storage cannot admit a context.

Diagnostic cause names preserve OS reason categories, not proof of user intent. Before Android 14/API34, reason10 (`REASON_USER_REQUESTED`) also covered app updates and component-state changes. Consumers should qualify that category using the retained API level/reason; reason11 means the OS user was stopped. See [ApplicationExitInfo](https://developer.android.com/reference/android/app/ApplicationExitInfo#REASON_USER_REQUESTED).

### Recovered main-thread delays (opt in)

After each `Everframe.start`, call `Everframe.setRecoveredStallObserverEnabled(true)` to observe recovered main-looper probe delays on Android/API26 and later. API24–25 remain unavailable in this mode: the envelope/timestamp path requires platform `java.time`, and this API does not assume host library desugaring. The observer is disabled by default and requires capture consent and `capture.crash`. `Everframe.isRecoveredStallObserverReady()` reports that its lifecycle observer is installed; it does not promise an eligible sample or complete coverage.

This separate mode reports only after the queued probe executes again. A delay of 5–60 seconds is an **SDK probe observation**, not a confirmed OS ANR, task duration, crash, or fatal outcome. Missing recovery produces no observation. No stack, user, session, web exposure, or native exposure is attached. OS exit recovery remains independently opt-in and owns its existing OS state-summary token; this observer never writes that token.

Sampling runs once per second only while the process lifecycle is foreground. Every probe and admission also checks foreground process importance, screen interactivity, and debugger state. A watchdog scheduling gap over 2.5 seconds, sleep/clock inconsistency, or loss of eligibility discards the pending sample. Queue barriers and scheduling can affect probe latency; this is not a diagnosis of the cause. No background sampling timer runs.

At most four observations are admitted per OS process, separated by at least 60 seconds, including across SDK restarts or repeated opt-in. Each anonymous record is limited to 64 KiB and uses the ordinary bounded encrypted outbox with frozen release and destination. Disabling removes callbacks and cancels pending/new admission; already admitted immutable records retain normal retry authority, including after relaunch. `Everframe.kill()` applies the SDK's global outbox erasure policy. No signal handler or persisted heartbeat is installed.

## License

MIT
