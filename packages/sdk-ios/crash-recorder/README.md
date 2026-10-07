<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Native crash recorder component

An isolated recording foundation for future Everframe iOS/tvOS native crash
integration. This standalone SwiftPM package is **not yet wired into the
Everframe SDK's startup, recovery, upload or published XCFrameworks**.

The `EverframeCrashRecorder` library exposes four C integration functions through
`EverframeCrashRecorder.h`: install, set enabled, read enabled, and version.
It builds for iOS15/tvOS15; macOS14 is a qualification host. The vendor headers
are private to the Clang target. The package uses no unsafe compiler flags.

A healthy caller creates a fresh UUID run directory in its private application
storage, mode0700, resolves its canonical absolute path, and reserves it for this
process. Canonical means realpath(3) output, or the same path without the `/private`
prefix, which is how Foundation reports `/var` and `/tmp` locations such as device
app containers; installation uses the realpath(3) form. `EFCRInstall(path)` rejects missing, relative, symlinked, noncanonical,
nonempty and permissive directories, and paths longer than 449 bytes, the most the
vendor's 512-byte System sidecar path allows. Do not replace or rename the
reserved directory concurrently. Validation failures permit a corrected attempt;
entering the vendor installer is terminal, even on failure. A successful install
returns with recording disabled. Call `EFCRSetEnabled(true)` explicitly.

Installation and enable/disable calls are serialized. Installing and enabling must run
on the main thread after UIApplicationMain has started, for example from
`application(_:didFinishLaunchingWithOptions:)`: installing and enabling reach UIKit
through the vendor monitors, and the signal alternate stack is set for the calling
thread. Other threads get a recoverable `EFCRInstallWrongThread`, or `false` from
`EFCRSetEnabled(true)`. Callers on another thread, such as the React Native JavaScript
thread, must hop to the main thread asynchronously; a synchronous hop can deadlock.
Disabling works on any healthy thread, so an opt-out takes effect where it is made: it
closes a lock-free report gate before changing monitors, and the monitors then only
flip flags, cancel a heartbeat timer, remove observers and unmap sidecars.
A fatal handler that already passed the gate may finish writing. Underlying
vendor tracker singletons can retain process-lifetime resources; disabled does
not mean every infrastructure object is destroyed. After a successful install,
even while disabled, the fatal signal handlers, the Mach exception ports with their
two handler threads and the uncaught NSException handler stay installed and pass
events on. The recorder never changes the host's UIDevice battery monitoring
setting; battery state is recorded only while the host enables monitoring.
No custom allocation, Foundation, locking, envelope construction or network work
runs in the report gate.

The selected detectors are Mach exceptions, fatal signals and uncaught Objective-C
exceptions. Coverage differs by platform:

- iOS and macOS: a Mach handler thread records traps and memory faults, including
  stack overflows; fatal signals such as `abort()` are recorded by signal handlers, and
  the installing main thread has an alternate signal stack.
- tvOS: `KSSystemCapabilities.h` sets `KSCRASH_HAS_MACH` and `KSCRASH_HAS_SIGNAL_STACK`
  to 0. The Mach detector is inert, so traps and memory faults are recorded only by
  signal handlers running on the faulting thread's own stack, and stack overflows are
  not recorded. tvOS evidence is compile-only.

Runtime probes run on the macOS host. Watchdog/termination/CPU reporting, C++
interception, memory introspection, queue-name lookup, exception userInfo and console
attachments are not enabled. Required upstream infrastructure can still write sidecar
context.

