// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Testing
#if canImport(UIKit)
import UIKit
#endif
@testable import TraceItXKit

@MainActor
struct SensitiveRectTests {
    #if canImport(UIKit)
    @Test func tx_isSensitiveDefaultsFalse() {
        let v = UIView()
        #expect(v.tx_isSensitive == false)
    }

    @Test func tx_isSensitiveRoundTrips() {
        let v = UIView()
        v.tx_isSensitive = true
        #expect(v.tx_isSensitive == true)
    }

    @Test func sensitiveRectRegistryMarkWritesAssociatedObject() {
        let v = UIView()
        SensitiveRectRegistry.mark(v)
        #expect(v.tx_isSensitive == true)
    }

    @Test func collectsTXSensitiveViewRect_inWindowCoordinates() {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
        let parent = UIView(frame: CGRect(x: 50, y: 60, width: 200, height: 200))
        let sensitive = TXSensitiveView(frame: CGRect(x: 10, y: 20, width: 100, height: 30))
        parent.addSubview(sensitive)
        window.addSubview(parent)

        let rects = SensitiveRectRegistry.collectSensitiveRects(in: window)
        #expect(rects.count == 1)
        #expect(rects[0] == CGRect(x: 60, y: 80, width: 100, height: 30))
    }

    @Test func collectsSecureTextEntryRect() {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
        let tf = UITextField(frame: CGRect(x: 0, y: 100, width: 200, height: 40))
        tf.isSecureTextEntry = true
        window.addSubview(tf)
        let rects = SensitiveRectRegistry.collectSensitiveRects(in: window)
        #expect(rects.count == 1)
        #expect(rects[0] == CGRect(x: 0, y: 100, width: 200, height: 40))
    }

    @Test func collectsTxIsSensitiveRect() {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
        let v = UIView(frame: CGRect(x: 5, y: 5, width: 10, height: 10))
        v.tx_isSensitive = true
        window.addSubview(v)
        let rects = SensitiveRectRegistry.collectSensitiveRects(in: window)
        #expect(rects.count == 1)
    }

    @Test func doesNotDescendIntoSensitiveSubtree() {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
        let outer = TXSensitiveView(frame: CGRect(x: 0, y: 0, width: 200, height: 200))
        let inner = TXSensitiveView(frame: CGRect(x: 50, y: 50, width: 100, height: 100))
        outer.addSubview(inner)
        window.addSubview(outer)
        let rects = SensitiveRectRegistry.collectSensitiveRects(in: window)
        #expect(rects.count == 1)  // only the outer; inner is inside the early-return subtree
    }
    #endif
}
