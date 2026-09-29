// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest

final class ComposeProbeUITests: XCTestCase {
    func testComposeHostStartsSharedBridgeAndTransitions() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.staticTexts["Compose screen A"].waitForExistence(timeout: 10))
        app.buttons["Start Everframe"].tap()
        XCTAssertTrue(app.staticTexts["started"].waitForExistence(timeout: 10))
        app.buttons["Next screen"].tap()
        XCTAssertTrue(app.staticTexts["Compose screen B"].waitForExistence(timeout: 10))
        app.buttons["Exercise KMP context"].tap()
        XCTAssertTrue(app.staticTexts["context requested"].waitForExistence(timeout: 10))
    }

    func testComposeHostOpensNativeReporter() {
        let app = XCUIApplication()
        app.launch()
        app.buttons["Start Everframe"].tap()
        XCTAssertTrue(app.staticTexts["started"].waitForExistence(timeout: 10))
        app.buttons["Open native reporter"].tap()
        XCTAssertTrue(app.staticTexts["Report a bug"].waitForExistence(timeout: 10))
        app.buttons["Annotate screenshot, double-tap to open editor"].tap()
        let captured = app.screenshot()
        let (green, magenta) = probeColorCounts(captured.image)
        XCTAssertGreaterThan(green, 5_000, "Compose content should remain readable")
        XCTAssertEqual(magenta, 0, "Sensitive Compose pixels reached the reporter editor")
        let screenshot = XCTAttachment(screenshot: captured)
        screenshot.name = "Compose reporter screenshot editor"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    private func probeColorCounts(_ image: UIImage) -> (green: Int, magenta: Int) {
        guard let cgImage = image.cgImage else { return (0, -1) }
        let width = cgImage.width
        let height = cgImage.height
        let pixels = UnsafeMutablePointer<UInt8>.allocate(capacity: width * height * 4)
        defer { pixels.deallocate() }
        guard let context = CGContext(
            data: pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
        ) else { return (0, -1) }
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
        var green = 0
        var magenta = 0
        for pixel in 0..<(width * height) {
            let index = pixel * 4
            let red = pixels[index]
            let greenChannel = pixels[index + 1]
            let blue = pixels[index + 2]
            if greenChannel >= 220 && red <= 60 && blue <= 60 { green += 1 }
            if red >= 239 && greenChannel <= 16 && blue >= 239 { magenta += 1 }
        }
        return (green, magenta)
    }
}
