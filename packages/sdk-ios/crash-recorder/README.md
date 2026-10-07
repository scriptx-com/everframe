<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Native crash recorder component

An isolated recording foundation for future Everframe iOS/tvOS native crash
integration. This standalone SwiftPM package is **not yet wired into the
Everframe SDK's startup, recovery, upload or published XCFrameworks**.

The `EverframeCrashRecorder` library exposes five C integration functions through
`EverframeCrashRecorder.h`: install, set enabled, read enabled, set context
identifier, and version.
It builds for iOS15/tvOS15; macOS14 is a qualification host. The vendor headers
are private to the Clang target. The package uses no unsafe compiler flags.

A healthy caller creates a fresh UUID run directory in its private application
storage, mode0700, resolves its canonical absolute path, and reserves it for this
process. `EFCRInstall(path)` rejects missing, relative, symlinked, noncanonical,
nonempty, permissive and oversized directories. Do not replace or rename the
reserved directory concurrently. Validation failures permit a corrected attempt;
entering the vendor installer is terminal, even on failure. A successful install
returns with recording disabled. Call `EFCRSetEnabled(true)` explicitly.

Installation and enable/disable calls are serialized and run only on healthy
threads. Disabling closes a lock-free report gate before changing monitors.
A fatal handler that already passed the gate may finish writing. Underlying
vendor tracker singletons can retain process-lifetime resources; disabled does
not mean every infrastructure object is destroyed. No custom allocation,
Foundation, locking, envelope construction or network work runs in the report gate.

The selected detectors cover Mach faults, fatal signals and uncaught Objective-C
exceptions, including tested Swift traps. Watchdog/termination/CPU reporting,
C++ interception, memory introspection, queue-name lookup, exception userInfo and console attachments
are not enabled. Required upstream infrastructure can still write sidecar context.

Raw reports remain local and can contain exception messages, stack/image addresses
and system details. The wrapper sets backup exclusion and mobile
complete-until-first-user-authentication protection on the run root; the patched
sidecar writer preserves that protection class. Children remain inside the0700
parent, without changing process-wide umask. Actual before-first-unlock and locked
physical-device behavior still needs qualification. The component neither uploads
nor deletes records. It limits the per-run store to one report; cross-run byte and
retention limits, interrupted-record recovery, original-run attribution, encrypted
outbox promotion and native symbolication belong to subsequent SDK integration.

## Source provenance

[KSCrash2.6.0](https://github.com/kstenerud/KSCrash/releases/tag/2.6.0) is pinned
at`3f77f379c2db001e0c261c2a51b7e2b115d31f91`. See THIRD_PARTY_NOTICES.md and LICENSES
for MIT, BSD3 and APSL terms. Original notices and dated modifications are retained. The three original privacy
manifests remain in the vendor source; a deterministic union is processed into the
component resource-bundle root for iOS/tvOS privacy aggregation.
`vendor-lock.json` records original and packaged hashes for197 files.

Every translation unit includes the fixed private namespace prelude. The owned
overlay also names missing upstream C exports, protocol identities and the weak
C++ throw interposer. The latter prevents this component from interposing the
application's throw ABI. This does not qualify arbitrary third-party crash reporters.

From this directory on macOS (Node and system `plutil`), with an exact unmodified upstream checkout available:

```sh
KSCRASH_CHECKOUT=/path/to/KSCrash node --test scripts/vendor.test.mjs
KSCRASH_CHECKOUT=/path/to/KSCrash node scripts/verify-vendor.mjs
node scripts/prepare-vendor.mjs /path/to/KSCrash /path/to/empty-output
swift build -c release --product EFCRProbe
```

Preparation refuses to overwrite existing vendor source. Verification without an
upstream checkout checks the packaged manifest and resource integrity. Supplying
`KSCRASH_CHECKOUT` additionally compares original files and deterministic transforms;
the manifest alone is not a cryptographic attestation.

`Tests/run-probes.py --binary /path/to/EFCRProbe --evidence /path/to/new-evidence`
runs25 fresh processes with25-second deadlines and child-only core-dump disabling.
The probes cover directory validation, initial disabled state, repeated/failed
installation, Swift/Objective-C/memory faults, disable/re-enable and rapid runs.
Every output and raw report is retained. `Tests/DualProbe/main.m` supports full-object
link and fatal-chain qualification alongside ordinary upstream recording objects.
Test helpers are not part of the library product.

## Immutable context handoff

`EFCRSetContextIdentifier` adds an integration-only ownership reference. After
successful installation, persist the corresponding context durably, keep recording
disabled, publish its canonical lowercase UUID, then enable only on success. NULL
clears the current reference. Publishing or clearing while enabled fails. Invalid
input and exhaustion leave the previous reference unchanged.

There are256 immutable process-lifetime slots; repeated identifiers reuse a slot.
The first admitted fatal event freezes its slot, including the no-context sentinel,
for that terminating process. The writer emits only that identifier under
`user.everframe_context_id`. Later publication cannot reassign it. The admitted slot
is never cleared, so a recrash report reuses it; this follows from the gate design
and is not separately probed. Standard reports from callers that publish nothing
keep their original shape. A recrash report, written if the crash handler itself
faults, now always contains a `user` object, empty unless an identifier was admitted.
No application context, configuration, identity object or arbitrary userInfo is
read in either callback. The SDK's automatic startup/recovery integration is still pending.

`Tests/context-probes.py --binary /path/to/EFCRProbe --evidence /path/to/new-evidence`
runs seven real fatal context cases. The admitted-A and empty-context cases
explicitly invoke the admission callback before publishing B, then trigger a real
fatal report; this exercises the boundary deterministically, not a scheduler race.

`Tests/gate-admission.sh /path/to/new-output` compiles `Tests/GateAdmission/main.c`
with the actual gate source and runs it. It disables recording and publishes another
identifier between the report callback's first atomic load and its admission, and
exits nonzero if that identifier is ever admitted. It needs no vendor build.
