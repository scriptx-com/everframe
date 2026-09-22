// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import UIKit
#if canImport(WebKit)
import WebKit
#endif
import AVFoundation
import MetalKit
import SwiftUI
import Testing
@testable import TraceItXKit

@MainActor @Suite(.serialized)
struct NativeVideoCaptureTests {
    @Test(arguments: [false, true], [false, true])
    func zoomedOutOversizedDrawingUsesScreenPixelDensity(rotated: Bool, nonuniform: Bool) async throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 640, height: 640))
        window.backgroundColor = .white; window.isHidden = false
        defer { window.isHidden = true }
        let parent = CALayer()
        parent.anchorPoint = .zero
        parent.bounds = CGRect(x: 0, y: 0, width: 6000, height: 6000)
        let verticalScale: CGFloat = nonuniform ? 0.05 : 0.1
        parent.position = CGPoint(x: rotated ? 600 : 0, y: 0)
        parent.setAffineTransform(rotated ?
            CGAffineTransform(a: 0, b: 0.1, c: -verticalScale, d: 0, tx: 0, ty: 0) :
            CGAffineTransform(scaleX: 0.1, y: verticalScale))
        window.layer.addSublayer(parent)
        let drawing = OversizedDrawingLayer()
        drawing.frame = parent.bounds
        parent.addSublayer(drawing)
        let frame = try #require(await NativeVideoCapture().capture(window: window, timestampNanos: 1))
        let redY = nonuniform ? 50 : 100
        let blueY = nonuniform ? 250 : 500
        #expect(pixel(frame, rotated ? 600 - redY : 300, rotated ? 300 : redY) == [0, 0, 255, 255])
        #expect(pixel(frame, rotated ? 600 - blueY : 300, rotated ? 300 : blueY) == [255, 0, 0, 255])
        #expect(!drawing.rasterSizes.isEmpty)
        #expect(drawing.rasterSizes.allSatisfy { $0.width <= 601 && $0.height <= (nonuniform ? 301 : 601) })
    }

    @Test(arguments: [false, true])
    func zoomedOutDrawingPreservesDiagonalRotationAndShear(sheared: Bool) async throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 640, height: 640))
        window.backgroundColor = .white; window.isHidden = false
        defer { window.isHidden = true }
        let drawing = OversizedDrawingLayer()
        drawing.bounds = CGRect(x: 0, y: 0, width: 6000, height: 6000)
        drawing.anchorPoint = .zero
        drawing.position = CGPoint(x: sheared ? 0 : 320, y: 0)
        drawing.setAffineTransform(sheared ?
            CGAffineTransform(a: 0.05, b: 0.02, c: 0.03, d: 0.04, tx: 0, ty: 0) :
            CGAffineTransform(rotationAngle: .pi / 4).scaledBy(x: 0.05, y: 0.05))
        window.layer.addSublayer(drawing)
        let frame = try #require(await NativeVideoCapture().capture(window: window, timestampNanos: 1))
        #expect(pixel(frame, sheared ? 180 : 391, sheared ? 100 : 141) == [0, 0, 255, 255])
        #expect(pixel(frame, sheared ? 300 : 249, sheared ? 260 : 282) == [255, 0, 0, 255])
        #expect(!drawing.rasterSizes.isEmpty)
        #expect(drawing.rasterSizes.allSatisfy { $0.width <= 426 && $0.height <= 426 })
    }

    @Test func ancestorZoomChangesMatchFreshTemplateRaster() async throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 640, height: 640))
        window.backgroundColor = .white; window.isHidden = false
        defer { window.isHidden = true }
        let parent = UIView(frame: CGRect(x: 0, y: 0, width: 6000, height: 6000))
        parent.layer.anchorPoint = .zero; parent.layer.position = .zero
        window.addSubview(parent)
        let image = UIGraphicsImageRenderer(size: CGSize(width: 16, height: 16)).image { context in
            UIColor.white.setFill()
            context.cgContext.fillEllipse(in: CGRect(x: 0.3, y: 0.7, width: 14.2, height: 14.6))
        }.withRenderingMode(.alwaysTemplate)
        let view = UIImageView(image: image)
        view.frame = parent.bounds; view.tintColor = .red
        parent.addSubview(view); view.layer.displayIfNeeded()
        let capture = NativeVideoCapture()
        for transform in [CGAffineTransform(scaleX: 0.1, y: 0.1),
                          CGAffineTransform(scaleX: 0.05, y: 0.05),
                          CGAffineTransform(scaleX: 0.1, y: 0.05),
                          CGAffineTransform(scaleX: 0.1, y: 0.08)] {
            parent.layer.setAffineTransform(transform)
            let reused = try #require(await capture.capture(window: window, timestampNanos: 1))
            let fresh = try #require(await NativeVideoCapture().capture(window: window, timestampNanos: 1))
            #expect(reused.bgraBytes == fresh.bgraBytes)
            #expect(pixel(reused, 150, 150) == [0, 0, 255, 255])
        }
    }

    @Test(arguments: [CGFloat(0), CGFloat(100)], [false, true])
    func oversizedScrolledDrawingCapturesVisiblePixelsWithBoundedRaster(boundsOrigin: CGFloat,
                                                                       scaled: Bool) async throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 64, height: 64))
        window.backgroundColor = .white; window.isHidden = false
        defer { window.isHidden = true }
        let scroll = UIScrollView(frame: window.bounds)
        scroll.contentSize = CGSize(width: 64, height: 6000)
        window.addSubview(scroll)
        let drawing = OversizedDrawingLayer()
        drawing.frame = CGRect(x: 0, y: 0, width: 64, height: 6000)
        drawing.bounds.origin.y = boundsOrigin
        scroll.layer.addSublayer(drawing)
        if scaled {
            scroll.layer.anchorPoint = .zero
            scroll.layer.position = .zero
            scroll.layer.setAffineTransform(CGAffineTransform(scaleX: 1, y: 0.5))
            scroll.bounds.size.height = 128
        }
        scroll.contentOffset = CGPoint(x: 0, y: 4500)
        let capture = NativeVideoCapture()
        let frame = try #require(await capture.capture(window: window, timestampNanos: 1))
        #expect(pixel(frame, 32, 8) == [0, 0, 255, 255])
        #expect(pixel(frame, 32, 48) == [255, 0, 0, 255])
        #expect(drawing.rasterSizes.allSatisfy { $0.width <= 64 && $0.height <= (scaled ? 128 : 64) })
        #expect(!drawing.rasterSizes.isEmpty)
        scroll.contentOffset = CGPoint(x: 0, y: 4532)
        let scrolled = try #require(await capture.capture(window: window, timestampNanos: 2))
        #expect(pixel(scrolled, 32, 8) == [255, 0, 0, 255])
    }
    @Test func oversizedTemplatePreservesMaskAndInvalidatesCropAfterScrolling() async throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 64, height: 64))
        window.backgroundColor = .white; window.isHidden = false
        defer { window.isHidden = true }
        let scroll = UIScrollView(frame: window.bounds)
        scroll.contentSize = CGSize(width: 64, height: 6000)
        window.addSubview(scroll)
        let image = UIGraphicsImageRenderer(size: CGSize(width: 2, height: 2)).image {
            UIColor.white.setFill(); $0.fill(CGRect(x: 0, y: 0, width: 2, height: 2))
        }.withRenderingMode(.alwaysTemplate)
        let view = UIImageView(image: image)
        view.frame = CGRect(x: 0, y: 0, width: 64, height: 6000)
        view.tintColor = .red
        scroll.addSubview(view)
        let mask = CAShapeLayer()
        mask.path = CGPath(rect: CGRect(x: 0, y: 4500, width: 32, height: 32), transform: nil)
        view.layer.mask = mask
        view.layer.displayIfNeeded()
        scroll.contentOffset.y = 4500
        let capture = NativeVideoCapture()
        for time in 1...2 {
            let frame = try #require(await capture.capture(window: window, timestampNanos: UInt64(time)))
            #expect(pixel(frame, 16, 16) == [0, 0, 255, 255])
            #expect(pixel(frame, 48, 16) == [255, 255, 255, 255])
            #expect(pixel(frame, 16, 48) == [255, 255, 255, 255])
        }
        scroll.contentOffset.y = 4532
        let scrolled = try #require(await capture.capture(window: window, timestampNanos: 3))
        #expect(pixel(scrolled, 16, 16) == [255, 255, 255, 255])
        SensitiveRectRegistry.mark(view)
        let privateFrame = try #require(await capture.capture(window: window, timestampNanos: 4))
        #expect(pixel(privateFrame, 16, 16) == [0, 0, 0, 255])
    }

    @Test func secureTextAndMetalAreOpaque() async throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 64, height: 64))
        window.backgroundColor = .white; window.isHidden = false
        defer { window.isHidden = true }
        let field = UITextField(frame: CGRect(x: 0, y: 0, width: 32, height: 64))
        field.isSecureTextEntry = true; field.text = "never capture"; field.backgroundColor = .red
        window.addSubview(field)
        let metal = MTKView(frame: CGRect(x: 32, y: 0, width: 32, height: 64))
        metal.isPaused = true; metal.backgroundColor = .red; window.addSubview(metal)
        let frame = try #require(await NativeVideoCapture().capture(window: window, timestampNanos: 1))
        #expect(pixel(frame, 16, 32) == [0, 0, 0, 255])
        #expect(pixel(frame, 48, 32) == [0, 0, 0, 255])
    }

    @Test func markedSwiftUIHostIsOpaque() async throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 64, height: 64))
        let host = UIHostingController(rootView: Color.red.overlay(Text("private")))
        window.rootViewController = host; window.isHidden = false
        defer { window.isHidden = true }
        host.view.frame = window.bounds; host.view.layoutIfNeeded()
        SensitiveRectRegistry.mark(host.view)
        let frame = try #require(await NativeVideoCapture().capture(window: window, timestampNanos: 1))
        #expect(pixel(frame, 32, 32) == [0, 0, 0, 255])
    }

    @Test func markingAfterTemplateReuseCannotExposeCachedImage() async throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 64, height: 64))
        window.backgroundColor = .white; window.isHidden = false
        defer { window.isHidden = true }
        let image = UIGraphicsImageRenderer(size: CGSize(width: 32, height: 32)).image {
            UIColor.white.setFill(); $0.fill(CGRect(x: 0, y: 0, width: 32, height: 32))
        }.withRenderingMode(.alwaysTemplate)
        let view = UIImageView(image: image); view.tintColor = .red
        view.frame = CGRect(x: 16, y: 16, width: 32, height: 32)
        window.addSubview(view); view.layer.displayIfNeeded()
        let capture = NativeVideoCapture()
        for time in 1...2 {
            let frame = try #require(await capture.capture(window: window, timestampNanos: UInt64(time)))
            #expect(pixel(frame, 32, 32) == [0, 0, 255, 255])
        }
        SensitiveRectRegistry.mark(view)
        let masked = try #require(await capture.capture(window: window, timestampNanos: 3))
        for y in 16..<48 { for x in 16..<48 {
            #expect(pixel(masked, x, y) == [0, 0, 0, 255])
        } }
    }

    @Test func dimensionsFollowRotationWithoutExceedingMaximumEdge() async throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 430, height: 932))
        window.isHidden = false
        defer { window.isHidden = true }
        let capture = NativeVideoCapture()
        let portrait = try #require(await capture.capture(window: window, timestampNanos: 1))
        #expect(portrait.width == 394); #expect(portrait.height == 854)
        window.bounds = CGRect(x: 0, y: 0, width: 932, height: 430)
        let landscape = try #require(await capture.capture(window: window, timestampNanos: 2))
        #expect(landscape.width == 854); #expect(landscape.height == 394)
    }

    @Test func sensitiveOverflowIsMasked() async throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 64, height: 64))
        window.backgroundColor = .white; window.isHidden = false
        defer { window.isHidden = true }
        let parent = TXSensitiveView(frame: CGRect(x: 0, y: 0, width: 8, height: 8))
        let child = UIView(frame: CGRect(x: 16, y: 16, width: 32, height: 32))
        child.backgroundColor = .red; parent.addSubview(child); window.addSubview(parent)
        let frame = try #require(await NativeVideoCapture().capture(window: window, timestampNanos: 1))
        #expect(pixel(frame, 32, 32) == [0, 0, 0, 255])
    }
    private func pixel(_ frame: NativeVideoFrame, _ x: Int, _ y: Int) -> [UInt8] {
        let index = y * frame.bytesPerRow + x * 4
        return Array(frame.bgraBytes[index..<index + 4])
    }
    @Test func visibleThenSensitive() async throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 64, height: 64))
        window.backgroundColor = .white; window.isHidden = false
        defer { window.isHidden = true }
        let view = UIView(frame: CGRect(x: 16, y: 16, width: 32, height: 32))
        view.backgroundColor = .red; window.addSubview(view)
        let capture = NativeVideoCapture()
        let first = try #require(await capture.capture(window: window, timestampNanos: 123))
        #expect(pixel(first, first.width / 2, first.height / 2) == [0, 0, 255, 255])
        SensitiveRectRegistry.mark(view)
        let masked = try #require(await capture.capture(window: window, timestampNanos: 456))
        #expect(pixel(masked, masked.width / 2, masked.height / 2) == [0, 0, 0, 255])
        #expect(masked.timestampNanos == 456)
    }
    #if canImport(WebKit)
    @Test func webAndVideoAreExcluded() async throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 64, height: 64))
        window.backgroundColor = .white; window.isHidden = false
        defer { window.isHidden = true }
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 32, height: 64))
        window.addSubview(web)
        let video = AVPlayerLayer(); video.frame = CGRect(x: 32, y: 0, width: 32, height: 64)
        video.backgroundColor = UIColor.red.cgColor; window.layer.addSublayer(video)
        let frame = try #require(await NativeVideoCapture().capture(window: window, timestampNanos: 1))
        #expect(pixel(frame, frame.width / 4, frame.height / 2) == [0, 0, 0, 255])
        #expect(pixel(frame, frame.width * 3 / 4, frame.height / 2) == [0, 0, 0, 255])
    }
    #endif
    @Test func sampleBufferVideoSurfaceIsExplicitlyMasked() async throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 64, height: 64))
        window.backgroundColor = .white; window.isHidden = false
        defer { window.isHidden = true }
        let video = AVSampleBufferDisplayLayer()
        video.frame = CGRect(x: 16, y: 16, width: 32, height: 32)
        video.backgroundColor = UIColor.red.cgColor
        window.layer.addSublayer(video)
        let privacy = try NativeVideoPrivacy.collect(window: window)
        #expect(privacy.excludedLayers.contains(ObjectIdentifier(video)))
        let frame = try #require(await NativeVideoCapture().capture(window: window, timestampNanos: 1))
        #expect(pixel(frame, 32, 32) == [0, 0, 0, 255])
        #expect(pixel(frame, 4, 4) == [255, 255, 255, 255])
    }
    @Test func hiddenAncestorDoesNotDrawDescendants() async throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 64, height: 64))
        window.backgroundColor = .white; window.isHidden = false
        defer { window.isHidden = true }
        let parent = UIView(frame: window.bounds); parent.alpha = 0
        let child = UIView(frame: parent.bounds); child.backgroundColor = .red
        parent.addSubview(child); window.addSubview(parent)
        let capture = NativeVideoCapture()
        let first = try #require(await capture.capture(window: window, timestampNanos: 1))
        #expect(pixel(first, first.width / 2, first.height / 2) == [255, 255, 255, 255])
        parent.alpha = 1
        let second = try #require(await capture.capture(window: window, timestampNanos: 2))
        #expect(pixel(second, second.width / 2, second.height / 2) == [0, 0, 255, 255])
    }
}

private final class OversizedDrawingLayer: CALayer {
    var rasterSizes: [CGSize] = []

    override func render(in context: CGContext) {
        rasterSizes.append(CGSize(width: context.width, height: context.height))
        context.setFillColor(UIColor.red.cgColor)
        context.fill(bounds)
        context.setFillColor(UIColor.blue.cgColor)
        context.fill(CGRect(x: 0, y: bounds.minY + 4532, width: bounds.width, height: 1468))
    }
}
#endif
