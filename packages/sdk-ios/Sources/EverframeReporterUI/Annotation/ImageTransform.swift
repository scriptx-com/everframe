// packages/sdk-ios/Sources/EverframeReporterUI/Annotation/ImageTransform.swift
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The ONE view↔image mapping for the annotation editor. Replaces the
// select-tool-only AVMakeRect math; every pointer event and every rendered
// shape goes through this. Aspect-fit, centered, upscale capped at ×4 so tiny
// area-capture crops stay workable (web parity — sdk-react ×4 cap).
// Pure CoreGraphics — no UIKit, no tvOS gate.
import CoreGraphics

public struct ImageTransform: Equatable, Sendable {
    public let scale: CGFloat
    public let offset: CGPoint
    public let imageSize: CGSize

    public init(imageSize: CGSize, viewSize: CGSize, maxUpscale: CGFloat = 4) {
        self.imageSize = imageSize
        guard imageSize.width > 0, imageSize.height > 0, viewSize.width > 0, viewSize.height > 0 else {
            self.scale = 1; self.offset = .zero
            return
        }
        let fit = min(viewSize.width / imageSize.width, viewSize.height / imageSize.height)
        let s = min(fit, maxUpscale)
        self.scale = s
        self.offset = CGPoint(
            x: (viewSize.width - imageSize.width * s) / 2,
            y: (viewSize.height - imageSize.height * s) / 2
        )
    }

    /// The image's rendered frame inside the view (letterbox excluded).
    public var imageFrameInView: CGRect {
        CGRect(x: offset.x, y: offset.y, width: imageSize.width * scale, height: imageSize.height * scale)
    }

    public func toImage(_ viewPoint: CGPoint) -> CGPoint {
        CGPoint(x: (viewPoint.x - offset.x) / scale, y: (viewPoint.y - offset.y) / scale)
    }
    public func toView(_ imagePoint: CGPoint) -> CGPoint {
        CGPoint(x: imagePoint.x * scale + offset.x, y: imagePoint.y * scale + offset.y)
    }
    public func toView(_ imageRect: CGRect) -> CGRect {
        CGRect(origin: toView(imageRect.origin),
               size: CGSize(width: imageRect.width * scale, height: imageRect.height * scale))
    }
}
