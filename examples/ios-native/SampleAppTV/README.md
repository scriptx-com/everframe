<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# SampleAppTV — Everframe tvOS demo

This is the **sample** Apple TV host app used to exercise the Everframe SDK on
tvOS. It is NOT part of the SDK — it lives under `examples/` so customers can
see idiomatic host wiring.

## Phase 06.2-07 — Phone-companion reporter

The SDK exposes two read-only properties on `Everframe.shared.companion`:

| Property | Type                     | Description                                                                  |
| -------- | ------------------------ | ---------------------------------------------------------------------------- |
| `state`  | `CompanionState`         | `.unpaired \| .paired \| .reportInProgress \| .phoneDisconnected`            |
| `pairUrl`| `String?`                | URL the phone scans (e.g. `https://relay.example/r/<token>`); `nil` until the relay issues it |

Hosts render whatever chrome they want from those values. **The SDK ships zero
QR-rendering or indicator chrome** (Phase 05.1 precedent for host-rendered
chrome — see `grep -rE "QRCode|qr-code" packages/sdk-ios/Sources/`).

### `CompanionQRView.swift`

The sample uses `CIQRCodeGenerator` (Foundation built-in, zero dependencies)
to render the pair URL as a QR. Hosts may swap in any QR library
(EFQRCode, swift-qrcode-generator, etc.) without touching SDK code. The view
binds to `Everframe.shared.companion` via `@ObservedObject` and re-renders on
every `state` / `pairUrl` change.

Reachable from the Apple TV sample via the "Companion QR" focused button on
the home screen.

### Wiring autostart

The phone-companion WS client is not auto-started on `Everframe.shared.start(_:)`
— hosts opt in. The current sample does NOT wire the autostart (it's a
focused demo of the QR-rendering API surface); the orchestration plan
(06.2-09) wires `enableCompanion` into the config struct and starts
`RelayWSClient` from `start(config:)`.

## Existing demos (Phase 05.1)

* Focused button → `Everframe.shared.report.open()`.
* PressForwarder × 3 play/pause within 1.5 s → trigger combo.
* `markSensitive` demo on the Payment mock screen.

These are unchanged.
