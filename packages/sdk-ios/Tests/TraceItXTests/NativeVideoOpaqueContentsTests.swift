// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import UIKit
import Testing
@testable import TraceItXKit

@MainActor @Suite(.serialized)
struct NativeVideoOpaqueContentsTests {
    // Test-only analogue of an opaque layer backing object. An Objective-C object
    // need not return a registered Core Foundation type ID. Never ask CF to look
    // up a diagnostic description for that ID (the reported iPad crash).
    private final class OpaqueBacking: NSObject {
        @objc(_cfTypeID) func unsupportedTypeID() -> UInt { UInt.max }
    }
    private final class OpaqueLayer: CALayer {
        private let backing = OpaqueBacking()
        override var contents: Any? {
            get { backing }
            set { }
        }
    }

    @Test func opaqueBackingDoesNotCrashSnapshotDiagnosticsOrCrossIntoRendering() async throws {
        let layer = OpaqueLayer()
        layer.frame = CGRect(x: 0, y: 0, width: 8, height: 8)
        layer.backgroundColor = UIColor.red.cgColor
        let snapshot = NativeVideoSnapshot.collect(root: layer)
        #expect(snapshot.coverage.imageCount == 0)
        #expect(snapshot.coverage.unsupportedContents.values.reduce(0, +) == 1)
        let pixels = try await snapshot.render(bounds: layer.bounds, dimensions: .init(width: 8, height: 8))
        #expect(Array(pixels.bgraBytes[0..<4]) == [0, 0, 255, 255])
    }

    @Test func ordinaryCGImageStillUsesTheImagePath() async throws {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).image {
            UIColor.blue.setFill(); $0.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        }
        let layer = CALayer()
        layer.frame = CGRect(x: 0, y: 0, width: 8, height: 8)
        layer.contents = try #require(image.cgImage)
        let snapshot = NativeVideoSnapshot.collect(root: layer)
        #expect(snapshot.coverage.imageCount == 1)
        #expect(snapshot.coverage.unsupportedContents.isEmpty)
        let pixels = try await snapshot.render(bounds: layer.bounds, dimensions: .init(width: 8, height: 8))
        #expect(Array(pixels.bgraBytes[0..<4]) == [255, 0, 0, 255])
    }
}
#endif
