<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# macOS desktop capture feasibility

Date: 2026-09-28. Public local branch: `codex/macos-desktop-probe`, stacked on the Flutter web probe. This is a dry run, with no SDK, backend, release, or production traffic.

## Current decision

Renderer-only capture cannot meet the full native reporting requirement in these samples. The Flutter renderer frame had public A/B tiles and safe masking but omitted the embedded AppKit view. The Compose AWT frame had its Swing view but omitted the Compose scene. See [Flutter measurement](flutter-macos-renderer-capture.md) and [Compose measurement](compose-macos-renderer-capture.md).

ScreenCaptureKit is one comparison candidate, not a requirement for desktop replay. The native Android and iOS SDKs capture their own app UI without OS screen-recording permission. The next macOS probe should first test an in-process capture/composition path: Flutter renderer pixels plus the app's own `NSView` content, and Compose renderer pixels plus `SwingPanel` content. These sources must align in window coordinates, mask before encoding, and fail closed if any surface is missing. AppKit view caching is a candidate for native `NSView` pixels, but the Flutter/Compose rendering surfaces still need live coverage proof.

The existing ScreenCaptureKit comparison utility is in `examples/macos-window-capture-probe`. It selects one window by exact process ID and title, calibrates its logical mask from the public tile in the captured pixels, blacks the sensitive tile in memory, scans the entire masked image for magenta, and only then encodes a PNG. It rejects missing or ambiguous windows, invalid geometry, and unsafe pixels. The calibration is intentionally limited to this fixed sample scene; it is not a general SDK masking implementation.

| Capability | Flutter renderer | Compose AWT renderer | App-window candidate |
| --- | --- | --- | --- |
| Visible public scene | PASS, two states | BLOCKED | BLOCKED, no live capture |
| Sensitive masking | PASS in fixed scene | BLOCKED for full UI | Synthetic frame PASS; live BLOCKED |
| Embedded native view | BLOCKED | PASS | BLOCKED, no live capture |
| Two-frame visual replay | PASS for sample renderer frames only | BLOCKED | BLOCKED, no live capture |
| Exact app-window scope | Not measured | Not measured | Selection unit tests PASS; live BLOCKED |
| Permission denial | Not applicable | Not applicable | PASS: no output directory or PNG |
| Popup, move, resize, display scale | Not measured | Not measured | Geometry unit tests PASS; live BLOCKED |

## Reproduction and proof limit

Tested on macOS 27.0, Xcode 27.0, Apple Swift 6.4. Run `swift test` from `examples/macos-window-capture-probe` to verify the five window-selection, geometry, masking, and secret-pixel tests. A real capture uses:

```sh
swift run macos-window-capture-probe --pid <sample-pid> --title 'Everframe Compose desktop probe' --state a --out <temporary-directory>
```

The local Screen Recording preflight returned false. Running the command with a valid argument shape returned `BLOCKED:permission` (exit 2) and created no output directory. That permission is required to run this ScreenCaptureKit comparison, not to implement in-process replay. The code does not request permission itself or silently fall back to whole-screen capture. No live ScreenCaptureKit screenshot, native-view inclusion, two-frame window transition, popup, or resize result is claimed.

The preferred next investigation is an in-process app-window capture/composition service. ScreenCaptureKit remains a comparison path if permission is available. Windows and Linux, reporter UI, event capture, offline outbox, delivery, and dashboard integration remain separate gates before any desktop support claim.
