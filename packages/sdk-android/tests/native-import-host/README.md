<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Durable native-record import qualification

This host exercises the SDK's internal encrypted native-record importer after an
actual fatal fault and process relaunch. It is a minified, nondebuggable Android
application consuming the **SDK Debug variant**. It does not qualify the published
Release SDK, enable a production collector, or add a supported SDK API.

The fixture first starts the SDK with an original synthetic key/release, persists
an anonymous envelope and exported record key in Android Keystore-backed encrypted
storage, and provisions the separately qualified healthy handler over inherited
file descriptors. On relaunch it starts the SDK with a replacement key/release.
Recovery must preserve the original envelope, destination, report UUID and retry
bytes. The native evidence contains one partial frame and a handler snapshot time;
it is not an OS exit record or an exact signal-delivery timestamp.

Build the native fixture under `core/src/test/cpp/api24-collector/android` first.
With the four ABI library directories in `$QUALIFICATION_JNI_LIBS`, from
`packages/sdk-android/android` run:

```sh
./gradlew :native-import-host:assembleQualification \
  -PnativeImportQualification=true \
  -PqualificationJniLibs="$QUALIFICATION_JNI_LIBS" \
  -PproofApplicationId=dev.everframe.nativequalification.importproof \
  --max-workers=2
```

Explicit intent modes are `arm`, `arm-revoke`, `recover`, `retry`, `prepare-only`,
`erase` and `erase-owner-only`. The last deliberately erases only the capsule store
to model interruption before prepared receipt erasure. A later process must not
admit that orphan receipt. Java helpers access internal Kotlin types solely within
this qualification application. Synthetic result JSON is written for owned device
readback; it is not production telemetry. Keep network traffic blocked for the
qualification UID and preserve ordinary app UID/SELinux execution evidence.

The importer supplies its own authorization gate to the admission callback. The
callback must pass that exact gate to the durable outbox write and report success
only after the write commits. Capsule and prepared queues are bounded by their
caller-configured encrypted stores; eligibility is fourteen days and expiration
is enforced on recovery. Arming adds one capsule per launch. Recovery retires the
capsule of an earlier launch that left no native record: only process death
followed by relaunch is supported, so that launch ended without a captured
fault. A record that exists but cannot be read keeps its capsule. A production
adapter must therefore recover on every launch and use one launch identifier
per process lifetime, or arming fails once the capsule store is full. This host
arms once per cleared install and never exercises repeated clean launches; that
rule is covered by JVM tests only. Native ciphertext directories are fixture-owned and
retained for evidence; a future production adapter still needs bounded cleanup.
No erasure timer runs while an application never executes. Temporary key byte
arrays are cleared, but JVM/cipher memory zeroization is not claimed.

API24/25 are unsupported. Installed evidence covers only the specifically recorded
API26/30 ARM64 emulator runs; remaining ABIs have compilation evidence. Arbitrary
threads, alternate-stack safety, coexistence, physical devices, automatic SDK
lifecycle integration and server-side deduplication are not qualified here. Stable
report identity supports at-least-once delivery; it is not a claim of one network
attempt. This host never opts into the separate API31+ OS recovery path.
