<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->
# Installed Android native crash fixture

This credential-free app deliberately terminates through optimized JNI faults. It requires Android API31+ for OS native tombstone recovery. Build the SDK Release Maven artifacts into an isolated local repository, then invoke the SDK Gradle wrapper against this directory with `-PeverframeMavenRepo=<absolute path>` and `-PeverframeVersion=<local version>` plus `:app:assembleRelease`. `proofApplicationId` can select a unique package on an owned emulator.

Start `.MainActivity` with string extras `mode` and `marker`. Modes: `abort`, `segv`, `recover`, `drain503`, `drain200`, `disabled`, `jvm`. Poll the per-marker file under application files/proof before checking process termination. A recovered envelope keeps the original report ID, destination and release. Repeated `recover` launches must not create another occurrence;503 retains bytes and200 consumes the outbox. `disabled` revokes the context before faulting. JVM mode exercises the existing uncaught-exception path.

The app has normal INTERNET permission. Before launching it, block IPv4 and IPv6 output for its unique UID on an owned rootable emulator; verify the rules and retain them until uninstalling the fixture. Omitting the permission makes Android DNS throw SecurityException on an OkHttp dispatcher, which is not an ordinary offline transport result. Its explicit public outbox drain and MultipartUploader fixture uses an application interceptor to retain real multipart bodies and return503/200 without network access; the SDK's compiled Release URL is asserted unchanged. This proves installed recovery and transport retry behavior, not remote API delivery. Use retained multipart/envelope artifacts for separately authenticated service integration qualification. No production credentials are needed or accepted by the build.

Exported raw tombstones are test-only local evidence. The production reader emits no stack memory, registers, logcat, command lines, abort text or full module paths. Do not upload raw tombstones as report attachments.

Keep the unstripped library from `app/build/intermediates/cxx/RelWithDebInfo/.../obj/<abi>/libnativeproof.so` for exact build-ID/source-line checks. The same APK contains all four Android ABI fixtures; running one emulator qualifies only that emulator's ABI/OS, not a physical matrix.
