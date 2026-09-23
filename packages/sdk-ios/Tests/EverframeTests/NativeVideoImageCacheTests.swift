// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import UIKit
import Testing
@testable import EverframeKit

@MainActor @Suite(.serialized)
struct NativeVideoImageCacheTests {
    @Test func tintMaskAndSourceChangesInvalidate() async throws {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 32, height: 32)).image {
            UIColor.white.setFill(); $0.fill(CGRect(x: 0, y: 0, width: 32, height: 32))
        }.withRenderingMode(.alwaysTemplate)
        let view = UIImageView(image: image); view.tintColor = .red
        view.frame = CGRect(x: 0, y: 0, width: 32, height: 32)
        let cache = NativeVideoImageCache(validateHits: true)
        func capture() async throws -> NativeVideoPixels {
            view.layer.displayIfNeeded()
            return try await NativeVideoSnapshot.collect(root: view.layer, rasterizeUnsupported: true,
                imageReuse: cache).render(bounds: view.bounds, dimensions: .init(width: 32, height: 32))
        }
        let red = try await capture()
        let same = try await capture()
        #expect(red.bgraBytes == same.bgraBytes)
        #expect(cache.statistics.hits == 1)
        #expect(cache.statistics.mismatchedHits == 0)
        view.tintColor = .green
        let green = try await capture()
        #expect(green.bgraBytes != red.bgraBytes)
        let mask = CAShapeLayer()
        mask.path = CGPath(rect: CGRect(x: 0, y: 0, width: 8, height: 32), transform: nil)
        view.layer.mask = mask
        let masked = try await capture()
        #expect(masked.bgraBytes != green.bgraBytes)
        view.image = UIGraphicsImageRenderer(size: CGSize(width: 16, height: 16)).image {
            UIColor.clear.setFill(); $0.fill(CGRect(x: 0, y: 0, width: 16, height: 16))
        }.withRenderingMode(.alwaysTemplate)
        let empty = try await capture()
        #expect(empty.bgraBytes != masked.bgraBytes)
        #expect(cache.retainedRasterBytes > 0)
        cache.clear()
        #expect(cache.retainedRasterBytes == 0)
    }
}
#endif
