// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import XCTest

final class RemoteRailTests: XCTestCase {
    /// Opt-in local integration test; credentials arrive only through a
    /// temporary xctestrun file made by drive-xctest.mjs, never the project.
    func testConfiguredReplayWorkload() throws {
        let env = ProcessInfo.processInfo.environment
        guard let key = env["EVERFRAME_E2E_SDK_KEY"], let endpoint = env["EVERFRAME_DEV_INGEST_URL"],
              let host = URL(string: endpoint)?.host, ["localhost", "127.0.0.1"].contains(host)
        else { throw XCTSkip("Local replay integration environment not supplied") }
        let app = XCUIApplication()
        for name in ["REPLAY_TV_RUN", "REPLAY_TV_MODE", "REPLAY_TV_SWIFTUI"] {
            app.launchEnvironment[name] = env[name] ?? ""
        }
        app.launchEnvironment["EVERFRAME_E2E_SDK_KEY"] = key
        app.launchEnvironment["EVERFRAME_DEV_INGEST_URL"] = endpoint
        app.launchEnvironment["REPLAY_TV_AUTOSCROLL"] = "0"
        app.launch()
        XCTAssertTrue(app.cells["poster-0-0"].waitForExistence(timeout: 15))
        if env["REPLAY_TV_BACKGROUND"] == "1" {
            Thread.sleep(forTimeInterval: 8)
            XCUIRemote.shared.press(.home)
            XCTAssertTrue(app.wait(for: .runningBackground, timeout: 10))
            Thread.sleep(forTimeInterval: 3)
            app.activate()
            XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
            emit("EVERFRAME_TV_RESUMED epochMs=\(Date().timeIntervalSince1970 * 1000)")
        }
        let seconds = try XCTUnwrap(Double(env["REPLAY_RUN_SECONDS"] ?? "75"))
        XCTAssertTrue((15...120).contains(seconds))
        let deadline = Date().addingTimeInterval(seconds)
        var pattern: [XCUIRemote.Button] = []
        pattern.reserveCapacity(36)
        pattern.append(contentsOf: repeatElement(.right, count: 8))
        pattern.append(.down)
        pattern.append(contentsOf: repeatElement(.left, count: 8))
        pattern.append(.down)
        pattern.append(contentsOf: repeatElement(.right, count: 8))
        pattern.append(.up)
        pattern.append(contentsOf: repeatElement(.left, count: 8))
        pattern.append(.up)
        var keys = 0
        while Date() < deadline {
            XCUIRemote.shared.press(pattern[keys % pattern.count])
            keys += 1
        }
        XCTAssertEqual(app.state, .runningForeground)
        emit("EVERFRAME_REMOTE_DONE keys=\(keys)")
        // Keep ownership until the browser finishes, not an unrelated timer.
        // The driver writes only into this test runner's own cache container.
        let controlName = try XCTUnwrap(env["REPLAY_TV_CONTROL_NAME"])
        let control = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(controlName)
        defer { try? FileManager.default.removeItem(at: control) }
        let releaseDeadline = Date().addingTimeInterval(120)
        while !FileManager.default.fileExists(atPath: control.path), Date() < releaseDeadline {
            Thread.sleep(forTimeInterval: 0.1)
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: control.path), "Companion ownership release timed out")
    }

    private func emit(_ value: String) {
        FileHandle.standardOutput.write(Data((value + "\n").utf8))
    }

    func testRemoteMovesFocusAcrossAndBetweenRails() {
        let app = XCUIApplication()
        app.launchEnvironment["REPLAY_TV_MODE"] = "off"
        app.launchEnvironment["REPLAY_TV_RUN"] = "remote-smoke"
        app.launch()
        let first = app.cells["poster-0-0"]
        XCTAssertTrue(first.waitForExistence(timeout: 15))
        XCTAssertTrue(first.hasFocus)
        XCUIRemote.shared.press(.right)
        XCTAssertTrue(app.cells["poster-0-1"].hasFocus)
        for _ in 0..<6 { XCUIRemote.shared.press(.right) }
        XCTAssertTrue(app.cells["poster-0-7"].hasFocus)
        XCUIRemote.shared.press(.down)
        XCTAssertFalse(app.cells["poster-0-7"].hasFocus)
        let secondRail = app.cells.matching(NSPredicate(format: "identifier BEGINSWITH 'poster-1-'"))
        guard waitForFocus(in: secondRail, timeout: 10) else {
            XCTFail("focus did not move to the second rail")
            return
        }
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "tvOS-native-rail-focus"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func waitForFocus(in query: XCUIElementQuery, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if query.allElementsBoundByIndex.contains(where: { $0.hasFocus }) { return true }
            Thread.sleep(forTimeInterval: 0.1)
        } while Date() < deadline
        return false
    }
}
