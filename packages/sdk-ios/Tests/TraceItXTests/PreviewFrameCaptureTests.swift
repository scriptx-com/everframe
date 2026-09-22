// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Preview-frame capture, and the privacy assertion that matters: sensitive
// rects are baked black BEFORE encode, on the downscale path as well as the
// unscaled one.
//
// TWO THINGS THIS SUITE EXISTS TO AVOID, both found the hard way:
//
// 1. No negative control. The Android twin asserted only that a pixel INSIDE
//    the sensitive rect was black, on a harness that rendered EVERY pixel
//    black because it never rasterized at all. The assertion could not fail,
//    including when the capture was empty. Every masking test here samples an
//    unmasked pixel too.
//
// 2. Testing through `window.drawHierarchy`. That call renders NOTHING — a
//    uniformly black bitmap — unless the window belongs to a foreground-active
//    scene, and a SwiftPM test bundle has NO scenes at all
//    (`UIApplication.shared.connectedScenes` is empty; verified by probe). So
//    these tests drive `renderMasked`'s injected `drawContent` seam, which
//    exercises the real scaling, the real bake ordering and the real encode,
//    with content that actually rasterizes. The window-resolving entry points
//    (`captureKeyWindow`, the zero-argument `capturePreviewFrame`) cannot be
//    unit-tested in this harness and are covered by the manual device gate.
#if canImport(UIKit)
import Testing
import UIKit
@testable import TraceItXKit

@Suite(.serialized)
@MainActor
struct PreviewFrameCaptureTests {

    /// Fills the whole content area white, so any black pixel in the output is
    /// a blackout rect rather than "nothing was drawn".
    private func whiteContent(_ bounds: CGRect) {
        UIColor.white.setFill()
        UIRectFill(bounds)
    }

    private func isNearBlack(_ c: (r: Int, g: Int, b: Int)) -> Bool {
        c.r < 20 && c.g < 20 && c.b < 20
    }

    /// Reads one pixel in TOP-LEFT (UIKit) image coordinates.
    ///
    /// Orientation here was established empirically, not reasoned about, after
    /// two wrong guesses: rendering a known rect at UIKit (50,50)-(150,150)
    /// and dumping the buffer as an ASCII map put it at rows/cols 60..140, so
    /// drawing the whole CGImage into a full-size buffer yields TOP-DOWN rows
    /// and needs no flip. (A 1x1 probe context offset by `-y` behaves the
    /// opposite way — that variant is mirrored, and it is what made an earlier
    /// version of this helper report a masked pixel as white.)
    private func pixel(_ image: UIImage, x: Int, y: Int) -> (r: Int, g: Int, b: Int) {
        guard let cg = image.cgImage else { return (-1, -1, -1) }
        let w = cg.width, h = cg.height
        guard x >= 0, y >= 0, x < w, y < h else { return (-1, -1, -1) }
        var buf = [UInt8](repeating: 0, count: w * h * 4)
        guard let ctx = CGContext(data: &buf, width: w, height: h, bitsPerComponent: 8,
                                  bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return (-1, -1, -1) }
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        let i = (y * w + x) * 4
        return (Int(buf[i]), Int(buf[i + 1]), Int(buf[i + 2]))
    }

