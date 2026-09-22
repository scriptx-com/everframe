// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import UIKit

@MainActor final class NativeVideoCapture {
    private let cache = NativeVideoImageCache()
    private var exclusions: Set<ObjectIdentifier> = []
    private var generation = 0
    private var capturing = false

    func clear() { generation += 1; cache.clear(); exclusions.removeAll() }

    func capture(window: UIWindow, timestampNanos: UInt64) async throws -> NativeVideoFrame? {
        guard !capturing else { return nil }
        capturing = true
        defer { capturing = false }
        let epoch = generation
        let bounds = window.bounds
        guard bounds.width.isFinite, bounds.height.isFinite,
              bounds.width > 0, bounds.height > 0 else { return nil }
        let scale = min(1, 854 / max(bounds.width, bounds.height))
        let dimensions = NativeVideoDimensions(width: max(2, Int(bounds.width * scale) / 2 * 2),
            height: max(2, Int(bounds.height * scale) / 2 * 2))
        let privacy = try NativeVideoPrivacy.collect(window: window)
        if exclusions != privacy.excludedLayers { cache.clear(); exclusions = privacy.excludedLayers }
        let snapshot = NativeVideoSnapshot.collect(root: window.layer, rasterizeUnsupported: true,
            scale: scale, cullOffscreen: true, clipPartialFallback: true, imageReuse: cache,
            excludedLayers: privacy.excludedLayers, blockedRasters: privacy.blockedRasters)
        guard snapshot.coverage.failedFallbackCount == 0 else { return nil }
        let pixels = try await snapshot.render(bounds: bounds, dimensions: dimensions, sensitiveRects: privacy.rects)
        try Task.checkCancellation()
        guard epoch == generation else { return nil }
        return .init(width: pixels.width, height: pixels.height, bytesPerRow: pixels.bytesPerRow,
            bgraBytes: pixels.bgraBytes, timestampNanos: timestampNanos)
    }
}
#endif
