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
        app.buttons["Exercise KMP context"].tap()
        XCTAssertTrue(app.staticTexts["context requested"].waitForExistence(timeout: 10))
    }

    func testSwiftUIHostSubmitsNativeReportWithKmpContext() {
        let app = XCUIApplication()
        for name in ["EVERFRAME_APP_ID", "EVERFRAME_SDK_KEY"] {
            if let value = ProcessInfo.processInfo.environment[name] {
                app.launchEnvironment[name] = value
            }
        }
        if app.launchEnvironment["EVERFRAME_SDK_KEY"] == nil {
            app.launchEnvironment["EVERFRAME_DEV_INGEST_URL"] = "http://127.0.0.1:8937"
        }
        app.launch()
        app.buttons["Start Everframe"].tap()
        XCTAssertTrue(app.staticTexts["started"].waitForExistence(timeout: 10))
        app.buttons["Exercise KMP context"].tap()
        app.buttons["Open native reporter"].tap()
        XCTAssertTrue(app.staticTexts["Report a bug"].waitForExistence(timeout: 10))
        let title = app.textFields["Title"]
        XCTAssertTrue(title.waitForExistence(timeout: 10))
        title.tap()
        title.typeText("KMP iOS context dry run")
        app.buttons["Done"].tap()
        app.buttons["Send report"].tap()
        XCTAssertTrue(app.staticTexts["submitted"].waitForExistence(timeout: 20))
    }
}
