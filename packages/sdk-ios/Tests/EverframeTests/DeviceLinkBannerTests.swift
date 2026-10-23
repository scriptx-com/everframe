// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The matching-number banner. UIKit-gated: runs in a simulator.
#if canImport(UIKit)
import UIKit
import XCTest
@testable import EverframeKit

@MainActor
final class DeviceLinkBannerTests: XCTestCase {
    override func tearDown() async throws {
        ScreenshotCapture.__windowsOverrideForTesting = nil
        DeviceLinkBanner.hide()
    }

    func testCopy() {
        XCTAssertEqual(DeviceLinkBanner.title(number: 47), "Linking to Everframe · 47")
        XCTAssertEqual(DeviceLinkBanner.title(number: 7), "Linking to Everframe · 7")
        XCTAssertEqual(DeviceLinkBanner.title(number: 0), "Linking to Everframe · 0")
        XCTAssertEqual(DeviceLinkBanner.subtitle, "A teammate is linking a device. If that's not you, ignore this.")
    }

    func testBannerWindowExcludedFromScreenshot() {
        let host = UIWindow(frame: CGRect(x: 0, y: 0, width: 120, height: 200))
        host.isHidden = false
        let banner = EFDeviceLinkBannerWindow(frame: CGRect(x: 0, y: 0, width: 120, height: 40))
        banner.windowLevel = .normal - 1
        banner.isHidden = false
        defer {
            banner.isHidden = true
            host.isHidden = true
        }

        // Alone, the banner is never the capture target.
        ScreenshotCapture.__windowsOverrideForTesting = [banner]
        XCTAssertNil(ScreenshotCapture.activeKeyWindow())

        // Even below the host window's level, listed first, the host wins.
        ScreenshotCapture.__windowsOverrideForTesting = [banner, host]
        XCTAssertTrue(ScreenshotCapture.activeKeyWindow() === host)
    }

    /// A test bundle has no foreground scene: show and hide must be safe no-ops.
    func testShowAndHideWithoutASceneAreSafe() {
        DeviceLinkBanner.show(number: 12)
        DeviceLinkBanner.show(number: 13)
        DeviceLinkBanner.hide()
        DeviceLinkBanner.hide()
        XCTAssertFalse(DeviceLinkBanner.isShowing)
    }
}
#endif
