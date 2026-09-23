// SessionArbitration.kt
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Android Task 5 — pure touch-session arbitration. Kotlin port of
// packages/sdk-ios/Sources/EverframeReporterUI/Annotation/SessionArbitration.swift.
//
// The `.pending` touch-session arbitration (inputs: activeTool, onHandle,
// onShape, selectedId, slop-exceeded / tap; output: which session action) is
// pure value logic that was hiding a reviewer-caught bug precisely because
// it lived inline in the gesture handler with no unit coverage. Extracted here, alongside AnnotationModel.kt, so it is plain-JVM
// testable with NO Compose/pointerInput imports. AnnotationCanvas's gesture
// session only EXECUTES what these functions decide.
package dev.everframe.ui.annotation

/** Annotation tool active in the editor. */
enum class AnnotationTool { POINTER, PEN, HIGHLIGHTER, RECT, ELLIPSE, ARROW, TEXT, REDACT }

/** Resolution of a drag that exceeded touch slop (rule 2). Pure — unit-tested; the gesture session just executes what this decides. */
sealed class PendingResolution {
    data class Resize(val handle: HandleKind) : PendingResolution()
    /** Move this shape (select it first if it wasn't already selected). */
    data class Move(val id: AnnotationId) : PendingResolution()
    object Draw : PendingResolution()
    object Ignore : PendingResolution()
}

/** Arbitration for a pending touch that exceeded slop (rule 2). */
fun resolveDrag(
    activeTool: AnnotationTool,
    onHandle: HandleKind?,
    onShape: AnnotationId?,
    selectedId: AnnotationId?,
): PendingResolution {
    if (onHandle != null && selectedId != null) return PendingResolution.Resize(onHandle)
    if (onShape != null && onShape == selectedId) return PendingResolution.Move(onShape)
    if (activeTool == AnnotationTool.POINTER && onShape != null) return PendingResolution.Move(onShape)
    if (isDrawingTool(activeTool)) return PendingResolution.Draw
    return PendingResolution.Ignore
}

/** Resolution of a tap (rule 4). */
sealed class TapResolution {
    /** Tapped shape's id — become the selection. */
    data class Select(val id: AnnotationId) : TapResolution()
    /** Tapped empty canvas — clear any existing selection. The TEXT tool's placement hook still runs after this — deselect-then-place is the web behavior. */
    object Deselect : TapResolution()
}

fun resolveTap(activeTool: AnnotationTool, onShape: AnnotationId?): TapResolution {
    if (onShape != null) return TapResolution.Select(onShape)
    return TapResolution.Deselect
}

/** Drawing tools commit a new shape when a pending drag exceeds slop; POINTER/TEXT do not (TEXT places on tap, handled separately). */
fun isDrawingTool(t: AnnotationTool): Boolean = when (t) {
    AnnotationTool.PEN, AnnotationTool.HIGHLIGHTER, AnnotationTool.RECT,
    AnnotationTool.ELLIPSE, AnnotationTool.ARROW, AnnotationTool.REDACT -> true
    AnnotationTool.POINTER, AnnotationTool.TEXT -> false
}
