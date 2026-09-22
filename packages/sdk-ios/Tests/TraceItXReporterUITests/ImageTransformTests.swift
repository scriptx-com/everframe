// packages/sdk-ios/Tests/TraceItXReporterUITests/ImageTransformTests.swift
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Testing
import CoreGraphics
@testable import TraceItXReporterUI

struct ImageTransformTests {
    @Test func letterboxedFitCentersAndScales() {
        // 200×100 image in a 400×400 view → scale 2, vertical letterbox 100pt.
        let t = ImageTransform(imageSize: CGSize(width: 200, height: 100), viewSize: CGSize(width: 400, height: 400))
        #expect(t.scale == 2)
        #expect(t.offset == CGPoint(x: 0, y: 100))
        #expect(t.toView(CGPoint(x: 0, y: 0)) == CGPoint(x: 0, y: 100))
        #expect(t.toImage(CGPoint(x: 400, y: 300)) == CGPoint(x: 200, y: 100))
    }

    @Test func roundTripIsIdentity() {
        let t = ImageTransform(imageSize: CGSize(width: 333, height: 777), viewSize: CGSize(width: 390, height: 644))
        let p = CGPoint(x: 123.5, y: 456.25)
        let back = t.toImage(t.toView(p))
        #expect(abs(back.x - p.x) < 0.001 && abs(back.y - p.y) < 0.001)
    }

    @Test func upscaleCapsAtFour() {
        // 40×40 crop in a 400×400 view: uncapped fit would be ×10 — cap at ×4.
        let t = ImageTransform(imageSize: CGSize(width: 40, height: 40), viewSize: CGSize(width: 400, height: 400))
        #expect(t.scale == 4)
        // Centered: (400 − 160)/2 = 120.
        #expect(t.offset == CGPoint(x: 120, y: 120))
    }

    @Test func degenerateSizesYieldIdentity() {
        let t = ImageTransform(imageSize: .zero, viewSize: CGSize(width: 100, height: 100))
        #expect(t.scale == 1 && t.offset == .zero)
    }
}
