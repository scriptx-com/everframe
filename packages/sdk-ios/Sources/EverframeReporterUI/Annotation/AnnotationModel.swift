// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Pure annotation model — Swift port of packages/sdk-react/src/reporter-ui/
// annotation-model.ts (report-window overhaul). NO UIKit imports and NO
// tvOS gate: this file compiles on every platform slice (like BakeRenderer's
// gating strategy, but stricter — nothing here needs UIKit at all) so the
// model is testable under plain `swift test`.
//
// All geometry is in IMAGE-PIXEL space (source screenshot pixels). View-space
// coordinates never enter this file; ImageTransform owns that conversion.
import Foundation
import CoreGraphics

public typealias AnnotationId = String

public enum AnnotationKind: String, CaseIterable, Sendable {
    case pen, highlighter, rect, ellipse, arrow, text, blur
}

public enum AnnotationConstants {
    /// 5-color palette — identical values to web PEN_COLORS (annotation-model.ts).
    public static let penColors: [UInt32] = [0xFFFF3B30, 0xFFFFCC00, 0xFF32ADE6, 0xFFFFFFFF, 0xFF000000]
    public static let penThicknesses: [CGFloat] = [2, 4, 8]
    /// S/M/L text sizes in image-px (web TEXT_FONT_SIZES).
    public static let textFontSizes: [CGFloat] = [16, 24, 36]
    public static let textLineHeight: CGFloat = 1.2
    public static let highlighterOpacity: CGFloat = 0.45
    public static let highlighterWidthMultiplier: CGFloat = 3
    public static let historyCap = 50
    /// Web MIN_BOX_EDGE — smallest box dimension a resize may produce.
    public static let minBoxEdge: CGFloat = 3
    /// Drag shorter than this (image-px) does not commit a new shape.
    public static let minDragCommit: CGFloat = 4
    /// Text resize floor (web: Math.max(8, …)).
    public static let minTextFontSize: CGFloat = 8
}

private let idLock = NSLock()
private nonisolated(unsafe) var idSeq = 0
/// Monotonic per-session annotation id — stable, never reused (web newAnnotationId).
public func newAnnotationId() -> AnnotationId {
    idLock.lock(); defer { idLock.unlock() }
    idSeq += 1
    return "a\(idSeq)"
}

/// One annotation. A single struct (not an enum) mirrors the web's
/// discriminated-union-with-shared-fields shape: `kind` says which geometry
/// fields are meaningful. Unused fields stay at their zero values.
///   pen/highlighter: `points` (flattened [x0,y0,x1,y1,…])
///   rect/ellipse/blur: `x,y,width,height` (normalized: width/height ≥ 0)
///   arrow: `from`,`to`
///   text: `x,y,text,fontSize`
/// color+thickness apply to pen/highlighter/rect/ellipse/arrow; color+fontSize to text.
public struct Annotation: Equatable, Sendable {
    public var id: AnnotationId
    public var kind: AnnotationKind
    public var points: [CGFloat] = []
    public var x: CGFloat = 0
    public var y: CGFloat = 0
    public var width: CGFloat = 0
    public var height: CGFloat = 0
    public var from: CGPoint = .zero
    public var to: CGPoint = .zero
    public var text: String = ""
    public var color: UInt32 = 0xFFFF3B30
    public var thickness: CGFloat = 4
    public var fontSize: CGFloat = 24

    // Factory helpers — the only supported way to construct shapes, so every
    // kind starts with exactly the fields that matter set.
    public static func pen(points: [CGFloat], color: UInt32, thickness: CGFloat) -> Annotation {
        var a = Annotation(id: newAnnotationId(), kind: .pen)
        a.points = points; a.color = color; a.thickness = thickness; return a
    }
    public static func highlighter(points: [CGFloat], color: UInt32, thickness: CGFloat) -> Annotation {
        var a = Annotation(id: newAnnotationId(), kind: .highlighter)
        a.points = points; a.color = color; a.thickness = thickness; return a
    }
    public static func rect(x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat, color: UInt32, thickness: CGFloat) -> Annotation {
        var a = Annotation(id: newAnnotationId(), kind: .rect)
        a.x = x; a.y = y; a.width = width; a.height = height; a.color = color; a.thickness = thickness; return a
    }
    public static func ellipse(x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat, color: UInt32, thickness: CGFloat) -> Annotation {
        var a = Annotation(id: newAnnotationId(), kind: .ellipse)
        a.x = x; a.y = y; a.width = width; a.height = height; a.color = color; a.thickness = thickness; return a
    }
    public static func arrow(from: CGPoint, to: CGPoint, color: UInt32, thickness: CGFloat) -> Annotation {
        var a = Annotation(id: newAnnotationId(), kind: .arrow)
        a.from = from; a.to = to; a.color = color; a.thickness = thickness; return a
    }
    public static func text(x: CGFloat, y: CGFloat, text: String, color: UInt32, fontSize: CGFloat) -> Annotation {
        var a = Annotation(id: newAnnotationId(), kind: .text)
        a.x = x; a.y = y; a.text = text; a.color = color; a.fontSize = fontSize; return a
    }
    public static func blur(x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat) -> Annotation {
        var a = Annotation(id: newAnnotationId(), kind: .blur)
        a.x = x; a.y = y; a.width = width; a.height = height; return a
    }
}

