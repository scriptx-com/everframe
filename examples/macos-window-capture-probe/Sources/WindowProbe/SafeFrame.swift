// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import AppKit

enum SafeFrameError: Error {
    case missingMarker
    case unsafeGeometry
    case secretPixel
    case encodingFailed
}

struct FrameMetrics {
    let width: Int
    let height: Int
    let publicCoverage: Double
    let sensitiveCoverage: Double
    let nativeCoverage: Double
}

/// All operations on the raw frame happen in memory. Only the returned PNG may be persisted.
func validatedPng(image: CGImage, state: String) throws -> (Data, FrameMetrics) {
    let bitmap = NSBitmapImageRep(cgImage: image)
    let width = bitmap.pixelsWide
    let height = bitmap.pixelsHigh
    guard let marker = publicMarker(in: bitmap, state: state),
          let mask = maskRect(marker: marker, imageWidth: width, imageHeight: height) else {
        throw SafeFrameError.missingMarker
    }
    // Check that the marker geometry is plausible before touching the raw frame.
    guard marker.width >= 80, marker.height >= 40 else { throw SafeFrameError.unsafeGeometry }
    let black = NSColor(calibratedRed: 0, green: 0, blue: 0, alpha: 1)
    for y in mask.y..<mask.maxY {
        for x in mask.x..<mask.maxX { bitmap.setColor(black, atX: x, y: y) }
    }
    for y in 0..<height {
        for x in 0..<width {
            if matches(bitmap.colorAt(x: x, y: y), red: 255, green: 0, blue: 255) {
                throw SafeFrameError.secretPixel
            }
        }
    }
    let metrics = FrameMetrics(
        width: width,
        height: height,
        publicCoverage: coverage(bitmap, rect: inset(marker, 8), color: state == "a" ? (0, 204, 0) : (0, 102, 255)),
        sensitiveCoverage: coverage(bitmap, rect: inset(mask, 8), color: (0, 0, 0)),
        nativeCoverage: coverage(bitmap, rect: PixelRect(x: marker.x + 8, y: marker.y + Int((200.0 * Double(marker.height) / 80.0).rounded()) + 8,
                                                         width: marker.width - 16, height: marker.height - 16),
                                 color: (255, 136, 0))
    )
    guard let png = bitmap.representation(using: .png, properties: [:]) else {
        throw SafeFrameError.encodingFailed
    }
    return (png, metrics)
}

private func publicMarker(in bitmap: NSBitmapImageRep, state: String) -> PixelRect? {
    let color = state == "a" ? (0, 204, 0) : (0, 102, 255)
    var minX = bitmap.pixelsWide
    var minY = bitmap.pixelsHigh
    var maxX = -1
    var maxY = -1
    var count = 0
    for y in 0..<bitmap.pixelsHigh {
        for x in 0..<bitmap.pixelsWide where matches(bitmap.colorAt(x: x, y: y), red: color.0, green: color.1, blue: color.2) {
            minX = min(minX, x); minY = min(minY, y)
            maxX = max(maxX, x); maxY = max(maxY, y)
            count += 1
        }
    }
    guard maxX >= minX, maxY >= minY else { return nil }
    let rect = PixelRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1)
    guard Double(count) / Double(rect.width * rect.height) >= 0.95 else { return nil }
    return rect
}

private func matches(_ color: NSColor?, red: Int, green: Int, blue: Int) -> Bool {
    guard let rgb = color?.usingColorSpace(.deviceRGB) else { return false }
    return abs(Int((rgb.redComponent * 255).rounded()) - red) <= 12 &&
        abs(Int((rgb.greenComponent * 255).rounded()) - green) <= 12 &&
        abs(Int((rgb.blueComponent * 255).rounded()) - blue) <= 12 && rgb.alphaComponent >= 0.95
}

private func inset(_ rect: PixelRect, _ amount: Int) -> PixelRect {
    PixelRect(x: rect.x + amount, y: rect.y + amount, width: rect.width - amount * 2,
              height: rect.height - amount * 2)
}

private func coverage(_ bitmap: NSBitmapImageRep, rect: PixelRect, color: (Int, Int, Int)) -> Double {
    guard rect.x >= 0, rect.y >= 0, rect.width > 0, rect.height > 0,
          rect.maxX <= bitmap.pixelsWide, rect.maxY <= bitmap.pixelsHigh else { return 0 }
    var count = 0
    for y in rect.y..<rect.maxY {
        for x in rect.x..<rect.maxX where matches(bitmap.colorAt(x: x, y: y), red: color.0, green: color.1, blue: color.2) {
            count += 1
        }
    }
    return Double(count) / Double(rect.width * rect.height)
}
