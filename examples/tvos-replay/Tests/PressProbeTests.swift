// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import XCTest

/// Opt-in remote press probe. Runs only with `REPLAY_TV_PRESS_PROBE=1` in the
/// runner's environment (`TEST_RUNNER_REPLAY_TV_PRESS_PROBE=1` on the
/// `xcodebuild` command line). The app writes what it saw to
/// `press-probe.log` in its caches; these scripts only drive the remote.
final class PressProbeTests: XCTestCase {
    private let targets = ["probe-button", "probe-tap", "probe-player", "probe-swiftui"]
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        let env = ProcessInfo.processInfo.environment
        guard env["REPLAY_TV_PRESS_PROBE"] == "1" else { throw XCTSkip("REPLAY_TV_PRESS_PROBE=1 not supplied") }
        continueAfterFailure = true
        app = XCUIApplication()
        for name in ["REPLAY_TV_PRESS_PROBE", "REPLAY_TV_PROBE_DROP", "REPLAY_TV_RELEASE_MODE",
                     "EVERFRAME_E2E_SDK_KEY", "EVERFRAME_DEV_INGEST_URL", "EVERFRAME_SIMULATE_DEVICE"] {
            if let value = env[name] { app.launchEnvironment[name] = value }
        }
        app.launch()
        XCTAssertTrue(app.staticTexts["probe-focus"].waitForExistence(timeout: 15))
        pause()
    }

    func testEveryButton() {
        for target in targets {
            focus(target)
            for button: XCUIRemote.Button in [.up, .down, .left, .right] {
                XCUIRemote.shared.press(button)
                pause(0.7)
            }
            focus(target)
            for button: XCUIRemote.Button in [.select, .menu, .playPause] {
                XCUIRemote.shared.press(button)
                pause()
                // Select on the player can open its full-screen controls; Menu
                // closes them again, so focus is re-checked before each press.
                if app.state != .runningForeground { app.activate(); pause() }
                focus(target)
            }
        }
    }

    func testHeldPlayPause() {
        for target in ["probe-tap", "probe-player", "probe-swiftui"] {
            focus(target)
            XCUIRemote.shared.press(.playPause, forDuration: 1.6)
            pause()
            XCUIRemote.shared.press(.playPause)
            pause()
        }
    }

    /// Ordinary remote use: Play/Pause taps, a held arrow, and ↑↑↓↓.
    func testNormalUse() {
        focus("probe-player")
        XCUIRemote.shared.press(.playPause)
        pause()
        XCUIRemote.shared.press(.playPause)
        pause()
        XCUIRemote.shared.press(.down, forDuration: 2.0)
        pause()
        for button: XCUIRemote.Button in [.up, .up, .down, .down] { XCUIRemote.shared.press(button) }
        pause()
    }

    func testHeldArrow() {
        focus("probe-button")
        XCUIRemote.shared.press(.down, forDuration: 2.0)
        pause()
    }

    // MARK: Helpers

    private func pause(_ seconds: TimeInterval = 2) { Thread.sleep(forTimeInterval: seconds) }

    /// The target the app reports as focused (`probe-focus`): an embedded
    /// player or a SwiftUI button keeps focus on an inner element.
    private var focused: String { app.staticTexts["probe-focus"].label }

    /// Moves focus along the row until `id` has it, and checks that it does.
    private func focus(_ id: String) {
        guard let index = targets.firstIndex(of: id) else { return }
        for _ in 0..<8 {
            if focused == id { break }
            let current = targets.firstIndex(of: focused)
            XCUIRemote.shared.press((current ?? 0) < index ? .right : .left)
            pause(0.7)
        }
        XCTAssertEqual(focused, id, "focus on \(id)")
    }
}
