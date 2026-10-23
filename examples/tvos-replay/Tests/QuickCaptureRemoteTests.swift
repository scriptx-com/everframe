// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import XCTest

/// Opt-in quick capture checks on the Siri Remote. They need a backend you
/// control on a loopback origin (`EVERFRAME_DEV_INGEST_URL`) and a
/// non-production `EVERFRAME_E2E_SDK_KEY`, passed in the runner's environment
/// (`TEST_RUNNER_` prefix on the `xcodebuild` command line); otherwise they skip.
/// The app runs as a real Apple TV (`EVERFRAME_SIMULATE_DEVICE=1`), so it
/// follows the real-device rules: a debug build or a linked device captures.
final class QuickCaptureRemoteTests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        let env = ProcessInfo.processInfo.environment
        guard let key = env["EVERFRAME_E2E_SDK_KEY"], let endpoint = env["EVERFRAME_DEV_INGEST_URL"],
              let host = URL(string: endpoint)?.host, ["localhost", "127.0.0.1"].contains(host)
        else { throw XCTSkip("Local quick capture environment not supplied") }
        app = XCUIApplication()
        app.launchEnvironment["EVERFRAME_E2E_SDK_KEY"] = key
        app.launchEnvironment["EVERFRAME_DEV_INGEST_URL"] = endpoint
        app.launchEnvironment["EVERFRAME_SIMULATE_DEVICE"] = "1"
        app.launchEnvironment["REPLAY_TV_AUTOSCROLL"] = "0"
        for name in ["REPLAY_TV_PRESS_PROBE", "REPLAY_TV_RELEASE_MODE", "REPLAY_TV_RUN", "REPLAY_TV_PROBE_DROP"] {
            if let value = env[name] { app.launchEnvironment[name] = value }
        }
    }

    private var env: [String: String] { ProcessInfo.processInfo.environment }

    /// Hold Play/Pause for 1.6 s: a debug or linked Apple TV files a capture.
    func testLongPressPlayPauseCaptures() throws {
        guard env["REPLAY_TV_RELEASE_MODE"] != "1" else { throw XCTSkip("an unlinked release build files nothing") }
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15))
        // Let the first config fetch arm quick capture.
        Thread.sleep(forTimeInterval: 4)
        XCUIRemote.shared.press(.playPause, forDuration: 1.6)
        XCTAssertTrue(capturedToast.waitForExistence(timeout: 5))
        attachScreenshot("tvOS-quick-capture-toast")
    }

    /// With a teammate's link window open (`REPLAY_TV_EXPECT_BANNER=1`), the
    /// hold shows the matching-number banner, and the remote still moves focus
    /// in the app while it shows.
    func testBannerKeepsFocusInTheApp() throws {
        guard ProcessInfo.processInfo.environment["REPLAY_TV_EXPECT_BANNER"] == "1" else {
            throw XCTSkip("REPLAY_TV_EXPECT_BANNER=1 not supplied")
        }
        app.launch()
        let first = app.cells["poster-0-0"]
        XCTAssertTrue(first.waitForExistence(timeout: 15))
        Thread.sleep(forTimeInterval: 4)
        XCUIRemote.shared.press(.playPause, forDuration: 1.6)
        XCTAssertTrue(app.staticTexts["Linking to Everframe · 47"].waitForExistence(timeout: 8))
        attachScreenshot("tvOS-link-banner")
        XCTAssertTrue(first.hasFocus)
        XCUIRemote.shared.press(.right)
        XCTAssertTrue(app.cells["poster-0-1"].hasFocus)
        XCUIRemote.shared.press(.right)
        XCTAssertTrue(app.cells["poster-0-2"].hasFocus)
        if env["REPLAY_TV_RELEASE_MODE"] == "1" {
            XCTAssertFalse(capturedToast.exists, "a release build only links")
        }
        // The teammate picks the number on the dashboard; the device then says so.
        if env["REPLAY_TV_EXPECT_LINK"] == "1" {
            XCTAssertTrue(app.staticTexts["Linked to TV Tester"].waitForExistence(timeout: 20))
            attachScreenshot("tvOS-linked-toast")
        }
    }

    /// An unlinked release build (`REPLAY_TV_RELEASE_MODE=1`) with no link
    /// window open shows nothing when Play/Pause is held.
    func testReleaseUnlinkedHoldShowsNothing() throws {
        guard env["REPLAY_TV_RELEASE_MODE"] == "1" else { throw XCTSkip("REPLAY_TV_RELEASE_MODE=1 not supplied") }
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15))
        Thread.sleep(forTimeInterval: 4)
        XCUIRemote.shared.press(.playPause, forDuration: 1.6)
        XCTAssertFalse(capturedToast.waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Linking to Everframe · 47"].exists)
    }

    /// Record on device on a linked Apple TV (`REPLAY_TV_EXPECT_RECORDING=1`):
    /// the dashboard asks while the app is in the background; the device
    /// finds out when it returns, records the keys for 10 s and sends them.
    /// `REPLAY_TV_CONTROL_URL` is the test backend's control endpoint that
    /// flags the recording.
    func testRecordOnDevice() throws {
        guard env["REPLAY_TV_EXPECT_RECORDING"] == "1", let control = env["REPLAY_TV_CONTROL_URL"].flatMap(URL.init),
              ["localhost", "127.0.0.1"].contains(control.host ?? "")
        else { throw XCTSkip("REPLAY_TV_EXPECT_RECORDING=1 and REPLAY_TV_CONTROL_URL not supplied") }
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15))
        // Past the 10 s foreground-refresh throttle that starts at launch.
        Thread.sleep(forTimeInterval: 11)
        let flagged = expectation(description: "recording flagged")
        URLSession.shared.dataTask(with: control) { _, _, _ in flagged.fulfill() }.resume()
        wait(for: [flagged], timeout: 5)
        XCUIRemote.shared.press(.home)
        XCTAssertTrue(app.wait(for: .runningBackground, timeout: 10))
        Thread.sleep(forTimeInterval: 2)
        app.activate()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
        XCTAssertTrue(app.staticTexts["Recording remote keys for 10 seconds"].waitForExistence(timeout: 8))
        attachScreenshot("tvOS-recording-toast")
        for button: XCUIRemote.Button in [.up, .up, .down, .down] { XCUIRemote.shared.press(button) }
        XCUIRemote.shared.press(.playPause, forDuration: 1.6)
        XCTAssertFalse(capturedToast.exists, "nothing captures while recording")
        XCTAssertTrue(app.staticTexts["Keys sent to Everframe"].waitForExistence(timeout: 15))
        attachScreenshot("tvOS-keys-sent-toast")
    }

    private var capturedToast: XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Captured ·'")).firstMatch
    }

    private func attachScreenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
