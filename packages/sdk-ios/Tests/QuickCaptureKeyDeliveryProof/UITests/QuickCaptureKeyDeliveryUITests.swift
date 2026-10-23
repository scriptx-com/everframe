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
        // Exactly one: a Shift press UIKit hands the hook twice must not count
        // as a second press and fire again.
        sleep(2)
        XCTAssertEqual(statusText(), "submits=1 quickCapture=true")
    }

    func testRemoteChordBindingFires() {
        launch(["--binding", "Mod+Shift+B"])
        XCTAssertEqual(statusText(), "submits=0 armed=true")
        app.typeKey("b", modifierFlags: [.command, .shift])
        XCTAssertTrue(waitForStatus("submits=1 quickCapture=true"), statusText())
    }

    private var unknownTaps: String {
        let crumbs = app.staticTexts["crumbs"]
        return (crumbs.value as? String) ?? crumbs.label
    }

    func testShiftBFiresOutsideATextField() {
        launch(["--binding", "Shift+B"])
        XCTAssertEqual(statusText(), "submits=0 armed=true")
        app.typeKey("b", modifierFlags: [.shift])
        XCTAssertTrue(waitForStatus("submits=1 quickCapture=true"), statusText())
        sleep(1)
        XCTAssertEqual(unknownTaps, "unknownTaps=0", "the focus probe must not record a tap breadcrumb")
    }

    /// The production first-responder probe, in a scene app: Shift+B typed into
    /// a focused field is a capital B.
    func testShiftBInAFocusedTextFieldTypesInstead() {
        launch(["--binding", "Shift+B"])
        let field = app.textFields["field"]
        field.tap()
        app.typeKey("b", modifierFlags: [.shift])
        sleep(1)
        XCTAssertEqual(statusText(), "submits=0 armed=true")
        XCTAssertEqual(field.value as? String, "B")
        XCTAssertEqual(unknownTaps, "unknownTaps=0", "the focus probe must not record a tap breadcrumb")
    }

    /// The guard reads the focus before UIKit delivers the key: a field that
    /// resigns first responder while that press is delivered to it still keeps
    /// Shift+B.
    func testShiftBInAFieldThatResignsOnTheCharacterTypesInstead() {
        launch(["--binding", "Shift+B", "--resigning-field"])
        let field = app.textFields["field"]
        field.tap()
        app.typeKey("b", modifierFlags: [.shift])
        sleep(1)
        XCTAssertEqual(statusText(), "submits=0 armed=true")
    }

    func testCommandChordFiresWithATextFieldFocused() {
        launch(["--binding", "Mod+Shift+B"])
        app.textFields["field"].tap()
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
