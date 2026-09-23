// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import UIKit
@MainActor final class NativeVideoRasterKey {
    struct Candidate {
        let layerID: ObjectIdentifier
        let contents: AnyObject?
        let key: Key
    }
    struct Key: Equatable {
        let contentsID: ObjectIdentifier?
        let scalars: [CGFloat]
        let appearance: [String]
        let maskID: ObjectIdentifier?
        let children: [ObjectIdentifier]
    }
    func candidate(for layer: CALayer, scale: CGFloat, clip: CGRect?, rgba: Bool) -> Candidate {
        let content = layer.contents as AnyObject?
        func rect(_ r: CGRect) -> [CGFloat] { [r.minX, r.minY, r.width, r.height] }
        func matrix(_ t: CATransform3D) -> [CGFloat] {
            [t.m11, t.m12, t.m13, t.m14, t.m21, t.m22, t.m23, t.m24,
             t.m31, t.m32, t.m33, t.m34, t.m41, t.m42, t.m43, t.m44]
        }
        let scalars = rect(layer.bounds) + rect(layer.contentsRect) + rect(layer.contentsCenter) +
            rect(clip ?? .zero) + matrix(layer.transform) + matrix(layer.sublayerTransform) +
            [scale, layer.contentsScale, layer.borderWidth, layer.cornerRadius, CGFloat(layer.opacity),
             CGFloat(layer.shadowOpacity), layer.shadowOffset.width, layer.shadowOffset.height, layer.shadowRadius]
        let appearance = [String(describing: type(of: layer)), layer.contentsGravity.rawValue,
            String(describing: layer.backgroundColor), String(describing: layer.borderColor),
            String(describing: layer.shadowColor), String(describing: layer.shadowPath),
            "\(layer.isHidden)/\(layer.isOpaque)/\(layer.masksToBounds)/\(layer.maskedCorners.rawValue)/\(layer.cornerCurve.rawValue)",
            "\(layer.needsDisplay())/\(layer.isGeometryFlipped)/\(layer.allowsGroupOpacity)/\(rgba)/\(clip != nil)"]
        return .init(layerID: ObjectIdentifier(layer), contents: content,
            key: .init(contentsID: content.map(ObjectIdentifier.init), scalars: scalars,
                appearance: appearance, maskID: layer.mask.map(ObjectIdentifier.init),
                children: (layer.sublayers ?? []).map(ObjectIdentifier.init)))
    }

}
#endif
