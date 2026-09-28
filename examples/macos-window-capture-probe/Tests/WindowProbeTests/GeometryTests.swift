// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
@testable import WindowProbe

final class GeometryTests: XCTestCase {
    func testUniqueWindowRequiresExactProcessAndTitle() {
        let windows = [
            ProbeWindow(id: 1, pid: 10, title: "Everframe probe"),
            ProbeWindow(id: 2, pid: 11, title: "Everframe probe"),
            ProbeWindow(id: 3, pid: 10, title: "Other"),
        ]
        XCTAssertEqual(selectWindow(windows, pid: 10, title: "Everframe probe")?.id, 1)
        XCTAssertNil(selectWindow(windows, pid: 12, title: "Everframe probe"))
        XCTAssertNil(selectWindow(windows + [windows[0]], pid: 10, title: "Everframe probe"))
    }

    func testMaskMapsScaleOneAndTwoWithWindowOffset() {
        let one = PixelRect(x: 40, y: 68, width: 160, height: 80)
        let two = PixelRect(x: 80, y: 136, width: 320, height: 160)
        XCTAssertEqual(maskRect(marker: one, imageWidth: 800, imageHeight: 650), PixelRect(x: 36, y: 164, width: 168, height: 88))
        XCTAssertEqual(maskRect(marker: two, imageWidth: 1600, imageHeight: 1300), PixelRect(x: 76, y: 332, width: 328, height: 168))
    }

    func testResizeAndOffWindowGeometryFailClosed() {
        XCTAssertNotNil(maskRect(marker: PixelRect(x: 48, y: 80, width: 160, height: 80), imageWidth: 1000, imageHeight: 700))
        XCTAssertNil(maskRect(marker: PixelRect(x: 40, y: 500, width: 160, height: 80), imageWidth: 800, imageHeight: 600))
        XCTAssertNil(maskRect(marker: PixelRect(x: 40, y: 68, width: 160, height: 72), imageWidth: 800, imageHeight: 650))
    }
}
