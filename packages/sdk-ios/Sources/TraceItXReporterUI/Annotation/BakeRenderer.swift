// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Single-pass annotation bake renderer (RESEARCH Finding 9; threat T-04-25).
//
// Why bake at submit (PRIV-03 hard lock):
//   The live annotation surface renders redactions as an overlay ON TOP of
//   the screenshot UIImageView. Overlays exist purely in the host's
//   compositing tree — they never touch the underlying UIImage's pixel
//   buffer. If we uploaded the raw screenshot bytes to the backend with a
//   separate "list of redaction rectangles" sidecar, the server (or anyone
//   with the bytes) could trivially reconstruct the redacted regions.
//   Therefore, at submit time, we must FLATTEN every annotation into the
//   output PNG buffer itself BEFORE handing it to ReportSubmitter.
//
// Bake order (PRIV-03 hard lock, model-driven — Tasks 1-3 `Annotation`):
//   1. Every `.blur`-kind shape bakes FIRST as an OPAQUE BLACK fill —
//      regardless of its position in the `annotations` array. A redaction
//      must never be paintable-over by an earlier-drawn shape sitting below
//      it in z-order; this is why redaction cannot simply be "just another
//      shape drawn in array order" — see redactionsBakeBeforeShapesRegardlessOfArrayOrder.
//   2. Every OTHER shape then bakes in array order (z-order) on top.
//
// Coordinate space: all annotation geometry is in image-pixel space (the
// SAME space as `source.size`). ImageTransform owns the view↔image mapping;
// nothing in this file touches view-space coordinates.
import Foundation
#if canImport(UIKit) && !os(tvOS)
import UIKit

@MainActor
public enum BakeRenderer {
    /// Bake `annotations` (image-pixel space) into a copy of `source`.
    /// PRIV-03 order lock: redactions FIRST as opaque black, then every other
    /// shape in array order. Never throws — bake failure upstream policy
    /// (DEFE-02) is the caller's: ship unbaked bytes.
    public static func bake(source: UIImage, annotations: [Annotation]) -> UIImage {
        let format = UIGraphicsImageRendererFormat.preferred()
        format.scale = source.scale
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: source.size, format: format)
        return renderer.image { ctx in
            source.draw(at: .zero)
            let cg = ctx.cgContext
            // Stage 1 — redactions (opaque black, always bottom-of-annotations).
            for a in annotations where a.kind == .blur {
                cg.setFillColor(UIColor.black.cgColor)
                cg.fill(normalizedBox(a))
            }
            // Stage 2 — everything else in array order (z-order).
            for a in annotations where a.kind != .blur {
                draw(a, in: cg)
            }
        }
    }

    private static func draw(_ a: Annotation, in cg: CGContext) {
        let color = UIColor(argb: a.color)
        switch a.kind {
        case .pen, .highlighter:
            guard a.points.count >= 4 else { return }
            cg.saveGState()
            cg.setStrokeColor(color.cgColor)
            cg.setLineCap(.round)
            cg.setLineJoin(.round)
            if a.kind == .highlighter {
                cg.setAlpha(AnnotationConstants.highlighterOpacity)
                cg.setLineWidth(a.thickness * AnnotationConstants.highlighterWidthMultiplier)
            } else {
                cg.setLineWidth(a.thickness)
            }
            cg.move(to: CGPoint(x: a.points[0], y: a.points[1]))
            var i = 2
            while i + 1 < a.points.count {
                cg.addLine(to: CGPoint(x: a.points[i], y: a.points[i + 1]))
                i += 2
            }
            cg.strokePath()
            cg.restoreGState()
        case .rect:
            cg.setStrokeColor(color.cgColor)
            cg.setLineWidth(a.thickness)
            cg.stroke(normalizedBox(a))
        case .ellipse:
            cg.setStrokeColor(color.cgColor)
            cg.setLineWidth(a.thickness)
            cg.strokeEllipse(in: normalizedBox(a))
        case .arrow:
            cg.setStrokeColor(color.cgColor)
            cg.setFillColor(color.cgColor)
            cg.setLineWidth(a.thickness)
            cg.setLineCap(.round)
            cg.move(to: a.from)
            cg.addLine(to: a.to)
            cg.strokePath()
            // Chevron head — same 12px @ 30° geometry the old ArrowMark used.
            let angle = atan2(a.to.y - a.from.y, a.to.x - a.from.x)
            let headLen: CGFloat = max(12, a.thickness * 3)
            for side in [CGFloat.pi / 6, -CGFloat.pi / 6] {
                cg.move(to: a.to)
                cg.addLine(to: CGPoint(
                    x: a.to.x - headLen * cos(angle + side),
                    y: a.to.y - headLen * sin(angle + side)))
            }
            cg.strokePath()
        case .text:
            let paragraph = NSMutableParagraphStyle()
            paragraph.lineHeightMultiple = AnnotationConstants.textLineHeight
            let attrs: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: a.fontSize),
                .foregroundColor: color,
                .paragraphStyle: paragraph,
            ]
            (a.text as NSString).draw(at: CGPoint(x: a.x, y: a.y), withAttributes: attrs)
        case .blur:
            break  // handled in stage 1
        }
    }
}
#endif
