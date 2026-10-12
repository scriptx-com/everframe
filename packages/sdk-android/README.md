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

See the [crash-reporting support matrix](../../docs/crash-reporting-support.md)
for exact tested paths, unsupported combinations and remaining qualification.

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

### Crash capture (on by default)

`Everframe.start` arms crash capture whenever `capture.crash` is `true`, which is the default. No other call is needed. The SDK picks the mechanism from the API level:

| API | JVM exceptions (including `OutOfMemoryError`) | Native crashes | ANRs | Low-memory kills while the user could see or hear the app |
| --- | --- | --- | --- | --- |
| 24–25 | yes | — | — | — |
| 26–29 | yes | with the optional `dev.everframe:native-crash` module (not yet on Maven Central) | — | — |
| 30 | yes | OS exit record without frames; with `native-crash`, the fault frame, reported once | yes | yes |
| 31+ | yes | OS exit record with tombstone frames | yes | yes |

Native and OS exit capture run in the default app process only; other processes report JVM exceptions. Capture begins once the asynchronous arm after `start()` completes; a native crash or ANR before that is not reported. `Everframe.isNativeCrashCaptureReady()` becomes true once every mechanism selected for the current start has armed. It stays false where no native mechanism exists, while setup runs, and when a mechanism refused (another app-bundled native crash collector, or unextracted native libraries).

To turn capture off, start with `CaptureConfig(crash = false)`: capture stops at once, and unadmitted evidence from earlier processes is kept but not sent. `capture.crash = false` also disables `captureException`. `Everframe.kill()` stops the SDK and erases unadmitted crash evidence.

While `capture.crash` is on, the SDK owns `ActivityManager.setProcessStateSummary` in the default process; do not call it. An exit whose summary another writer replaced is not reported, and is never misattributed. When exit history shows such a summary, the SDK logs an `Everframe` warning naming `process-state-summary-conflict`. A writer that always runs before the SDK is overwritten silently and loses its own use of the slot.

ANR terminations use the OS exit reason, not a missing heartbeat. Only native crash, ANR and user-facing low-memory exits are reported. A low-memory kill (`REASON_LOW_MEMORY`) is reported when the app's importance at death was foreground, foreground service (background audio or video playback) or visible (which includes picture-in-picture playback); it becomes one fatal crash, "Low memory kill", with that importance, the PSS/RSS the OS recorded (when it recorded any) and its exit description. Perceptible (230) is not reported: expedited jobs and backup agents report it for work the user never saw. A kill has no stack, so every such kill of one app shares one issue across releases; its fingerprint includes the app ID, so apps in one project never share it. When the JVM handler already reported the process's crash (a Java `OutOfMemoryError` that lmkd finished), the kill is not a second issue. Background and cached reclaims, user-requested stops, JVM crash exits (the uncaught-exception handler already reports those) and other reasons are not sent. Low-memory kills are told apart only where the OS records them as `REASON_LOW_MEMORY`: when `ActivityManager.isLowMemoryKillReportSupported()` is false, or when the kernel OOM killer ends the app before lmkd does (seen on the API 31 Android TV emulator, which records `SIGNALED`), the death is not reported; the SDK never guesses from SIGKILL. Below API 30 low-memory kills are not detected. A recovered live stall produces no report. An ANR trace attached to an unrelated exit is never used to relabel that exit. API30 native exits have metadata only; native tombstones require API31. Reports are anonymous and preserve the previous process's destination and release; they do not acquire the new process's user, session or web exposure.

On API30 with `native-crash`, a fault its handler recorded is reported once, by the signal path with its fault frame; the OS exit adds no second, frameless crash. A record that no later start can deliver (unreadable) expires once the clock is more than 14 days away from its creation, and its exit is not reported as a crash. A native exit the handler did not record is still reported from the OS exit.

Recovery reads at most32 historical records and matches the exact token/PID/process, never wall-clock times, so a clock that jumps cannot hide a crash. A matched crash is reported however far the clock moved; if the exit's timestamp reads later than the relaunch's clock (a clock that moved back), it is collected and submitted at the exit's own time. A context with no matching exit expires once the clock is more than 14 days away from its creation in either direction. The bounded encrypted journals hold 8 entries/2MiB each; when the context journal is full, arming frees only the slots it needs: contexts that can no longer be reported (no single matching exit record) first, then reportable ones, each oldest first by arming order (not by wall clock), never the newest held context; it logs an `Everframe` warning. ANR traces are read off the main thread, capped at256KiB and64 main-thread frames; only method names, source basenames and line numbers are retained. Raw trace text, OS descriptions and trace attachments are excluded. Missing, malformed, unsupported or truncated evidence is explicit. No main-thread watchdog is installed. Readiness can remain false when the OS/API is unsupported or bounded durable storage cannot admit a context.

### Recovered main-thread delays (opt in)

After each `Everframe.start`, call `Everframe.setRecoveredStallObserverEnabled(true)` to observe recovered main-looper probe delays on Android/API26 and later. API24–25 remain unavailable in this mode: the envelope/timestamp path requires platform `java.time`, and this API does not assume host library desugaring. The observer is disabled by default and requires capture consent and `capture.crash`. `Everframe.isRecoveredStallObserverReady()` reports that its lifecycle observer is installed; it does not promise an eligible sample or complete coverage.

This separate mode reports only after the queued probe executes again. A delay of 5–60 seconds is an **SDK probe observation**, not a confirmed OS ANR, task duration, crash, or fatal outcome. Missing recovery produces no observation. No stack, user, session, web exposure, or native exposure is attached. OS exit capture is on with `capture.crash` and owns the OS state-summary token; this observer never writes that token.

Sampling runs once per second only while the process lifecycle is foreground. Every probe and admission also checks foreground process importance, screen interactivity, and debugger state. A watchdog scheduling gap over 2.5 seconds, sleep/clock inconsistency, or loss of eligibility discards the pending sample. Queue barriers and scheduling can affect probe latency; this is not a diagnosis of the cause. No background sampling timer runs.

At most four observations are admitted per OS process, separated by at least 60 seconds, including across SDK restarts or repeated opt-in. Each anonymous record is limited to 64 KiB and uses the ordinary bounded encrypted outbox with frozen release and destination. Disabling removes callbacks and cancels pending/new admission; already admitted immutable records retain normal retry authority, including after relaunch. `Everframe.kill()` applies the SDK's global outbox erasure policy. No signal handler or persisted heartbeat is installed.

## License

MIT
