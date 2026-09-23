// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import UIKit

/// Static template-image reuse; arbitrary custom drawing is never cached.
@MainActor
final class NativeVideoImageCache {
    struct Statistics: Codable {
        var hits = 0
        var misses = 0
        var validatedHits = 0
        var mismatchedHits = 0
        var validationFailures = 0
        var templateAttempts = 0
        var templateRejections: [String: Int] = [:]
        var templateAnimationStates: [String: Int] = [:]
    }
    private(set) var statistics = Statistics()
    struct Candidate {
        let raster: NativeVideoRasterKey.Candidate
        let source: UIImage?
        let resolvedSource: CGImage?
        let tintState: [String]
        let maskKey: NativeVideoRasterKey.Key?
        let maskPath: CGPath?
        let maskStyle: [String]
        var layerID: ObjectIdentifier { raster.layerID }

        func matches(_ other: Self) -> Bool {
            raster.key == other.raster.key && source === other.source && resolvedSource === other.resolvedSource && tintState == other.tintState &&
                maskKey == other.maskKey && maskPath == other.maskPath && maskStyle == other.maskStyle
        }
    }
    private struct Entry {
        weak var layer: CALayer?
        let candidate: Candidate
        let image: CGImage
        var bytes: Int { image.bytesPerRow * image.height }
    }
    private let fingerprinter = NativeVideoRasterKey()
    private var entries: [ObjectIdentifier: Entry] = [:]
    private(set) var retainedRasterBytes = 0
    private(set) var evictions = 0
    private let byteLimit = 16 * 1024 * 1024
    let validateHits: Bool

    init(validateHits: Bool = false) { self.validateHits = validateHits }

    func validate(cached: CGImage, fresh: CGImage?) -> CGImage? {
        guard let fresh, let a = cached.dataProvider?.data, let b = fresh.dataProvider?.data else {
            statistics.validationFailures += 1
            return nil
        }
        statistics.validatedHits += 1
        let sameLayout = cached.width == fresh.width && cached.height == fresh.height &&
            cached.bytesPerRow == fresh.bytesPerRow && cached.bitmapInfo == fresh.bitmapInfo &&
            cached.bitsPerComponent == fresh.bitsPerComponent && cached.bitsPerPixel == fresh.bitsPerPixel &&
            cached.colorSpace == fresh.colorSpace
        if !sameLayout || (a as Data) != (b as Data) { statistics.mismatchedHits += 1 }
        return fresh
    }

    func candidate(for layer: CALayer, scale: CGFloat, clip: CGRect?, rgba: Bool) -> Candidate? {
        if let view = layer.delegate as? UIImageView, view.layer === layer,
           view.image?.renderingMode == .alwaysTemplate {
            return templateCandidate(view, layer: layer, scale: scale, clip: clip, rgba: rgba)
        }
        return nil
    }

    private func templateCandidate(_ view: UIImageView, layer: CALayer, scale: CGFloat,
                                   clip: CGRect?, rgba: Bool) -> Candidate? {
        let allowedViews = ["UIImageView", "SDAnimatedImageView", "RCTUIImageViewAnimated"]
        statistics.templateAttempts += 1
        func reject(_ reason: String) -> Candidate? {
            statistics.templateRejections[reason, default: 0] += 1
            return nil
        }
        guard allowedViews.contains(String(describing: type(of: view))) else { return reject("viewClass") }
        guard type(of: layer) == CALayer.self else { return reject("layerClass") }
        guard let source = view.image, source.cgImage != nil, source.ciImage == nil else { return reject("sourceFormat") }
        let frames = source.images
        let animating = view.isAnimating
        let frameCount = frames.map { String($0.count) } ?? "nil"
        let animationState = "frames=\(frameCount)/viewAnimating=\(animating)/sourceClass=\(type(of: source))"
        statistics.templateAnimationStates[animationState, default: 0] += 1
        guard frames?.isEmpty != false else { return reject("sourceFrameArray") }
        guard !animating else { return reject("viewAnimating") }
        guard !view.isHighlighted else { return reject("highlighted") }
        guard (layer.sublayers ?? []).isEmpty else { return reject("imageSublayers") }
        guard (layer.animationKeys() ?? []).isEmpty else { return reject("layerAnimation") }
        guard !layer.needsDisplay() else { return reject("layerNeedsDisplay") }
        guard layer.compositingFilter == nil, (layer.filters ?? []).isEmpty else { return reject("layerFilters") }
        let mask = layer.mask as? CAShapeLayer
        if let rawMask = layer.mask {
            guard type(of: rawMask) == CAShapeLayer.self else { return reject("maskClass") }
            guard rawMask.mask == nil, rawMask.contents == nil, (rawMask.sublayers ?? []).isEmpty
                else { return reject("complexMask") }
            guard (rawMask.animationKeys() ?? []).isEmpty else { return reject("maskAnimation") }
            guard !rawMask.needsDisplay() else { return reject("maskNeedsDisplay") }
            guard rawMask.compositingFilter == nil, (rawMask.filters ?? []).isEmpty else { return reject("maskFilters") }
        }
        let traits = view.traitCollection
        let tint = view.tintColor.resolvedColor(with: traits).cgColor
        let tintState = [String(describing: tint), "\(view.tintAdjustmentMode.rawValue)",
            "\(traits.userInterfaceStyle.rawValue)/\(traits.accessibilityContrast.rawValue)/\(traits.displayScale)",
            "\(source.scale)/\(source.imageOrientation.rawValue)/\(view.contentMode.rawValue)"]
        let style = mask.map {
            [String(describing: $0.fillColor), String(describing: $0.strokeColor), $0.fillRule.rawValue,
             "\($0.lineWidth)/\($0.miterLimit)/\($0.strokeStart)/\($0.strokeEnd)/\($0.lineDashPhase)",
             $0.lineCap.rawValue, $0.lineJoin.rawValue, String(describing: $0.lineDashPattern),
             "\($0.position)/\($0.anchorPoint)/\($0.zPosition)"]
        } ?? []
        return .init(raster: fingerprinter.candidate(for: layer, scale: scale, clip: clip, rgba: rgba),
            source: source, resolvedSource: source.imageAsset?.image(with: traits).cgImage, tintState: tintState,
            maskKey: mask.map { fingerprinter.candidate(for: $0, scale: scale, clip: nil, rgba: rgba).key },
            maskPath: mask?.path?.copy(), maskStyle: style)
    }

    func lookup(_ candidate: Candidate, layer: CALayer) -> CGImage? {
        guard let entry = entries[candidate.layerID], entry.layer === layer,
              entry.candidate.matches(candidate) else {
            statistics.misses += 1
            return nil
        }
        statistics.hits += 1
        return entry.image
    }

    func store(_ candidate: Candidate, layer: CALayer, image: CGImage) {
        let bytes = image.bytesPerRow * image.height
        if let old = entries.removeValue(forKey: candidate.layerID) { retainedRasterBytes -= old.bytes }
        guard bytes <= byteLimit else { return }
        if retainedRasterBytes + bytes > byteLimit || entries.count >= 256 {
            evictions += entries.count
            entries.removeAll(keepingCapacity: true)
            retainedRasterBytes = 0
        }
        entries[candidate.layerID] = .init(layer: layer, candidate: candidate, image: image)
        retainedRasterBytes += bytes
    }

    func clear() {
        entries.removeAll(); retainedRasterBytes = 0
    }
}
#endif
