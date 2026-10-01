// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import AppKit
import XCTest
@testable import WindowProbe

final class SafeFrameTests: XCTestCase {
    private func source(extraSecret: Bool = false, state: String = "a") -> CGImage {
        let context = CGContext(data: nil, width: 800, height: 600,
                                bitsPerComponent: 8, bytesPerRow: 800 * 4,
                                space: CGColorSpaceCreateDeviceRGB(),
                                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        func tile(_ rect: PixelRect, _ color: NSColor) {
            context.setFillColor(color.cgColor)
            context.fill(CGRect(x: rect.x, y: 600 - rect.maxY,
                                width: rect.width, height: rect.height))
        }
        tile(PixelRect(x: 0, y: 0, width: 800, height: 600), .white)
        tile(PixelRect(x: 40, y: 68, width: 160, height: 80),
             state == "a" ? NSColor(calibratedRed: 0, green: 0.8, blue: 0, alpha: 1) :
                 NSColor(calibratedRed: 0, green: 0.4, blue: 1, alpha: 1))
        tile(PixelRect(x: 40, y: 168, width: 160, height: 80), .magenta)
        tile(PixelRect(x: 40, y: 268, width: 160, height: 80),
             NSColor(srgbRed: 1, green: 136.0 / 255.0, blue: 0, alpha: 1))
        if extraSecret { tile(PixelRect(x: 300, y: 300, width: 2, height: 2), .magenta) }
        return context.makeImage()!
    }

    func testMasksBeforeEncodingAndMeasuresNativeTile() throws {
        let (png, metrics) = try validatedPng(image: source(), state: "a")
        XCTAssertEqual(metrics.publicCoverage, 1, accuracy: 0.01)
        XCTAssertEqual(metrics.sensitiveCoverage, 1, accuracy: 0.01)
        XCTAssertEqual(metrics.nativeCoverage, 1, accuracy: 0.01)
        let decoded = NSBitmapImageRep(data: png)!
        XCTAssertEqual(Double(decoded.colorAt(x: 48, y: 176)!.redComponent), 0, accuracy: 0.01)
    }

    func testRejectsSecretOutsideMaskAndWrongState() {
        XCTAssertThrowsError(try validatedPng(image: source(extraSecret: true), state: "a"))
        XCTAssertThrowsError(try validatedPng(image: source(), state: "b"))
    }
}
