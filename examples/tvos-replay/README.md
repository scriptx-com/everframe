<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Everframe tvOS replay sample

A deterministic UIKit tvOS host used to demonstrate and smoke-test Everframe
session replay, focus navigation, masking, SwiftUI embedding, and opaque player
surfaces. It uses procedural artwork and does not require external media.

The checked-in UI smoke test is credential-free. It builds the SDK through the
local Swift package, launches the sample on a tvOS simulator, and drives a
remote-control focus pattern. No dashboard account or backend is required.

## Generate and test

Requirements: Xcode, a tvOS simulator, and XcodeGen.

```sh
cd examples/tvos-replay
xcodegen generate
xcodebuild test \
  -project ReplayTV.xcodeproj \
  -scheme ReplayTV \
  -configuration Release \
  -destination 'platform=tvOS Simulator,name=Apple TV' \
  'SWIFT_ACTIVE_COMPILATION_CONDITIONS=$(inherited) DEBUG' \
  -test-timeouts-enabled YES \
  -maximum-test-execution-time-allowance 90
```

Without a key, the host still launches and the focus smoke test runs; the
Everframe client remains stopped. To exercise replay capture against a backend
you control, pass these launch environment values:

- `EVERFRAME_E2E_SDK_KEY`: a non-production SDK key.
- `EVERFRAME_DEV_INGEST_URL`: a loopback development ingest origin.
- `REPLAY_TV_AUTOSCROLL=1`: optional deterministic automatic navigation.
- `REPLAY_TV_SWIFTUI=1`: optional SwiftUI header coverage.
- `REPLAY_TV_ERROR_AFTER=<seconds>`: optional; reports one handled error that long after the SDK starts, to check that an error carries a replay.
- `REPLAY_TV_RUN=<label>`: optional; names the run in the error message.

- `REPLAY_TV_RELEASE_MODE=1`: optional; starts the SDK as a release build
  (`debugBuild: false`), so the unlinked-release quick capture rules can be
  checked in a simulator.

## Remote press probe

`REPLAY_TV_PRESS_PROBE=1` replaces the rails with a row of four Play/Pause
targets: a `UIButton`, a view with a Play/Pause `UITapGestureRecognizer`, an
embedded `AVPlayerViewController` (playing a 10 s movie written at launch from
procedural frames) and a SwiftUI button with `onPlayPauseCommand`. Every press
the window receives, and what each target does with it, is logged to the
console and to `press-probe.log` in the app's caches, as
`EvfTvProbe type=<press> phase=<began|ended|cancelled> t=<ms> focus=<id>` and
`EvfTvProbe action=<target>:<event> t=<ms>` (`action=app:` lines are presses
that reached the app's views). `REPLAY_TV_PROBE_DROP` withholds presses at the
window the way an SDK would: `<press>:<began|ended>` pairs, comma-separated,
or `<press>:heldEnded` for only the release of a press held at least 1.4 s.

`PressProbeTests` drives the probe and skips unless the runner has
`REPLAY_TV_PRESS_PROBE=1`:

```sh
TEST_RUNNER_REPLAY_TV_PRESS_PROBE=1 \
TEST_RUNNER_REPLAY_TV_PROBE_DROP=playPause:heldEnded \
xcodebuild test -project ReplayTV.xcodeproj -scheme ReplayTV \
  -destination 'platform=tvOS Simulator,name=<your throwaway simulator>' \
  -only-testing:ReplayTVUITests/PressProbeTests
xcrun simctl get_app_container <udid> dev.everframe.replaytv data   # then Library/Caches/press-probe.log
```

## Quick capture UI test

`QuickCaptureRemoteTests` holds Play/Pause with `XCUIRemote` and checks the
quick-capture toast, the link banner (focus keeps moving in the rails while it
shows) and Record on device. It runs the app as a real Apple TV
(`EVERFRAME_SIMULATE_DEVICE=1`) against a backend you control, and skips
without a loopback `EVERFRAME_DEV_INGEST_URL` and a non-production
`EVERFRAME_E2E_SDK_KEY` in the runner's environment (`TEST_RUNNER_` prefix).
Build with `'SWIFT_ACTIVE_COMPILATION_CONDITIONS=$(inherited) DEBUG'` so the
SDK reads the development ingest URL, and with
`CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-` (sign to run locally): the
device token lives in the Keychain, which an unsigned simulator app cannot
write, so linking fails without it. Optional switches:
`REPLAY_TV_EXPECT_BANNER=1` (a link window is open on the backend),
`REPLAY_TV_EXPECT_LINK=1` (the backend then approves the link),
`REPLAY_TV_RELEASE_MODE=1`, and `REPLAY_TV_EXPECT_RECORDING=1` with
`REPLAY_TV_CONTROL_URL` (a loopback URL that makes the backend ask for a
recording).

The `ReplayPhone` scheme builds the same fixture for an iPhone
(`xcodebuild build -project ReplayTV.xcodeproj -scheme ReplayPhone`).

Do not put keys in the Xcode project, generated `.xctestrun` files, or source.
Operational benchmarks and dashboard verification are intentionally outside
this public sample.
