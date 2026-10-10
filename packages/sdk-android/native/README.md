<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Optional Android native crash capture

The `native-crash` Android library supplies the optional signal producer for the
public core SDK. Core-only applications do not load or package these binaries.

```kotlin
implementation("dev.everframe:core:<version>")
implementation("dev.everframe:native-crash:<version>")
```

The handler runs from the installed native library directory, so the
application module must extract native libraries. A library cannot set this
for the app; the setting covers both APKs and App Bundles:

```kotlin
android {
    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }
}
```

With the default packaging for `minSdk` 23 and later, the libraries stay inside
the APK. Setup then stops before arming, readiness stays false, and an
`Everframe` logcat warning names `native-libraries-not-extracted`. Extracted
libraries that lack the handler for the running ABI report
`native-handler-missing` instead.

`Everframe.start(context, config)` arms the collector when this module is in the
app and `capture.crash` is on (the default); no other call is needed.
`Everframe.isNativeCrashCaptureReady()` reports successful asynchronous setup. A
replacement start pauses capture and re-arms it; a start with
`capture.crash = false` leaves it paused and keeps recorded evidence. `kill()`
erases native evidence that has not entered the ordinary encrypted report
outbox. That erasure runs on the calling thread: it can wait for an in-progress
setup and performs local storage IO and handler IPC. Reports already admitted to
that outbox follow its existing delivery and revocation policy.

This path supports API26–30 in the default application process. It grants
exclusive ownership of the native fatal-signal handlers: another app-bundled
collector causes activation to fail closed. The platform WebView's in-process
crash handler restores the previous handler and re-raises, so it is accepted
whether WebView initializes before or after the collector arms. While WebView's handler
is the most recent one, a collector installed before it cannot be seen and is
not refused. API24–25 are unsupported. API31+ uses OS exit information.
Absent optional binaries or a failed setup leave readiness false.

On API30, OS exit capture also recovers native exits. With this module present, a fault this handler recorded is reported once, with its fault
frame, and the OS exit adds no second crash; a fault it did not record is still
reported from the OS exit. For that check the module keeps an encrypted receipt
per delivered report that holds only the ended launch's identifier (at most
eight, expiring after 14 days). A receipt that cannot be stored can let the OS
exit report the same fault again.

Every report carries the signal, signal code, ABI and crashing thread. A fault
PC inside a loaded module adds one partial fault-PC frame: the module name, the
relative address and, when the module has one, its ELF build ID. A fault outside
every loaded module (a call through a null function pointer, or into anonymous
or JIT memory), or inside a module whose name contains a control character or
backslash, produces a report without frames. It does not claim a full unwound
stack or arbitrary-thread stack-overflow support. Exact matching ELF debug
information is required for source lines; a frame without a build ID stays
unsymbolicated. Recovery occurs at the next start after a process death;
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

Qualified build host: macOS ARM64, Python3.12+, the stable Android NDK r29
(29.0.14206865), make, Perl and SDK CMake ninja. Source archive hashes or Git
trees are pinned in `source-pins.json`; toolchain and OpenSSL inputs in
`toolchain-pins.json`. The builder requires the exact NDK revision and release
name, so a pre-release NDK with the same base revision is refused.

```sh
python3 native/build.py --workspace /absolute/owned-build \
  --ndk "$ANDROID_HOME/ndk/29.0.14206865" \
  --ninja "$ANDROID_HOME/cmake/3.22.1/bin/ninja" --abi all
cd android
./gradlew :everframe-native-crash:assembleRelease \
  -PeverframeNativeBuildDir=/absolute/owned-build
```

Run from `packages/sdk-android` before changing into `android`. The builder
records source and output SHA256 values and ELF build IDs, replacing earlier
outputs. Packaging verifies them again and refuses any other file in the
workspace `jniLibs`. Its checks are explicit, so they also run under `python3 -O`;
`python3 -I -B -m unittest discover -s native/tests` covers the fail-closed
paths without an NDK or network access. A single-ABI local build uses
`--abi arm64-v8a` plus Gradle `-PeverframeNativeAbis=arm64-v8a`; publication
rejects partial-ABI builds. A workspace can be reused: changed native sources
are rebuilt by content, while a changed builder, pin file or NDK path discards
the earlier Crashpad and OpenSSL objects and keeps only verified downloads.
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
