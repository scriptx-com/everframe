<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Optional Android native crash capture

The `native-crash` Android library supplies the optional signal producer for the
public core SDK. Core-only applications do not load or package these binaries.

```kotlin
implementation("dev.everframe:core:<version>")
implementation("dev.everframe:native-crash:<version>")
```

After `Everframe.start(context, config)`, explicitly call
`Everframe.setNativeSignalCaptureEnabled(true)`. Read
`Everframe.isNativeSignalCaptureReady()` to observe successful asynchronous setup.
Call the opt-in again after every start. A replacement start pauses capture;
`setNativeSignalCaptureEnabled(false)` and `kill()` also erase native evidence
that has not entered the ordinary encrypted report outbox. That erasure runs on
the calling thread: it can wait for an in-progress setup and performs local
storage IO and handler IPC. Reports already admitted to that outbox follow its
existing delivery and revocation policy.

This path supports API26–30 in the default application process. It grants
exclusive ownership of the native fatal-signal handlers: another app-bundled
collector causes activation to fail closed. API24–25 are unsupported. API31+
continues to use `setNativeCrashRecoveryEnabled(true)` and OS exit information.
Absent optional binaries or a failed setup leave readiness false.

On API30, `setProcessExitDiagnosticsEnabled(true)` also recovers native exits.
With both enabled, a fault this handler recorded is reported once, with its fault
frame, and the OS exit adds no second crash; a fault it did not record is still
reported from the OS exit. For that check the module keeps an encrypted receipt
per delivered report that holds only the ended launch's identifier (at most
eight, expiring after 14 days).

The report contains one partial fault-PC frame, signal, module, ELF build ID and
relative address. It does not claim a full unwound stack or arbitrary-thread
stack-overflow support. Exact matching ELF debug information is required for
source lines. Recovery occurs at the next explicit opt-in after a process death;
reports preserve the original application version/build and destination, are
anonymous, and do not fabricate release-health sessions.

Native capture writes a bounded AES-GCM encrypted record. Its key and frozen
report context live in Android Keystore-backed capsule storage. Capsule and
prepared stores are each bounded to eight entries and two MiB; native records
are bounded to 4096 bytes. Authenticated reports expire after 14 days from capture;
prepared retries have a 14-day recovery window. Backward clock changes do not
count as elapsed time. API26/30 ARM64 are the installed qualification targets;
other packaged ABIs require their own device qualification.

## Reproducible build

Qualified build host: macOS ARM64, Python3.12+, Android NDK29.0.14033849, make,
Perl and SDK CMake ninja. Source archive hashes or Git trees are pinned in
`source-pins.json`; toolchain and OpenSSL inputs in `toolchain-pins.json`.

```sh
python3 native/build.py --workspace /absolute/owned-build \
  --ndk "$ANDROID_HOME/ndk/29.0.14033849" \
  --ninja "$ANDROID_HOME/cmake/3.22.1/bin/ninja" --abi all
cd android
./gradlew :everframe-native-crash:assembleRelease \
  -PeverframeNativeBuildDir=/absolute/owned-build
```

Run from `packages/sdk-android` before changing into `android`. The builder
records source and output SHA256 values and ELF build IDs. Packaging verifies
them again. A single-ABI local build uses `--abi arm64-v8a` plus Gradle
`-PeverframeNativeAbis=arm64-v8a`; publication rejects partial-ABI builds.
Third-party license texts ship as AAR assets. No downloaded or generated native
binary is checked into this repository.

Ordinary Android builds and Maven bundles exclude this module. Supplying
`-PeverframeNativeBuildDir` explicitly includes it and requires valid artifacts;
a missing or stale workspace fails the build. To prepare a complete unsigned
mobile bundle including native capture, run from the repository root:

```sh
node scripts/build-mobile-maven-bundle.mjs --prepare \
  --native-workspace /absolute/owned-build
```

Without `--native-workspace`, the established bundle contents are unchanged.
The native-enabled bundle requires all four ABIs and verifies the bridge,
consumer keep rules and third-party licenses. For direct Maven-local checks,
set `EVERFRAME_VERIFY_NATIVE_CRASH=1` when running
`scripts/verify-android-publication.sh <version>`.
