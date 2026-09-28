// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest

final class NativeProbeUITests: XCTestCase {
    func testSwiftUIHostStartsSharedBridgeAndTransitions() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.staticTexts["SwiftUI screen A"].waitForExistence(timeout: 10))
        app.buttons["Start Everframe"].tap()
        XCTAssertTrue(app.staticTexts["started"].waitForExistence(timeout: 10))
        app.buttons["Next screen"].tap()
        XCTAssertTrue(app.staticTexts["SwiftUI screen B"].waitForExistence(timeout: 10))
    }
}
