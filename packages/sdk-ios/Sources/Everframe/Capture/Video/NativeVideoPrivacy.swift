// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import UIKit
#if canImport(WebKit)
import WebKit
#endif
import AVFoundation
import Metal
import MetalKit

@MainActor struct NativeVideoPrivacy {
    var rects: [CGRect] = []
    var excludedLayers: Set<ObjectIdentifier> = []
    var blockedRasters: Set<ObjectIdentifier> = []

    static func collect(window: UIWindow) throws -> Self {
        var result = Self()
        // Exclusion removes the whole subtree from the detached snapshot. Cover
        // overflowing descendants too, without reading any of their contents.
        func coverSubtree(_ layer: CALayer) throws {
            guard !layer.isHidden, layer.opacity > 0 else { return }
            let rect = layer.convert(layer.bounds, to: window.layer)
            guard rect.origin.x.isFinite, rect.origin.y.isFinite,
                  rect.width.isFinite, rect.height.isFinite else { throw CocoaError(.coderInvalidValue) }
            result.rects.append(rect)
            for child in layer.sublayers ?? [] { try coverSubtree(child) }
        }
        func visit(_ layer: CALayer) throws {
            guard !layer.isHidden, layer.opacity > 0 else { return }
            let view = layer.delegate as? UIView
            let sensitive = view.map { SensitiveRectRegistry.isSensitive($0) || isExcludedView($0) } ?? false
            if sensitive || layer is AVPlayerLayer || layer is AVSampleBufferDisplayLayer || layer is CAMetalLayer || layer is CAEAGLLayer {
                try coverSubtree(layer)
                result.excludedLayers.insert(ObjectIdentifier(layer))
                var ancestor = layer.superlayer
                while let parent = ancestor {
                    result.blockedRasters.insert(ObjectIdentifier(parent)); ancestor = parent.superlayer
                }
                return
            }
            for child in layer.sublayers ?? [] { try visit(child) }
        }
        try visit(window.layer)
        return result
    }

    private static func isExcludedView(_ view: UIView) -> Bool {
        if view is MTKView { return true }
        #if canImport(WebKit)
        if view is WKWebView { return true }
        #endif
        return false
    }
}
#endif
