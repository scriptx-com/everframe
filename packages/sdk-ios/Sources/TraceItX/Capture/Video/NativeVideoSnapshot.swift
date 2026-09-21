// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import UIKit

/// Immutable native layer snapshot, composed off the main thread.
struct NativeVideoSnapshot: Sendable {
    struct Coverage: Codable, Sendable {
        var classes: [String: Int] = [:]
        var imageCount = 0
        var customLayersWithoutImage: [String: Int] = [:]
        var unsupportedContents: [String: Int] = [:]
        var fallbackCount = 0
        var fallbackRasterMillis: Double = 0
        var failedFallbackCount = 0
        var culledFallbackCount = 0
    }
    let coverage: Coverage
    private let root: Node

    @MainActor static func collect(root: CALayer, rasterizeUnsupported: Bool = false,
                                  scale: CGFloat = 1, cullOffscreen: Bool = false,
                                  clipPartialFallback: Bool = false,
                                  rgbaFallback: Bool = false,
                                  imageReuse: NativeVideoImageCache? = nil,
                                  excludedLayers: Set<ObjectIdentifier> = [],
                                  blockedRasters: Set<ObjectIdentifier> = []) -> Self {
        var coverage = Coverage()
        let node = Node(layer: root, rootLayer: root, clipInRoot: root.bounds, cullOffscreen: cullOffscreen,
                        rasterizeUnsupported: rasterizeUnsupported, scale: scale, coverage: &coverage,
                        clipPartialFallback: clipPartialFallback, rgbaFallback: rgbaFallback,
                        imageReuse: imageReuse, excludedLayers: excludedLayers, blockedRasters: blockedRasters)
        return .init(coverage: coverage, root: node)
    }

    func render(bounds: CGRect, dimensions: NativeVideoDimensions,
                sensitiveRects: [CGRect] = []) async throws -> NativeVideoPixels {
        try await Task.detached(priority: .userInitiated) {
            dispatchPrecondition(condition: .notOnQueue(.main))
            guard bounds.width > 0, bounds.height > 0,
                  dimensions.width > 0, dimensions.height > 0,
                  dimensions.width <= 4096, dimensions.height <= 4096 else {
                throw CocoaError(.coderInvalidValue)
            }
            let stride = dimensions.width * 4
            guard let context = CGContext(data: nil, width: dimensions.width, height: dimensions.height,
                bitsPerComponent: 8, bytesPerRow: stride, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue),
                  let bytes = context.data else { throw CocoaError(.coderInvalidValue) }
            context.interpolationQuality = .medium
            context.setFillColor(CGColor(gray: 0, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: dimensions.width, height: dimensions.height))
            let sx = CGFloat(dimensions.width) / bounds.width
            let sy = CGFloat(dimensions.height) / bounds.height
            context.translateBy(x: 0, y: CGFloat(dimensions.height))
            context.scaleBy(x: sx, y: -sy)
            context.translateBy(x: -bounds.minX, y: -bounds.minY)
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            // The new tree has no UIView owners, delegates, callbacks, or references
            // to original layers. It is created, drawn and released on this worker.
            let independent = root.materialize()
            independent.render(in: context)
            CATransaction.commit()
            let pixels = bytes.assumingMemoryBound(to: UInt8.self)
            for rect in sensitiveRects {
                let clipped = rect.intersection(bounds)
                guard !clipped.isNull, !clipped.isEmpty else { continue }
                let x0 = max(0, Int(floor((clipped.minX - bounds.minX) * sx)))
                let x1 = min(dimensions.width, Int(ceil((clipped.maxX - bounds.minX) * sx)))
                let y0 = max(0, Int(floor((clipped.minY - bounds.minY) * sy)))
                let y1 = min(dimensions.height, Int(ceil((clipped.maxY - bounds.minY) * sy)))
                for y in y0..<y1 { for x in x0..<x1 {
                    let i = y * stride + x * 4
                    pixels[i] = 0; pixels[i + 1] = 0; pixels[i + 2] = 0; pixels[i + 3] = 255
                } }
                for y in y0..<y1 { for x in x0..<x1 {
                    let i = y * stride + x * 4
                    guard pixels[i] == 0, pixels[i + 1] == 0, pixels[i + 2] == 0, pixels[i + 3] == 255
                    else { throw CocoaError(.coderInvalidValue) }
                } }
            }
            return .init(width: dimensions.width, height: dimensions.height, bytesPerRow: stride,
                         bgraBytes: Data(bytes: bytes, count: stride * dimensions.height))
        }.value
    }