/// Snapshot undo/redo history (web EditorHistory). `push` records the state
/// BEFORE an edit and invalidates redo. Annotation structs are value types,
/// so snapshots are cheap copies.
public struct EditorHistory: Equatable, Sendable {
    public private(set) var past: [[Annotation]] = []
    public private(set) var future: [[Annotation]] = []
    public init() {}

    public var canUndo: Bool { !past.isEmpty }
    public var canRedo: Bool { !future.isEmpty }

    public mutating func push(snapshot: [Annotation]) {
        past.append(snapshot)
        if past.count > AnnotationConstants.historyCap {
            past.removeFirst(past.count - AnnotationConstants.historyCap)
        }
        future = []
    }

    /// Returns the previous annotation array, or nil when nothing to undo.
    public mutating func undo(current: [Annotation]) -> [Annotation]? {
        guard let previous = past.popLast() else { return nil }
        future.append(current)
        return previous
    }

    public mutating func redo(current: [Annotation]) -> [Annotation]? {
        guard let next = future.popLast() else { return nil }
        past.append(current)
        return next
    }
}

// MARK: - Geometry (web annotation-model.ts geometry helpers + native hit-testing)

/// Top-left-normalized bounding box for box-kind shapes; for pen/highlighter
/// the point-cloud AABB; for arrow the endpoint AABB.
public func normalizedBox(_ a: Annotation) -> CGRect {
    switch a.kind {
    case .rect, .ellipse, .blur, .text:
        var x = a.x, y = a.y, w = a.width, h = a.height
        if w < 0 { x += w; w = -w }
        if h < 0 { y += h; h = -h }
        return CGRect(x: x, y: y, width: w, height: h)
    case .arrow:
        return CGRect(x: min(a.from.x, a.to.x), y: min(a.from.y, a.to.y),
                      width: abs(a.from.x - a.to.x), height: abs(a.from.y - a.to.y))
    case .pen, .highlighter:
        guard a.points.count >= 2 else { return .zero }
        var minX = a.points[0], maxX = a.points[0], minY = a.points[1], maxY = a.points[1]
        var i = 0
        while i + 1 < a.points.count {
            minX = min(minX, a.points[i]); maxX = max(maxX, a.points[i])
            minY = min(minY, a.points[i + 1]); maxY = max(maxY, a.points[i + 1])
            i += 2
        }
        return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    }
}

/// Commit gate for a just-drawn shape. Box kinds (rect/ellipse/blur/text)
/// require BOTH dimensions ≥ minDragCommit — a degenerate redaction would
/// bake as a zero-area rect that hides nothing (PRIV-03). Strokes and
/// arrows use total drag extent (bounding-box diagonal).
public func meetsCommitThreshold(_ a: Annotation) -> Bool {
    let box = normalizedBox(a)
    switch a.kind {
    case .rect, .ellipse, .blur, .text:
        return min(box.width, box.height) >= AnnotationConstants.minDragCommit
    case .pen, .highlighter, .arrow:
        return hypot(box.width, box.height) >= AnnotationConstants.minDragCommit
    }
}

/// Copy of `a` shifted by (dx, dy) — handles every kind (web translateAnnotation).
public func translateAnnotation(_ a: Annotation, dx: CGFloat, dy: CGFloat) -> Annotation {
    var out = a
    switch a.kind {
    case .pen, .highlighter:
        out.points = a.points.enumerated().map { i, v in i % 2 == 0 ? v + dx : v + dy }
    case .arrow:
        out.from = CGPoint(x: a.from.x + dx, y: a.from.y + dy)
        out.to = CGPoint(x: a.to.x + dx, y: a.to.y + dy)
    case .rect, .ellipse, .blur, .text:
        out.x += dx; out.y += dy
    }
    return out
}

