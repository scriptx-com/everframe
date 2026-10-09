<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Installed Release native crash acceptance app

This host uses public `Everframe.start`, native signal opt-in, readiness, kill and
report-delivery status methods. Both SDK dependencies are actual Release
variants; the application is minified, nondebuggable, and signed with the local
Android debug signing key solely for installation. The fault library is compiled
with optimization and debug information and deliberately terminates the process.
It is not part of any SDK artifact.

Build the native module first using `../../native/README.md`. From the Android
Gradle root:

```sh
./gradlew :native-release-host:assembleRelease \
  -PnativeReleaseAcceptance=true \
  -PnativeProofCa=/absolute/local-test-ca.pem \
  -PeverframeNativeBuildDir=/absolute/owned-native-build
```

`nativeProofVersion=2` builds the replacement application. `nativeProofModule=false`
builds a core-only negative control. `nativeProofLegacyPackaging=false` keeps the
default packaging, which does not extract native libraries: launched with mode
`absent`, it must report `refused` and log the `Everframe` warning naming
`native-libraries-not-extracted`. JNI code currently targets ARM64 for installed
API26/30 qualification. The library build independently verifies all packaged ABIs.

The host trusts the supplied test CA only for `everframe.dev`, matching the
unmodified Release SDK endpoint. Use an owned emulator with a local CONNECT/TLS
proxy and block other network access for this app UID before launching. Supply
only synthetic keys issued by your local test service. This app must not be
pointed at a production account.

Launch `dev.everframe.releaseproof/.MainActivity` with string intent extras:
`appId`, `sdkKey`, `release`, and `mode`. Replacement/cycle checks additionally
use `appIdB`, `sdkKeyB`, `releaseB`. Modes:

- `main` / `worker`: wait for readiness, then execute the authored native fault.
- `recover`: recover and drain previous-process evidence using the current config.
- `disable`, `kill`, `paused`: establish the respective boundary, then fault.
- `reenable`, `replace`, `cycles`: exercise rearming and twelve replacement starts.
- `foreign`: refuse an existing app-bundled signal handler.
- `no-optin`, `absent`: default-off and missing-module controls.
- `null-call`: wait for readiness, then call a null function pointer. The fault
  PC is zero, so the next `recover` delivers a report without frames: empty
  `androidNative.frames` and `frames`, `signalNumber` 11, `signalCode` 1, and the
  signal-only fingerprint.
- `plus-module`: wait for readiness, then fault inside `libeverframe_release+plus.so`.
  The report has one frame whose module is that SONAME, with its ELF build ID.
- `mappings`: split one reservation into about 6,000 mappings below the dynamic
  linker before the opt-in (`files/mappings.txt` holds the split count and the
  maps line count). Readiness must become true; the report matches `main`.
- `webview-before`: initialize a WebView before the opt-in, so its in-process
  crash handler is installed first (`files/signal-owners.txt` names the provider
  library). Readiness must become true; the report matches `main`.
- `webview-after`: after readiness, initialize a WebView, whose handler then
  precedes the armed one (`files/signal-owners-webview.txt`), and opt in again.
  Readiness must return (`re-armed`) within 20 seconds, otherwise the state is
  `timeout`; the report matches `main`.

The WebView modes need a WebView provider whose crash handler chains to the
previous handler (current providers use Crashpad); record the provider package and
version with the run.

`SecondaryActivity` runs in `:secondary`; `secondary-disable` verifies that
secondary-process opt-in/disable/kill cannot take over the primary collector.
The local `files/acceptance-status.json` contains only public delivery diagnostics.
No envelope is reconstructed or injected by the host. Retain the exact APK,
unstripped `libeverframe_release_fault.so` and `libeverframe_release+plus.so`, source, build manifest and HTTP
requests for qualification. A captured partial fault frame must map to the
actual assembly store line in `fault.cc` with matching ELF symbols, while a
wrong ELF identity remains unmapped.
