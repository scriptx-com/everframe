// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Phase 13.1 — EverframeReporter Annotation Redesign · Plan 13.1-01 (Wave 1)
// Task 6 review fix (round 1): the `.pending` touch-session arbitration
// (inputs: activeTool, onHandle, onShape, selectedId, slop-exceeded / tap;
// output: which session action) is pure value logic that was hiding a bug
// precisely because it lived inline in
// FocusedAnnotationViewController and had no unit coverage. Extracted here,
// alongside AnnotationModel.swift/AnnotationTool.swift, so it compiles and
// is testable under plain `swift test` with no UIKit dependency. The VC's
// TouchSession only executes what these functions decide.
import Foundation

/// Resolution of a drag that exceeded slop (rule 2). Pure — unit-tested;
/// the VC's TouchSession just executes what this decides.
public enum PendingResolution: Equatable {
    case resize(HandleKind)
    case move(AnnotationId)          // move this shape (select it first if not selected)
    case draw
    case ignore
}

/// Arbitration for a pending touch that exceeded slop (rule 2).
public func resolveDrag(
    activeTool: AnnotationTool,
    onHandle: HandleKind?,
    onShape: AnnotationId?,
    selectedId: AnnotationId?
) -> PendingResolution {
    if let handle = onHandle, selectedId != nil { return .resize(handle) }
    if let shape = onShape, shape == selectedId { return .move(shape) }
    if activeTool == .pointer, let shape = onShape { return .move(shape) }
    if isDrawingTool(activeTool) { return .draw }
    return .ignore
}

/// Resolution of a tap (rule 4).
public enum TapResolution: Equatable {
    /// Tapped shape's id — become the selection.
    case select(AnnotationId)
    /// Tapped empty canvas — clear any existing selection. The VC's
    /// `.text`-tool placement hook (`// TASK-8-TEXT`) still runs after this —
    /// deselect-then-place is the web behavior.
    case deselect
}

public func resolveTap(activeTool: AnnotationTool, onShape: AnnotationId?) -> TapResolution {
    if let shape = onShape { return .select(shape) }
    return .deselect
}

/// Drawing tools commit a new shape when a pending drag exceeds slop;
/// `.pointer`/`.text` do not (`.text` places on tap, handled separately).
public func isDrawingTool(_ t: AnnotationTool) -> Bool {
    switch t {
    case .pen, .highlighter, .rect, .ellipse, .arrow, .redact: return true
    case .pointer, .text: return false
    }
}
