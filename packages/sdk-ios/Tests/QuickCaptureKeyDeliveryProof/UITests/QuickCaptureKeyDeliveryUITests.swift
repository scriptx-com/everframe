// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Real hardware-keyboard events, synthesized by XCTest through the simulator's
// HID path, the same path DeviceHub's keyboard takes. UIKit delivers them as
// `UIPhysicalKeyboardEvent`, whose `type` is not `.presses`; a direct
// `QuickCapture.handle(_:)` test cannot see that.
import XCTest

final class QuickCaptureKeyDeliveryUITests: XCTestCase {
    private var app: XCUIApplication!
    private var status: XCUIElement { app.staticTexts["status"] }

    override func setUp() {
        continueAfterFailure = false
    }

    private func launch(_ arguments: [String] = []) {
        app = XCUIApplication()
        app.launchArguments = arguments
        app.launch()
        XCTAssertTrue(status.waitForExistence(timeout: 10))
    }

    private func statusText() -> String { (status.value as? String) ?? status.label }

    /// Holding Shift with no other key sends one Shift down and one Shift up.
    private func tapShift() {
        XCUIElement.perform(withKeyModifiers: .shift) {}
    }

    private func waitForStatus(_ expected: String, timeout: TimeInterval = 5) -> Bool {
        let predicate = NSPredicate(format: "value == %@", expected)
        let found = expectation(for: predicate, evaluatedWith: status)
        return XCTWaiter().wait(for: [found], timeout: timeout) == .completed
    }

    func testDoubleShiftFiresOneQuickCapture() {
        launch()
        XCTAssertEqual(statusText(), "submits=0 armed=true")
        tapShift()
        tapShift()
        XCTAssertTrue(waitForStatus("submits=1 quickCapture=true"), statusText())
    }

    func testRemoteChordBindingFires() {
        launch(["--binding", "Mod+Shift+B"])
        XCTAssertEqual(statusText(), "submits=0 armed=true")
        app.typeKey("b", modifierFlags: [.command, .shift])
        XCTAssertTrue(waitForStatus("submits=1 quickCapture=true"), statusText())
    }

    func testSingleShiftAndTypingDoNotFire() {
        launch()
        tapShift()
        app.typeKey("a", modifierFlags: [])
        tapShift()
        sleep(1)
        XCTAssertEqual(statusText(), "submits=0 armed=true")
    }

    func testDisarmedSessionIgnoresDoubleShift() {
        launch(["--remote-disabled"])
        XCTAssertEqual(statusText(), "submits=0 armed=false")
        tapShift()
        tapShift()
        sleep(1)
        XCTAssertEqual(statusText(), "submits=0 armed=false")
    }
}
