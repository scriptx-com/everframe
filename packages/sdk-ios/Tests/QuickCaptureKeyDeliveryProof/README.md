<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Quick capture key-delivery proof

An XCUITest that types real hardware-keyboard events into a host app and checks
that simulator quick capture fires. XCTest synthesizes the keys through the
simulator's HID path, the same path DeviceHub's keyboard takes, so the events
cross UIKit's own dispatch and the SDK's `UIWindow.sendEvent` hook. Unit tests
that call `QuickCapture.handle(_:)` skip that path.

UIKit delivers keyboard keys as the private `UIPhysicalKeyboardEvent`. It is a
`UIPressesEvent` subclass, but its `type` is not `.presses`. A hook that filters
on `event.type == .presses` never sees a key, and these tests fail.

The host app arms `QuickCapture.shared` with `@testable import EverframeKit` and
stubs everything after the hotkey match: submit, replay lifecycle and toast. It
makes no network calls.

Run it on a simulator you own:

    cd packages/sdk-ios/Tests/QuickCaptureKeyDeliveryProof
    xcodegen generate
    xcodebuild test -project QuickCaptureKeyDeliveryProof.xcodeproj \
      -scheme QuickCaptureKeyDeliveryProof -destination "id=$SIM_UDID"
