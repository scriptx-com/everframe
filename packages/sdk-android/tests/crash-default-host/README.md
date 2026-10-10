<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Installed default crash capture acceptance app

A minified, nondebuggable Release app consuming only `dev.everframe:core`. `ProofApplication.onCreate` calls `Everframe.start` with the default configuration and nothing else; `ProofActivity` waits for `Everframe.isNativeCrashCaptureReady()`, logs its state under the `EverframeCrashDefault` tag, then performs the failure named by the string extra `crash`: `jvm` (uncaught exception on the main thread), `segv` (address-zero store in `libcrash_default_fault.so`), `anr` (blocks the main looper for 120 seconds; send a real input event, then close the app from the OS dialog), `oom` (fills the Java heap on the main thread until `OutOfMemoryError`), `lmk` (allocates incompressible native memory on a background thread, in the foreground, until the OS ends the process) or `none`.

From the Android Gradle root:

    ./gradlew :crash-default-host:assembleRelease -PcrashDefaultAcceptance=true \
      -PcrashDefaultCa=/absolute/local-test-ca.pem -PcrashDefaultSdkKey=evf_live_<32 letters or digits>

The key must be synthetic and issued by your local test service; never use a production key. The app trusts the supplied CA only for `everframe.dev`, the unmodified Release SDK endpoint, so it needs an owned emulator whose HTTP proxy points at a local CONNECT/TLS proxy. Only arm64-v8a is packaged; it qualifies only the emulator ABI/OS it runs on.
