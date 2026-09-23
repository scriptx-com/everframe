// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Testing
#if canImport(UIKit)
import UIKit
#endif
@testable import EverframeKit

@MainActor
struct CaptureSmokeTest {
    #if canImport(UIKit)
    @Test func captureWithBlackoutRectProducesNonNilResult() async throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 568))
        let label = UILabel(frame: CGRect(x: 10, y: 10, width: 100, height: 30))
        label.text = "hello"
        window.addSubview(label)
        window.makeKeyAndVisible()
        // Allow render server to commit one update
        try await Task.sleep(nanoseconds: 50_000_000)

        let blackoutRect = CGRect(x: 10, y: 10, width: 100, height: 30)
        let result = ScreenshotCapture.capture(window: window, blackoutRects: [blackoutRect])
        #expect(result != nil)
        #expect((result?.pngData.count ?? 0) > 0)
        #expect((result?.widthPoints ?? 0) > 0)
    }

    @Test func captureCapsMaxEdgeAt2048() {
        // Construct a window taller than MAX_EDGE_PT and verify outputSize is capped.
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 1024, height: 4096))
        window.makeKeyAndVisible()
        let result = ScreenshotCapture.capture(window: window, blackoutRects: [])
        // Longer edge 4096 → downscale 0.5 → output 512 x 2048
        #expect((result?.heightPoints ?? 0) <= ScreenshotCapture.MAX_EDGE_PT + 1)
    }
    #endif
}