Raw reports remain local. A report holds the exception type, name and reason, the
crashed thread's register values, every thread's backtrace addresses with on-device
symbol names, thread names and run states, and the paths, UUIDs and load addresses of
every loaded binary image. An image entry also carries any runtime crash-info strings
that image holds (`crash_info_message`, `crash_info_message2`, `crash_info_signature`,
`crash_info_backtrace`, up to 4096 bytes each), such as a Swift `fatalError`,
`precondition` or `try!` message with its source file and line, or a system library
diagnostic. They are application- or library-controlled free text; importers must
redact and bound them like the exception reason. System, resource and lifecycle details
live in run sidecars. No raw stack
memory is copied, and register state is kept for the crashed thread only; those
registers can still hold small fragments of application data, such as short strings.
On arm64, once the crashing function has saved the link register and made a call, the
patched unwinder reports the caller restored from its frame record as frame 1 instead
of the stale register. The choice reads up to 12 instructions at the crash address and
the compact unwind ranges. A fault in a prologue or after an epilogue keeps the link
register as frame 1; there the next frame can still be skipped, as in upstream KSCrash.
The wrapper sets backup exclusion and mobile
complete-until-first-user-authentication protection on the run root; the patched
sidecar writer preserves that protection class. Children remain inside the0700
parent, without changing process-wide umask. Actual before-first-unlock and locked
physical-device behavior still needs qualification. The component neither uploads
nor deletes records. A run normally ends with at most one report because the fatal
event ends the process, but nothing enforces that: `maxReportCount` is 1, yet the vendor
prunes only at install, into an empty directory, and a rare second fatal event that
races the first can still write another report. Importers must accept any number of
`Reports/*.json` files. Cross-run byte and retention limits, interrupted-record
recovery, original-run attribution, encrypted outbox promotion and native symbolication
belong to subsequent SDK integration.

## Load-time behaviour

Linking the library runs two vendored initializers before `main`, whether or not
`EFCRInstall` is ever called:

- `KSCrashRecording/KSCrashAppStateTracker.m`: `+load` creates the process-lifetime
  app-state tracker. It registers an `atexit` block and six UIApplication lifecycle
  observers on iOS and tvOS, app extensions included (the vendor's NSExtensionHost
  observers are compiled only for watchOS, which this package does not target); on
  macOS it marks the state active. It also reads the `ActivePrewarm` environment variable.
- `KSCrashRecordingCore/KSThreadInit.m`: a library constructor records the main thread.

Neither writes files, installs handlers or enables capture. An integration that needs
no footprint before opt-in has to keep the component unlinked until then.

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
python3 -I -B -m unittest discover -s Tests -p 'test_*.py'
```

Preparation refuses to overwrite existing vendor source. Verification without an
upstream checkout checks the packaged manifest and resource integrity. Supplying
`KSCRASH_CHECKOUT` additionally compares original files and deterministic transforms;
the manifest alone is not a cryptographic attestation.

`Tests/run-probes.py --binary /path/to/EFCRProbe --evidence /path/to/new-evidence`
runs 47 fresh processes with 25-second deadlines and child-only core-dump disabling.
The probes cover directory validation, including real 449- and 450-byte run
directories at the path bound and a Foundation-style `/tmp` alias, off-main-thread
calls, initial disabled state, repeated/failed
installation, Swift/Objective-C/memory faults, an `abort()` that only the signal
monitor can record, disable/re-enable and rapid runs. Two modes move one control at a
time: a closed report gate with enabled monitors, and an open gate with the monitors
still disabled by installation; both must leave no report. A disable from a background
thread must close the gate and turn the monitors off: its mode reopens only the gate
before faulting and must leave no report. Each fatal process must end
with its fault's signal, and each report must record the expected Mach, signal or
NSException error with a crashed-thread backtrace. Swift, memory and frameless-leaf
faults must name their real caller as frame 1 without a repeated frame. On arm64 a
prologue stack overflow must keep its link-register caller; x86_64 has no link
register, so there the run records that check under `skippedChecks`, and `proof.json`
names the host architecture. The checks are explicit, so they also run under
`python3 -O`; `Tests/test_run_probes.py` covers the per-architecture frame checks with
synthetic reports. Every persisted file is scanned for the exception userInfo
sentinel and for a stack canary written in the faulting frame. Every output and raw
report is retained. `Tests/DualProbe/main.m` supports full-object link and fatal-chain
qualification alongside ordinary upstream recording objects.
Test helpers are not part of the library product.