private func distanceToSegment(_ p: CGPoint, _ a: CGPoint, _ b: CGPoint) -> CGFloat {
    let abx = b.x - a.x, aby = b.y - a.y
    let lenSq = abx * abx + aby * aby
    guard lenSq > 0 else { return hypot(p.x - a.x, p.y - a.y) }
    let t = max(0, min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq))
    return hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby))
}

private func hits(_ a: Annotation, _ p: CGPoint, _ tolerance: CGFloat) -> Bool {
    switch a.kind {
    case .rect, .ellipse, .blur, .text:
        // FULL INTERIOR hit area (web QA lock) — outline-only shapes still
        // select from the middle. Inflate by tolerance for edge grabs.
        return normalizedBox(a).insetBy(dx: -tolerance, dy: -tolerance).contains(p)
    case .arrow:
        return distanceToSegment(p, a.from, a.to) <= max(a.thickness / 2, tolerance)
    case .pen, .highlighter:
        let reach = max(a.thickness / 2, tolerance)
        var i = 0
        while i + 3 < a.points.count {
            let s = CGPoint(x: a.points[i], y: a.points[i + 1])
            let e = CGPoint(x: a.points[i + 2], y: a.points[i + 3])
            if distanceToSegment(p, s, e) <= reach { return true }
            i += 2
        }
        if a.points.count == 2 {
            return hypot(p.x - a.points[0], p.y - a.points[1]) <= reach
        }
        return false
    }
}

/// Topmost hit wins — iterate back-to-front (array order is z-order).
public func hitTest(_ annotations: [Annotation], at p: CGPoint, tolerance: CGFloat) -> AnnotationId? {
    for a in annotations.reversed() where hits(a, p, tolerance) { return a.id }
    return nil
}

// MARK: - Resize handles (web RESIZABLE_KINDS = rect/ellipse/blur/text; arrows
// get endpoint handles; freehand strokes are move-only)

public enum Corner: Equatable, Sendable { case topLeft, topRight, bottomLeft, bottomRight }
public enum HandleKind: Equatable, Sendable { case corner(Corner), arrowFrom, arrowTo }

public func handles(for a: Annotation) -> [(kind: HandleKind, position: CGPoint)] {
    switch a.kind {
    case .rect, .ellipse, .blur, .text:
        let b = normalizedBox(a)
        return [
            (.corner(.topLeft), CGPoint(x: b.minX, y: b.minY)),
            (.corner(.topRight), CGPoint(x: b.maxX, y: b.minY)),
            (.corner(.bottomLeft), CGPoint(x: b.minX, y: b.maxY)),
            (.corner(.bottomRight), CGPoint(x: b.maxX, y: b.maxY)),
        ]
    case .arrow:
        return [(.arrowFrom, a.from), (.arrowTo, a.to)]
    case .pen, .highlighter:
        return []
    }
}

/// Apply a handle drag. Box kinds: the dragged corner follows `p`, opposite
/// corner anchors, edges clamp to minBoxEdge. Text: fontSize scales by the
/// width ratio (web handleTransformEnd), floor minTextFontSize — the box is
/// re-measured by the editor afterwards. Arrow: dragged endpoint follows `p`.
public func applyResize(_ a: Annotation, handle: HandleKind, to p: CGPoint) -> Annotation {
    var out = a
    switch handle {
    case .arrowFrom: out.from = p; return out
    case .arrowTo: out.to = p; return out
    case .corner(let corner):
        let b = normalizedBox(a)
        let anchor: CGPoint
        switch corner {
        case .topLeft: anchor = CGPoint(x: b.maxX, y: b.maxY)
        case .topRight: anchor = CGPoint(x: b.minX, y: b.maxY)
        case .bottomLeft: anchor = CGPoint(x: b.maxX, y: b.minY)
        case .bottomRight: anchor = CGPoint(x: b.minX, y: b.minY)
        }
        let minEdge = AnnotationConstants.minBoxEdge
        var w = p.x - anchor.x, h = p.y - anchor.y
        if abs(w) < minEdge { w = w < 0 ? -minEdge : minEdge }
        if abs(h) < minEdge { h = h < 0 ? -minEdge : minEdge }
        if a.kind == .text {
            let oldW = max(b.width, 1)
            let scale = abs(w) / oldW
            out.fontSize = max(AnnotationConstants.minTextFontSize, (a.fontSize * scale).rounded())
            out.x = min(anchor.x, anchor.x + w)
            out.y = min(anchor.y, anchor.y + h)
            out.width = abs(w)
            out.height = abs(h)
            return out
        }
        out.x = min(anchor.x, anchor.x + w)
        out.y = min(anchor.y, anchor.y + h)
        out.width = abs(w)
        out.height = abs(h)
        return out
    }
}
