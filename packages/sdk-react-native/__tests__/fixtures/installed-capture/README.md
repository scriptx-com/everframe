<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Installed explicit capture probe

This fixture calls the built public package's top-level and hook APIs from a
mounted provider. It leaves real engine-generated frames intact and uses two
distinct exception types to avoid the one-per-key allowance. It produces no
envelopes itself. A successful JS launch is not acceptance: inspect actual
persisted envelopes for both marker messages, `source=error`,
`mechanism=captureException`, `handled=true`, `fatal=false`, nonempty real
frames and matching platform/build identity.

Use only a separately owned local Debug host with a collision-checked unique
application/bundle ID and explicit loopback ingest. Rebuild
`pnpm --filter @everframe/react-native build` first, because the example resolves
`dist/index.js`. Record source, JS artifact, native artifact and installed
binary hashes. Back up any generated host/entry file before substituting this
`App`. Metro excludes `__tests__`, so copy this file unchanged into a temporary
host source file such as `examples/react-native/src/C1aInstalledCapture.tsx`,
record both hashes, and import `./src/C1aInstalledCapture` from the host entry.
Remove only that owned copy when restoring the entry. Invoke Expo/Metro directly
with `EXPO_NO_DOTENV=1`; the normal example
start script synchronizes real keys and is unsuitable for this fixture.
For this Expo CLI, use `EXPO_OFFLINE=1` with `--localhost` (the `--offline` flag
conflicts with it). `NODE_OPTIONS=--dns-result-order=ipv4first` keeps localhost
reachable through the owned Android reverse port when Node otherwise binds IPv6.

Android: read the owned app's actual
`cache/com.traceitx/{crash-outbox,outbox}.jsonl` using `adb run-as`; decode the
stored `envelopeBytes` rather than reconstructing an envelope. Keep queued
endpoint evidence and reject anything except the configured loopback endpoint.

iOS: copy `ios/Tests/Fixtures/CaptureOutboxObserver.swift` into the owned
generated Debug app target, call `CaptureOutboxObserver.start()` at launch and
retain/cancel its returned task with the host lifecycle. It reads the same
encrypted outbox/keychain via public `JSONLOutbox.hydrate()` and exports original
entries to `Documents/c1a-capture-outbox.json`, polling for at most 30 seconds.
For the generated Expo project's virtual app group, the source reference must
include its disk directory (`TraceItXRNExample/CaptureOutboxObserver.swift`).
Point `RCTBundleURLProvider.sharedSettings().jsLocation` at the owned Metro
address (for example `127.0.0.1:8097`) and prewarm the iOS bundle before launch.
Keep both `TraceItXDevIngestURL` in the host plist and
`SIMCTL_CHILD_TRACEITX_DEV_INGEST_URL` at `http://127.0.0.1:9`.
Retrieve it through `simctl get_app_container`; reject an error file, missing
probe or wrong captured endpoint. The observer never enqueues or drains.

Compile the observer in the actual host. This fixture is outside the obsolete
RN XCTest skeletons; their exclusion is not an execution result for it. Keep
Debug installed persistence separate from optimized Hermes/source-map/OTA,
API 24/25, physical-device and old/new-native compatibility gates. Preserve the
preexisting example app installation, and restore owned temporary host edits.

Observed acceptance on 2026-09-14: both probes persisted on owned Android API 35
and iOS 26.5 arm64 Debug Hermes hosts. This fixture does not close the separate
compatibility, optimized-build or device gates above.
