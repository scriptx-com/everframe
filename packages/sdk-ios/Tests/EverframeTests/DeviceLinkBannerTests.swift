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
    private var appWindow: UIWindow?

    override func tearDown() async throws {
        ScreenshotCapture.__windowsOverrideForTesting = nil
        DeviceLinkBanner.hide()
        DeviceLinkBanner.__windowFactoryForTesting = nil
        QuickCaptureToast.__windowFactoryForTesting = nil
        QuickCaptureToast.__dismissForTesting()
        appWindow?.isHidden = true
        appWindow = nil
    }

    /// The test bundle has no foreground scene: overlays are created from a frame.
    private func useFrameWindows() {
        DeviceLinkBanner.__windowFactoryForTesting = { EFDeviceLinkBannerWindow(frame: UIScreen.main.bounds) }
        QuickCaptureToast.__windowFactoryForTesting = { EFQuickCaptureToastWindow(frame: UIScreen.main.bounds) }
    }

    /// A key app window whose root offers a focusable button.
    private func makeAppWindow() -> UIWindow {
        let window = UIWindow(frame: UIScreen.main.bounds)
        let root = UIViewController()
        let button = UIButton(type: .system)
        button.setTitle("Play", for: .normal)
        button.frame = CGRect(x: 100, y: 100, width: 300, height: 100)
        root.view.addSubview(button)
        window.rootViewController = root
        window.makeKeyAndVisible()
        appWindow = window
        return window
    }

    private func labels(in view: UIView) -> [UILabel] {
        ((view as? UILabel).map { [$0] } ?? []) + view.subviews.flatMap { labels(in: $0) }
    }

    private func allViews(in view: UIView) -> [UIView] {
        [view] + view.subviews.flatMap { allViews(in: $0) }
    }

    private func assertNeverTakesFocus(_ overlay: UIWindow?, app: UIWindow, file: StaticString = #filePath,
                                       line: UInt = #line) {
        guard let overlay else { return XCTFail("no overlay window", file: file, line: line) }
        XCTAssertFalse(overlay.isKeyWindow, file: file, line: line)
        XCTAssertFalse(overlay.canBecomeKey, file: file, line: line)
        XCTAssertTrue(app.isKeyWindow, file: file, line: line)
        XCTAssertFalse(overlay.isUserInteractionEnabled, file: file, line: line)
        let root = overlay.rootViewController
        XCTAssertTrue(root is EFOverlayRootViewController, file: file, line: line)
        XCTAssertTrue(root?.preferredFocusEnvironments.isEmpty ?? false, file: file, line: line)
        for view in allViews(in: overlay) {
            XCTAssertFalse(view.canBecomeFocused, "\(type(of: view))", file: file, line: line)
        }
    }

    func testOverlayStyles() {
        XCTAssertEqual(OverlayStyle.phone, OverlayStyle(
            titleSize: 15, sublineSize: 13, toastSize: 15, topInset: 12, bottomInset: 24,
            hPadding: 16, vPadding: 10, cornerRadius: 16, maxWidth: nil))
        XCTAssertEqual(OverlayStyle.tv.titleSize, 38)
        XCTAssertEqual(OverlayStyle.tv.maxWidth, 1200)
        #if os(tvOS)
        XCTAssertEqual(OverlayStyle.current, .tv)
        #else
        XCTAssertEqual(OverlayStyle.current, .phone)
        #endif
    }

    func testBannerUsesTheCurrentStyle() throws {
        useFrameWindows()
        DeviceLinkBanner.show(number: 47)
        let window = try XCTUnwrap(DeviceLinkBanner.__windowForTesting)
        let found = labels(in: window)
        let title = try XCTUnwrap(found.first { $0.text == "Linking to Everframe · 47" })
        let subline = try XCTUnwrap(found.first { $0.text == DeviceLinkBanner.subtitle })
        XCTAssertEqual(title.font.pointSize, OverlayStyle.current.titleSize)
        XCTAssertEqual(subline.font.pointSize, OverlayStyle.current.sublineSize)
        #if os(tvOS)
        XCTAssertEqual(title.font.pointSize, 38)
        XCTAssertEqual(subline.font.pointSize, 29)
        #else
        XCTAssertEqual(title.font.pointSize, 15)
        XCTAssertEqual(subline.font.pointSize, 13)
        #endif
    }

    func testBannerNeverTakesFocus() {
        let app = makeAppWindow()
        XCTAssertTrue(app.isKeyWindow)
        useFrameWindows()
        DeviceLinkBanner.show(number: 47)
        XCTAssertTrue(DeviceLinkBanner.isShowing)
        assertNeverTakesFocus(DeviceLinkBanner.__windowForTesting, app: app)
        DeviceLinkBanner.hide()
        XCTAssertTrue(app.isKeyWindow)
    }

    func testToastNeverTakesFocus() throws {
        let app = makeAppWindow()
        useFrameWindows()
        QuickCaptureToast.show(text: "Captured · TV Tester")
        let window = try XCTUnwrap(QuickCaptureToast.__windowForTesting)
        assertNeverTakesFocus(window, app: app)
        let label = try XCTUnwrap(labels(in: window).first { $0.text == "Captured · TV Tester" })
        XCTAssertEqual(label.font.pointSize, OverlayStyle.current.toastSize)
        QuickCaptureToast.__dismissForTesting()
        XCTAssertTrue(app.isKeyWindow)
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
