<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# macOS desktop capture feasibility

Date: 2026-09-28. Public local branch: `codex/macos-desktop-probe`, stacked on the Flutter web probe. This is a dry run, with no SDK, backend, release, or production traffic.

## Current decision

The Flutter renderer frame had public A/B tiles and safe masking but omitted the embedded AppKit view. The original Compose AWT `printAll` frame had its Swing view but omitted the Compose scene. A newer in-process Compose renderer capture passed the sample UI, moving sensitive bounds, transition, and Swing checks using Compose 1.13.0-alpha01. See [Flutter measurement](flutter-macos-renderer-capture.md) and [Compose measurement](compose-macos-renderer-capture.md). Media, player, and image surfaces may be intentionally omitted or replaced with a safe placeholder, matching the existing native replay scope.

ScreenCaptureKit is one comparison candidate, not a requirement for desktop replay. The native Android and iOS SDKs capture their own app UI without OS screen-recording permission. The Compose in-process path now shows the primary UI and embedded Swing view in this sample. A measured sensitive rectangle followed one moved tile; general layout proof is still needed before becoming an SDK implementation. Any source used must align in window coordinates, mask before encoding, and fail closed when required UI or privacy geometry is missing.

The existing ScreenCaptureKit comparison utility is in `examples/macos-window-capture-probe`. It selects one window by exact process ID and title, calibrates its logical mask from the public tile in the captured pixels, blacks the sensitive tile in memory, scans the entire masked image for magenta, and only then encodes a PNG. It rejects missing or ambiguous windows, invalid geometry, and unsafe pixels. The calibration is intentionally limited to this fixed sample scene; it is not a general SDK masking implementation.

| Capability | Flutter renderer | Compose renderer (1.13 alpha) | App-window candidate |
| --- | --- | --- | --- |
| Visible public scene | PASS, two states | PASS, two states | BLOCKED, no live capture |
| Sensitive masking | PASS in fixed scene | PASS for one moving tile | Synthetic frame PASS; live BLOCKED |
| Embedded native view | BLOCKED | PASS, Swing view | BLOCKED, no live capture |
| Two-frame visual replay | PASS for sample renderer frames only | PASS for sample renderer frames only | BLOCKED, no live capture |
| Exact app-window scope | Not measured | In-process window scope | Selection unit tests PASS; live BLOCKED |
| Permission denial | Not applicable | Not applicable | PASS: no output directory or PNG |
| Popup, move, resize, display scale | Not measured | One tile move PASS; popup/resize untested | Geometry unit tests PASS; live BLOCKED |

## Reproduction and proof limit

Tested on macOS 27.0, Xcode 27.0, Apple Swift 6.4. Run `swift test` from `examples/macos-window-capture-probe` to verify the five window-selection, geometry, masking, and secret-pixel tests. A real capture uses:

```sh
swift run macos-window-capture-probe --pid <sample-pid> --title 'Everframe Compose desktop probe' --state a --out <temporary-directory>
```

The local Screen Recording preflight returned false. Running the command with a valid argument shape returned `BLOCKED:permission` (exit 2) and created no output directory. That permission is required to run this ScreenCaptureKit comparison, not to implement in-process replay. The code does not request permission itself or silently fall back to whole-screen capture. No live ScreenCaptureKit screenshot, native-view inclusion, two-frame window transition, popup, or resize result is claimed.

The next Compose investigation is general privacy bounds and interactions across popups and resizes. The renderer API is marked for tooling and currently requires a pre-release Compose build. ScreenCaptureKit remains a comparison path if permission is available. Windows and Linux, reporter UI, event capture, offline outbox, delivery, and dashboard integration remain separate gates before any desktop support claim.
