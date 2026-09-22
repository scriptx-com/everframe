// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// PRIV-03 bake-order lock: redactions land FIRST as opaque black, then all
// other shapes in array order. Pixel-equality assertions on a 100×100 white
// source at scale 1.
import Testing
import Foundation
#if canImport(UIKit) && !os(tvOS)
import UIKit
@testable import TraceItXReporterUI
#endif

@MainActor
struct BakeRendererTests {
    #if canImport(UIKit) && !os(tvOS)
    private func makeWhiteImage() -> UIImage {
        let format = UIGraphicsImageRendererFormat.preferred()
        format.scale = 1.0
        format.opaque = true
        let r = UIGraphicsImageRenderer(size: CGSize(width: 100, height: 100), format: format)
        return r.image { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 100, height: 100))
        }
    }

    /// Redraws into a bitmap context with a KNOWN byte order
    /// (premultipliedLast == RGBA) so component order is unambiguous
    /// regardless of the baked image's native CGImage layout. This is the
    /// same resolution strategy the pre-rewrite `sample()` helper used.
    private func pixel(_ image: UIImage, _ x: Int, _ y: Int) -> (r: UInt8, g: UInt8, b: UInt8) {
        let cg = image.cgImage!
        let w = cg.width, h = cg.height
        let bytesPerRow = w * 4
        var pixels = [UInt8](repeating: 0, count: bytesPerRow * h)
        let cs = CGColorSpaceCreateDeviceRGB()
        let ctx = CGContext(
            data: &pixels,
            width: w, height: h,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: cs,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        let i = (y * bytesPerRow) + (x * 4)
        return (pixels[i], pixels[i + 1], pixels[i + 2])
    }

    @Test func redactionBakesOpaqueBlack() {
        let baked = BakeRenderer.bake(
            source: makeWhiteImage(),
            annotations: [Annotation.blur(x: 10, y: 10, width: 30, height: 30)]
        )
        let p = pixel(baked, 25, 25)
        #expect(p.r == 0 && p.g == 0 && p.b == 0)          // solid black, not blurred
        let outside = pixel(baked, 80, 80)
        #expect(outside.r == 255)
    }

    @Test func redactionsBakeBeforeShapesRegardlessOfArrayOrder() {
        // Pen stroke listed BEFORE the redaction still paints ON TOP of it.
        let pen = Annotation.pen(points: [0, 25, 99, 25], color: 0xFFFF3B30, thickness: 6)
        let redact = Annotation.blur(x: 0, y: 0, width: 100, height: 50)
        let baked = BakeRenderer.bake(source: makeWhiteImage(), annotations: [pen, redact])
        let p = pixel(baked, 50, 25)
        #expect(p.r > 200 && p.g < 100)                     // red stroke visible over black
    }

    @Test func highlighterIsTranslucentWide() {
        let hl = Annotation.highlighter(points: [0, 50, 99, 50], color: 0xFFFFCC00, thickness: 4)
        let baked = BakeRenderer.bake(source: makeWhiteImage(), annotations: [hl])
        let p = pixel(baked, 50, 50)
        // 45% yellow over white: red stays high, blue drops but NOT to zero.
        #expect(p.b > 100 && p.b < 220)
    }

    @Test func textBakesPixels() {
        let t = Annotation.text(x: 10, y: 40, text: "BUG", color: 0xFF000000, fontSize: 24)
        let baked = BakeRenderer.bake(source: makeWhiteImage(), annotations: [t])
        // At least one non-white pixel in the text's bounding area.
        var found = false
        for x in 10..<80 where !found {
            for y in 40..<75 where !found {
                let p = pixel(baked, x, y)
                if p.r < 200 { found = true }
            }
        }
        #expect(found)
    }
    #endif
}