    /// Only immutable values/CG images/colors and other immutable Nodes cross
    /// executors. CGImage references retain image data, never a live layer/view.
    /// Custom subclass drawing and non-CGImage backing stores are NOT reproduced.
    private final class Node: @unchecked Sendable {
        let bounds: CGRect
        let position: CGPoint
        let anchorPoint: CGPoint
        let zPosition: CGFloat
        let transform: CATransform3D
        let sublayerTransform: CATransform3D
        let hidden: Bool
        let opacity: Float
        let background: CGColor?
        let borderColor: CGColor?
        let borderWidth: CGFloat
        let cornerRadius: CGFloat
        let maskedCorners: CACornerMask
        let cornerCurve: CALayerCornerCurve
        let masksToBounds: Bool
        let contents: CGImage?
        let contentsRect: CGRect
        let contentsCenter: CGRect
        let contentsGravity: CALayerContentsGravity
        let contentsScale: CGFloat
        let geometryFlipped: Bool
        let shadowColor: CGColor?
        let shadowOpacity: Float
        let shadowOffset: CGSize
        let shadowRadius: CGFloat
        let shadowPath: CGPath?
        let groupOpacity: Bool
        let children: [Node]
        let mask: Node?
        let baked: Bool
        let rasterBounds: CGRect
        private let shape: Shape?

        private struct Shape {
            let path: CGPath?
            let fill: CGColor?
            let fillRule: CAShapeLayerFillRule
            let stroke: CGColor?
            let lineWidth: CGFloat
            let miterLimit: CGFloat
            let lineCap: CAShapeLayerLineCap
            let lineJoin: CAShapeLayerLineJoin
            let strokeStart: CGFloat
            let strokeEnd: CGFloat
            let lineDashPhase: CGFloat
            let lineDashPattern: [Double]?

            @MainActor init(_ layer: CAShapeLayer) {
                path = layer.path?.copy(); fill = layer.fillColor; fillRule = layer.fillRule
                stroke = layer.strokeColor; lineWidth = layer.lineWidth; miterLimit = layer.miterLimit
                lineCap = layer.lineCap; lineJoin = layer.lineJoin
                strokeStart = layer.strokeStart; strokeEnd = layer.strokeEnd
                lineDashPhase = layer.lineDashPhase
                lineDashPattern = layer.lineDashPattern?.map(\.doubleValue)
            }

            func materialize() -> CAShapeLayer {
                let layer = CAShapeLayer()
                layer.path = path; layer.fillColor = fill; layer.fillRule = fillRule
                layer.strokeColor = stroke; layer.lineWidth = lineWidth; layer.miterLimit = miterLimit
                layer.lineCap = lineCap; layer.lineJoin = lineJoin
                layer.strokeStart = strokeStart; layer.strokeEnd = strokeEnd
                layer.lineDashPhase = lineDashPhase
                layer.lineDashPattern = lineDashPattern?.map { NSNumber(value: $0) }
                return layer
            }
        }

