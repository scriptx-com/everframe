// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Phase 13.1 — Reporter Annotation Redesign · Plan 13.1-01
// Task 5 (native report-window parity): expanded from the original 3-tool
// (Pen/BlurRect/Arrow) set to the full tool rail matching the web/Android
// annotation-model surface. The fullscreen FocusedAnnotationViewController
// holds a `var activeTool: AnnotationTool` and, on each gesture, builds an
// `Annotation` (Annotation/AnnotationModel.swift) of the matching kind rather
// than dispatching to per-tool state machines (those — PenTool/BlurTool/
// ArrowTool — are deleted in this task).
// No UIKit dependency (plain enum) — unfenced so pure code (SessionArbitration.swift)
// and its tests can reference it under plain `swift test` on every platform slice,
// matching AnnotationModel.swift's gating strategy (review fix, Task 6 round 1).
import Foundation

public enum AnnotationTool: Equatable {
    /// Select/move/resize only — draws nothing. Gestures for this tool arrive
    /// in Task 6.
    case pointer
    case pen, highlighter, rect, ellipse, arrow, text
    /// Draws `.blur`-kind shapes (opaque black at bake — PRIV-03).
    case redact
}