    @Test("a masked rect is black and the rest of the frame is not")
    func maskingHasANegativeControl() throws {
        let bounds = CGRect(x: 0, y: 0, width: 400, height: 400)
        let rect = CGRect(x: 50, y: 50, width: 100, height: 100)

        let image = try #require(ScreenshotCapture.renderMasked(
            bounds: bounds, scale: 1, maxEdge: 2048,
            blackoutRects: [rect], drawContent: whiteContent))

        let inside = pixel(image, x: 100, y: 100)
        let outside = pixel(image, x: 300, y: 300)
        #expect(isNearBlack(inside), "inside the rect must be black, got \(inside)")
        #expect(!isNearBlack(outside),
                "outside the rect must NOT be black, got \(outside) — otherwise this suite passes just as happily on a frame that captured nothing")
    }

    @Test("sensitive rects bake before the downscale, not after")
    func bakeHappensBeforeScale() throws {
        // 4096pt against a 2048 cap forces a real 0.5x downscale.
        let bounds = CGRect(x: 0, y: 0, width: 4096, height: 4096)
        let rect = CGRect(x: 1000, y: 1000, width: 1000, height: 1000)

        let image = try #require(ScreenshotCapture.renderMasked(
            bounds: bounds, scale: 1, maxEdge: ScreenshotCapture.MAX_EDGE_PT,
            blackoutRects: [rect], drawContent: whiteContent))

        #expect(image.size.width == ScreenshotCapture.MAX_EDGE_PT, "the fixture must actually downscale")
        // The rect scaled by 0.5 lands at 500..1000; centre (750,750).
        let inside = pixel(image, x: 750, y: 750)
        let outside = pixel(image, x: 150, y: 150)
        #expect(isNearBlack(inside),
                "the masked region must still be black after the downscale, got \(inside) — baking after the scale would blacken a different region entirely")
        #expect(!isNearBlack(outside), "outside the rect must survive the downscale, got \(outside)")
    }

    @Test("the mask lands on the rect, not merely somewhere")
    func maskIsPositionedNotJustPresent() throws {
        // Guards the scaling arithmetic specifically: a bake that used
        // un-downscaled coordinates would blacken 1000..2000 instead of
        // 500..1000, so these probes would come out wrong.
        let bounds = CGRect(x: 0, y: 0, width: 4096, height: 4096)
        let rect = CGRect(x: 1000, y: 1000, width: 1000, height: 1000)

        let image = try #require(ScreenshotCapture.renderMasked(
            bounds: bounds, scale: 1, maxEdge: ScreenshotCapture.MAX_EDGE_PT,
            blackoutRects: [rect], drawContent: whiteContent))

        #expect(isNearBlack(pixel(image, x: 505, y: 505)), "just inside the scaled rect must be black")
        #expect(!isNearBlack(pixel(image, x: 495, y: 495)), "just outside the scaled rect must not be")
        #expect(!isNearBlack(pixel(image, x: 1005, y: 1005)), "past the far edge must not be black")
    }

    @Test("a preview frame is JPEG, carries its own mime, and announces its real size")
    func previewFrameShape() async throws {
        let bounds = CGRect(x: 0, y: 0, width: 1200, height: 2400)
        let image = try #require(ScreenshotCapture.renderMasked(
            bounds: bounds, scale: 1, maxEdge: ScreenshotCapture.PREVIEW_MAX_EDGE_PT,
            blackoutRects: [], drawContent: whiteContent))
        let cg = try #require(image.cgImage)

        let frame = try #require(await ScreenshotCapture.encodePreviewJPEG(cg, quality: 0.6))

        #expect(frame.mime == "image/jpeg")
        #expect(max(frame.width, frame.height) <= Int(ScreenshotCapture.PREVIEW_MAX_EDGE_PT),
                "longest edge \(max(frame.width, frame.height)) must be within the preview cap")
        // The announced dimensions must be the PIXEL dimensions of the bytes.
        let decoded = try #require(UIImage(data: frame.bytes))
        #expect(Int(decoded.size.width) == frame.width)
        #expect(Int(decoded.size.height) == frame.height)
        // JPEG SOI marker.
        #expect(frame.bytes.count > 2)
        #expect(frame.bytes[frame.bytes.startIndex] == 0xFF)
        #expect(frame.bytes[frame.bytes.index(after: frame.bytes.startIndex)] == 0xD8)
    }

    @Test("the mask survives the JPEG encode on the preview path")
    func previewFrameBakesTheMask() async throws {
        // 800pt against a 400 cap: a real 0.5x downscale, then a real encode.
        let bounds = CGRect(x: 0, y: 0, width: 800, height: 800)
        let rect = CGRect(x: 100, y: 100, width: 200, height: 200)
        let image = try #require(ScreenshotCapture.renderMasked(
            bounds: bounds, scale: 1, maxEdge: 400,
            blackoutRects: [rect], drawContent: whiteContent))
        let cg = try #require(image.cgImage)

        let frame = try #require(await ScreenshotCapture.encodePreviewJPEG(cg, quality: 0.9))
        let decoded = try #require(UIImage(data: frame.bytes))

        // Probes chosen to DISCRIMINATE, not merely to be inside/outside the
        // correct rect. Scaled correctly the mask covers 50..150; if the bake
        // used un-downscaled coordinates it would cover 100..300 instead. So:
        //   (60,60)   — inside correct, outside the buggy one → must be black
        //   (250,250) — outside correct, inside the buggy one → must NOT be
        // An earlier version sampled (100,100) and (300,300), which sit the
        // same side of both rects and so passed under the injected defect.
        let inside = pixel(decoded, x: 60, y: 60)
        let outside = pixel(decoded, x: 250, y: 250)
        #expect(isNearBlack(inside), "the masked region must be black in the streamed frame, got \(inside)")
        #expect(!isNearBlack(outside), "an unscaled bake would have blackened this pixel, got \(outside)")
    }

    @Test("a zero-size window degrades to nil rather than throwing")
    func zeroSizeDegrades() throws {
        #expect(ScreenshotCapture.renderMasked(
            bounds: .zero, scale: 1, maxEdge: 2048,
            blackoutRects: [], drawContent: whiteContent) == nil)
    }
}
#endif