        @MainActor init(layer: CALayer, rootLayer: CALayer, clipInRoot: CGRect, cullOffscreen: Bool,
                        rasterizeUnsupported: Bool, scale: CGFloat, coverage: inout Coverage,
                        clipPartialFallback: Bool, rgbaFallback: Bool,
                        imageReuse: NativeVideoImageCache?, excludedLayers: Set<ObjectIdentifier>,
                        blockedRasters: Set<ObjectIdentifier>) {
            let excluded = excludedLayers.contains(ObjectIdentifier(layer))
            let name = String(describing: type(of: layer))
            coverage.classes[name, default: 0] += 1
            let publicImage: CGImage?
            if !excluded, let content = layer.contents, CFGetTypeID(content as CFTypeRef) == CGImage.typeID {
                publicImage = (content as! CGImage)
                coverage.imageCount += 1
            } else {
                publicImage = nil
                if let content = layer.contents {
                    // CALayer may carry opaque backing objects whose type ID is not
                    // registered with Core Foundation. Looking up a CF description
                    // for those IDs can crash the host app; runtime type names do not
                    // require that lookup or invoke the object's description.
                    coverage.unsupportedContents[String(describing: type(of: content)), default: 0] += 1
                }
                if type(of: layer) != CALayer.self {
                    coverage.customLayersWithoutImage[name, default: 0] += 1
                }
            }
            shape = !excluded && type(of: layer) == CAShapeLayer.self ? Shape(layer as! CAShapeLayer) : nil
            let imageView = layer.delegate as? UIImageView
            let templateImage = imageView?.layer === layer && imageView?.image?.renderingMode == .alwaysTemplate
            // CGImage contents alone omit the UIImageView's template tint.
            let unsupported = templateImage || (shape == nil && publicImage == nil && (layer.contents != nil ||
                ((layer.sublayers ?? []).isEmpty && type(of: layer) != CALayer.self)))
            // Conservative 2D culling only. Non-clipping parents may have visible
            // descendants outside their own bounds; never prune those descendants.
            let canCull = cullOffscreen && CATransform3DIsAffine(layer.transform) &&
                CATransform3DIsAffine(layer.sublayerTransform)
            let rectInRoot = canCull ? layer.convert(layer.bounds, to: rootLayer) : .infinite
            let visible = !canCull || rectInRoot.intersects(clipInRoot)
            let childClip = canCull && layer.masksToBounds ? clipInRoot.intersection(rectInRoot) : clipInRoot
            if rasterizeUnsupported && unsupported && !visible { coverage.culledFallbackCount += 1 }
            var rasterScale = CGSize(width: scale, height: scale)
            if canCull && unsupported && visible && !layer.bounds.isEmpty {
                let origin = layer.convert(layer.bounds.origin, to: rootLayer)
                let x = layer.convert(CGPoint(x: layer.bounds.maxX, y: layer.bounds.minY), to: rootLayer)
                let y = layer.convert(CGPoint(x: layer.bounds.minX, y: layer.bounds.maxY), to: rootLayer)
                // Each local axis needs only its projected screen pixel density.
                // The sum of absolute components is conservative for rotations
                // and shear, unlike using only the affine diagonal. Keep axes
                // separate so a narrow, vertically compressed layer stays bounded.
                let sx = (abs(x.x - origin.x) + abs(x.y - origin.y)) / layer.bounds.width
                let sy = (abs(y.x - origin.x) + abs(y.y - origin.y)) / layer.bounds.height
                if sx.isFinite && sy.isFinite && sx > 0 && sy > 0 {
                    rasterScale = CGSize(width: scale * min(1, sx), height: scale * min(1, sy))
                }
            }
            // Convert the conservative root-space visible rectangle back into
            // local coordinates. Keep the crop on the layer's raster pixel grid.
            let localClip: CGRect? = clipPartialFallback && canCull && visible && scale.isFinite && scale > 0 ?
                layer.convert(clipInRoot, from: rootLayer).intersection(layer.bounds) : nil
            if let localClip, !localClip.isNull, !localClip.isEmpty {
                let x0 = floor((localClip.minX - layer.bounds.minX) * rasterScale.width) / rasterScale.width
                let y0 = floor((localClip.minY - layer.bounds.minY) * rasterScale.height) / rasterScale.height
                let x1 = ceil((localClip.maxX - layer.bounds.minX) * rasterScale.width) / rasterScale.width
                let y1 = ceil((localClip.maxY - layer.bounds.minY) * rasterScale.height) / rasterScale.height
                rasterBounds = CGRect(x: layer.bounds.minX + x0, y: layer.bounds.minY + y0,
                                      width: x1 - x0, height: y1 - y0)
            } else {
                rasterBounds = layer.bounds
            }
            let fallback: CGImage?
            if !excluded && !blockedRasters.contains(ObjectIdentifier(layer)) && rasterizeUnsupported && unsupported && visible && !layer.isHidden && layer.opacity > 0 && !layer.bounds.isEmpty {
                let rasterClip = localClip == nil ? nil : rasterBounds
                // The cache fingerprints one scalar density. Bypass anisotropic
                // rasters so ancestor scale changes cannot reuse the wrong image.
                let reuseCandidate = rasterScale.width == rasterScale.height ?
                    imageReuse?.candidate(for: layer, scale: rasterScale.width,
                        clip: rasterClip, rgba: rgbaFallback) : nil
                let reused = reuseCandidate.flatMap { imageReuse?.lookup($0, layer: layer) }
                let start = DispatchTime.now().uptimeNanoseconds
                if let reused, let imageReuse, imageReuse.validateHits {
                    fallback = imageReuse.validate(cached: reused,
                        fresh: Self.rasterize(layer, scale: rasterScale, bounds: rasterBounds, rgba: rgbaFallback))
                } else {
                    fallback = reused ?? Self.rasterize(layer, scale: rasterScale, bounds: rasterBounds, rgba: rgbaFallback)
                }
                let elapsed = Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
                coverage.fallbackRasterMillis += elapsed
                if reused == nil || imageReuse?.validateHits == true, let reuseCandidate, let fallback {
                    imageReuse?.store(reuseCandidate, layer: layer, image: fallback)
                }
                if fallback != nil { coverage.fallbackCount += 1 }
                else { coverage.failedFallbackCount += 1 }
            } else { fallback = nil }
            contents = fallback ?? publicImage
            baked = fallback != nil
            bounds = layer.bounds; position = layer.position; anchorPoint = layer.anchorPoint
            zPosition = layer.zPosition; transform = layer.transform; sublayerTransform = layer.sublayerTransform
            hidden = layer.isHidden; opacity = layer.opacity; background = excluded ? CGColor(gray: 0, alpha: 1) : layer.backgroundColor
            borderColor = layer.borderColor; borderWidth = layer.borderWidth
            cornerRadius = layer.cornerRadius; maskedCorners = layer.maskedCorners; cornerCurve = layer.cornerCurve
            masksToBounds = layer.masksToBounds; contentsRect = layer.contentsRect
            contentsCenter = layer.contentsCenter; contentsGravity = layer.contentsGravity
            contentsScale = layer.contentsScale; geometryFlipped = layer.isGeometryFlipped
            shadowColor = layer.shadowColor; shadowOpacity = layer.shadowOpacity
            shadowOffset = layer.shadowOffset; shadowRadius = layer.shadowRadius; shadowPath = layer.shadowPath?.copy()
            groupOpacity = layer.allowsGroupOpacity
            // Invisible ancestors suppress the whole subtree, not just their own raster.
            let omitDescendants = excluded || baked || layer.isHidden || layer.opacity <= 0
            children = omitDescendants ? [] : (layer.sublayers ?? []).map {
                Node(layer: $0, rootLayer: rootLayer, clipInRoot: childClip, cullOffscreen: canCull,
                     rasterizeUnsupported: rasterizeUnsupported, scale: scale, coverage: &coverage,
                     clipPartialFallback: clipPartialFallback, rgbaFallback: rgbaFallback,
                     imageReuse: imageReuse, excludedLayers: excludedLayers, blockedRasters: blockedRasters)
            }
            mask = omitDescendants ? nil : layer.mask.map {
                // Masks are not normal sublayers; do not infer their root geometry.
                Node(layer: $0, rootLayer: rootLayer, clipInRoot: .infinite, cullOffscreen: false,
                     rasterizeUnsupported: rasterizeUnsupported, scale: scale, coverage: &coverage,
                     clipPartialFallback: false, rgbaFallback: rgbaFallback,
                     imageReuse: imageReuse, excludedLayers: excludedLayers, blockedRasters: blockedRasters)
            }
        }

