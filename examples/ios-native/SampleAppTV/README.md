<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# SampleAppTV — Everframe tvOS demo

This is the **sample** Apple TV host app used to exercise the Everframe SDK on
tvOS. It is NOT part of the SDK — it lives under `examples/` so customers can
see idiomatic host wiring.

## Reporting on Apple TV

tvOS has no on-device reporter. Crashes, errors and session replay are still
captured and reach the dashboard. (The earlier phone-companion QR flow has
been removed from the SDK.)

## Existing demos (Phase 05.1)

- Focused button → `Everframe.shared.report.open()`.
- PressForwarder × 3 play/pause within 1.5 s → trigger combo.
- `markSensitive` demo on the Payment mock screen.

These are unchanged.
