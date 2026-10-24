// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import XCTest

final class RNE2EProbeTests: XCTestCase {
    func testReporterButtonKeepsTheAppRunning() {
        let app = XCUIApplication(bundleIdentifier: "dev.everframe.example")
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30))
        let reportButton = app.buttons["open-reporter-button"]
        XCTAssertTrue(reportButton.waitForExistence(timeout: 10))
        XCTAssertTrue(reportButton.hasFocus)
        XCUIRemote.shared.press(.select)
        // tvOS has no on-device reporter: the press must not take the app down.
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 5))
    }
}