        func materialize() -> CALayer {
            let layer: CALayer = shape?.materialize() ?? CALayer()
            layer.bounds = bounds; layer.position = position; layer.anchorPoint = anchorPoint
            layer.zPosition = zPosition; layer.transform = transform; layer.sublayerTransform = sublayerTransform
            if baked {
                // Original local drawing/effects are in the bitmap, not applied
                // a second time. Parent geometry and clipping remain independent.
                // The bitmap covers only rasterBounds; stretching it over the
                // original bounds would move scrolled content. The container
                // preserves the original anchor/transform while this child places
                // the crop in local coordinates. Sublayer transforms are baked.
                layer.sublayerTransform = CATransform3DIdentity
                let raster = CALayer()
                raster.frame = rasterBounds
                raster.contents = contents
                raster.contentsGravity = .resize
                layer.addSublayer(raster)
                return layer
            }
            layer.isHidden = hidden; layer.opacity = opacity; layer.backgroundColor = background
            layer.borderColor = borderColor; layer.borderWidth = borderWidth
            layer.cornerRadius = cornerRadius; layer.maskedCorners = maskedCorners; layer.cornerCurve = cornerCurve
            layer.masksToBounds = masksToBounds; layer.contents = contents
            layer.contentsRect = contentsRect; layer.contentsCenter = contentsCenter
            layer.contentsGravity = contentsGravity; layer.contentsScale = contentsScale
            layer.isGeometryFlipped = geometryFlipped
            layer.shadowColor = shadowColor; layer.shadowOpacity = shadowOpacity
            layer.shadowOffset = shadowOffset; layer.shadowRadius = shadowRadius; layer.shadowPath = shadowPath
            layer.allowsGroupOpacity = groupOpacity
            for child in children { layer.addSublayer(child.materialize()) }
            layer.mask = mask?.materialize()
            return layer
        }

        @MainActor private static func rasterize(_ layer: CALayer, scale: CGSize, bounds: CGRect, rgba: Bool) -> CGImage? {
            guard bounds.minX.isFinite, bounds.minY.isFinite,
                  bounds.width.isFinite, bounds.height.isFinite,
                  scale.width.isFinite, scale.height.isFinite, scale.width > 0, scale.height > 0 else { return nil }
            let w = ceil(bounds.width * scale.width), h = ceil(bounds.height * scale.height)
            guard w > 0, h > 0, w <= 4096, h <= 4096,
                  let context = CGContext(data: nil, width: Int(w), height: Int(h), bitsPerComponent: 8,
                    bytesPerRow: Int(w) * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                    bitmapInfo: rgba ? (CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue) :
                        (CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue))
            else { return nil }
            context.interpolationQuality = .medium
            context.translateBy(x: 0, y: h)
            context.scaleBy(x: w / bounds.width, y: -h / bounds.height)
            context.translateBy(x: -bounds.minX, y: -bounds.minY)
            layer.render(in: context)
            return context.makeImage()
        }
    }
}
#endif
