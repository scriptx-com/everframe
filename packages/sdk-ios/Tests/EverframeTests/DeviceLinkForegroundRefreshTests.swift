// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
@testable import EverframeKit

/// A linked Apple TV fetches its config when the app comes to the
/// foreground, at most every 10 s, so a Record on device request reaches it.
final class DeviceLinkForegroundRefreshTests: XCTestCase {
    private let foregroundName = Notification.Name("evf.test.foreground")
    private var center: NotificationCenter!
    private var now: TimeInterval = 0
    private var linked = true
    private var refreshes = 0
    private var refresher: DeviceLinkForegroundRefresh!

    override func setUp() {
        center = NotificationCenter()
        now = 1000
        linked = true
        refreshes = 0
        refresher = DeviceLinkForegroundRefresh(
            center: center, name: foregroundName, now: { [unowned self] in self.now },
            isLinked: { [unowned self] in self.linked }, refresh: { [unowned self] in self.refreshes += 1 })
    }

    override func tearDown() {
        refresher.remove()
    }

    private func foreground(at time: TimeInterval) {
        now = time
        center.post(name: foregroundName, object: nil)
    }

    func testForegroundRefreshesWhileLinked() {
        refresher.install()
        foreground(at: 1011)
        XCTAssertEqual(refreshes, 1)
        foreground(at: 1030)
        XCTAssertEqual(refreshes, 2)
    }

    func testThrottledToTenSecondsFromInstall() {
        refresher.install()
        foreground(at: 1005)
        XCTAssertEqual(refreshes, 0, "the launch already fetched")
        foreground(at: 1010)
        XCTAssertEqual(refreshes, 1)
        foreground(at: 1019.9)
        XCTAssertEqual(refreshes, 1)
        foreground(at: 1020)
        XCTAssertEqual(refreshes, 2)
    }

    func testUnlinkedNeverRefreshes() {
        linked = false
        refresher.install()
        foreground(at: 1100)
        XCTAssertEqual(refreshes, 0)
    }

    func testRemoveStopsRefreshing() {
        refresher.install()
        refresher.remove()
        foreground(at: 1100)
        XCTAssertEqual(refreshes, 0)
        refresher.install()
        refresher.install()
        foreground(at: 1200)
        XCTAssertEqual(refreshes, 1, "installing twice observes once")
    }
}
