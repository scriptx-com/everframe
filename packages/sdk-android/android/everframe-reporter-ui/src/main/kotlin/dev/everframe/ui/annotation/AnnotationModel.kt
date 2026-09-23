// AnnotationModel.kt
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Pure annotation model — Kotlin port of packages/sdk-react/src/reporter-ui/
// annotation-model.ts (report-window overhaul). NO android.* or Compose
// imports: plain-JVM testable. All geometry is in IMAGE-PIXEL space —
// ImageTransform owns view↔image conversion.
package dev.everframe.ui.annotation

import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

typealias AnnotationId = String

enum class AnnotationKind { PEN, HIGHLIGHTER, RECT, ELLIPSE, ARROW, TEXT, BLUR }

object AnnotationConstants {
    /** 5-color palette — identical values to web PEN_COLORS. */
    val PEN_COLORS: List<Long> = listOf(0xFFFF3B30, 0xFFFFCC00, 0xFF32ADE6, 0xFFFFFFFF, 0xFF000000)
    val PEN_THICKNESSES: List<Float> = listOf(2f, 4f, 8f)
    /** S/M/L text sizes in image-px (web TEXT_FONT_SIZES). */
    val TEXT_FONT_SIZES: List<Float> = listOf(16f, 24f, 36f)
    const val TEXT_LINE_HEIGHT = 1.2f
    const val HIGHLIGHTER_OPACITY = 0.45f
    const val HIGHLIGHTER_WIDTH_MULTIPLIER = 3f
    const val HISTORY_CAP = 50
    /** Web MIN_BOX_EDGE. */
    const val MIN_BOX_EDGE = 3f
    /** Drags shorter than this (image-px) do not commit a shape. */
    const val MIN_DRAG_COMMIT = 4f
    const val MIN_TEXT_FONT_SIZE = 8f
}

private val idSeq = AtomicInteger(0)
/** Monotonic per-session annotation id (web newAnnotationId). */
fun newAnnotationId(): AnnotationId = "a${idSeq.incrementAndGet()}"

/**
 * One annotation. A single data class mirrors the web discriminated union:
 * [kind] says which fields are meaningful; unused fields keep zero values.
 *   PEN/HIGHLIGHTER: [points] flattened [x0,y0,x1,y1,…]
 *   RECT/ELLIPSE/BLUR: [x],[y],[width],[height]
 *   ARROW: [fromX],[fromY],[toX],[toY]
 *   TEXT: [x],[y],[text],[fontSize]
 */
data class Annotation(
    val id: AnnotationId,
    val kind: AnnotationKind,
    val points: List<Float> = emptyList(),
    val x: Float = 0f,
    val y: Float = 0f,
    val width: Float = 0f,
    val height: Float = 0f,
    val fromX: Float = 0f,
    val fromY: Float = 0f,
    val toX: Float = 0f,
    val toY: Float = 0f,
    val text: String = "",
    val color: Long = 0xFFFF3B30,
    val thickness: Float = 4f,
    val fontSize: Float = 24f,
) {
    companion object {
        fun pen(points: List<Float>, color: Long, thickness: Float) =
            Annotation(newAnnotationId(), AnnotationKind.PEN, points = points, color = color, thickness = thickness)
        fun highlighter(points: List<Float>, color: Long, thickness: Float) =
            Annotation(newAnnotationId(), AnnotationKind.HIGHLIGHTER, points = points, color = color, thickness = thickness)
        fun rect(x: Float, y: Float, width: Float, height: Float, color: Long, thickness: Float) =
            Annotation(newAnnotationId(), AnnotationKind.RECT, x = x, y = y, width = width, height = height, color = color, thickness = thickness)
        fun ellipse(x: Float, y: Float, width: Float, height: Float, color: Long, thickness: Float) =
            Annotation(newAnnotationId(), AnnotationKind.ELLIPSE, x = x, y = y, width = width, height = height, color = color, thickness = thickness)
        fun arrow(fromX: Float, fromY: Float, toX: Float, toY: Float, color: Long, thickness: Float) =
            Annotation(newAnnotationId(), AnnotationKind.ARROW, fromX = fromX, fromY = fromY, toX = toX, toY = toY, color = color, thickness = thickness)
        fun text(x: Float, y: Float, text: String, color: Long, fontSize: Float) =
            Annotation(newAnnotationId(), AnnotationKind.TEXT, x = x, y = y, text = text, color = color, fontSize = fontSize)
        fun blur(x: Float, y: Float, width: Float, height: Float) =
            Annotation(newAnnotationId(), AnnotationKind.BLUR, x = x, y = y, width = width, height = height)
    }
}

/**
 * Snapshot undo/redo (web EditorHistory) as an IMMUTABLE VALUE — every
 * operation returns a new instance, so a Compose `mutableStateOf` holding it
 * recomposes naturally. `push` records the state BEFORE an edit and clears redo.
 */
data class EditorHistory(
    val past: List<List<Annotation>> = emptyList(),
    val future: List<List<Annotation>> = emptyList(),
) {
    val canUndo: Boolean get() = past.isNotEmpty()
    val canRedo: Boolean get() = future.isNotEmpty()

    fun push(snapshot: List<Annotation>): EditorHistory =
        EditorHistory(past = (past + listOf(snapshot)).takeLast(AnnotationConstants.HISTORY_CAP), future = emptyList())

    data class Restored(val history: EditorHistory, val annotations: List<Annotation>)

    fun undo(current: List<Annotation>): Restored? {
        val previous = past.lastOrNull() ?: return null
        return Restored(EditorHistory(past.dropLast(1), future + listOf(current)), previous)
    }

    fun redo(current: List<Annotation>): Restored? {
        val next = future.lastOrNull() ?: return null
        return Restored(EditorHistory(past + listOf(current), future.dropLast(1)), next)
    }
}

// MARK: - Geometry (web annotation-model.ts geometry helpers + native hit-testing)
// Kotlin port of AnnotationModel.swift's geometry section — see that file's
// comments for the "why" behind each algorithm. No android.graphics import:
// [Box] stands in for CGRect so this file stays plain-JVM testable.

/** Top-left-normalized rectangle. Stands in for CGRect/android.graphics.RectF. */
data class Box(val x: Float, val y: Float, val width: Float, val height: Float) {
    val minX: Float get() = x
    val minY: Float get() = y
    val maxX: Float get() = x + width
    val maxY: Float get() = y + height
}

/** Point-in-box test (inclusive edges), like CGRect.contains. */
fun Box.contains(px: Float, py: Float): Boolean = px in minX..maxX && py in minY..maxY

/** Grows (or shrinks, for negative [t]) the box by [t] on every side, like CGRect.insetBy(-t, -t). */
fun Box.inflate(t: Float): Box = Box(x - t, y - t, width + 2 * t, height + 2 * t)

/**
 * Top-left-normalized bounding box for box-kind shapes; for pen/highlighter
 * the point-cloud AABB; for arrow the endpoint AABB.
 */
fun normalizedBox(a: Annotation): Box = when (a.kind) {
    AnnotationKind.RECT, AnnotationKind.ELLIPSE, AnnotationKind.BLUR, AnnotationKind.TEXT -> {
        var x = a.x; var y = a.y; var w = a.width; var h = a.height
        if (w < 0) { x += w; w = -w }
        if (h < 0) { y += h; h = -h }
        Box(x, y, w, h)
    }
    AnnotationKind.ARROW -> Box(
        x = min(a.fromX, a.toX),
        y = min(a.fromY, a.toY),
        width = abs(a.fromX - a.toX),
        height = abs(a.fromY - a.toY),
    )
    AnnotationKind.PEN, AnnotationKind.HIGHLIGHTER -> {
        if (a.points.size < 2) {
            Box(0f, 0f, 0f, 0f)
        } else {
            var minXv = a.points[0]; var maxXv = a.points[0]
            var minYv = a.points[1]; var maxYv = a.points[1]
            var i = 0
            while (i + 1 < a.points.size) {
                minXv = min(minXv, a.points[i]); maxXv = max(maxXv, a.points[i])
                minYv = min(minYv, a.points[i + 1]); maxYv = max(maxYv, a.points[i + 1])
                i += 2
            }
            Box(minXv, minYv, maxXv - minXv, maxYv - minYv)
        }
    }
}

/**
 * Commit gate for a just-drawn shape. Box kinds (rect/ellipse/blur/text)
 * require BOTH dimensions >= MIN_DRAG_COMMIT — a degenerate redaction would
 * bake as a zero-area rect that hides nothing (PRIV-03). Strokes and arrows
 * use total drag extent (bounding-box diagonal).
 */
fun meetsCommitThreshold(a: Annotation): Boolean {
    val box = normalizedBox(a)
    return when (a.kind) {
        AnnotationKind.RECT, AnnotationKind.ELLIPSE, AnnotationKind.BLUR, AnnotationKind.TEXT ->
            min(box.width, box.height) >= AnnotationConstants.MIN_DRAG_COMMIT
        AnnotationKind.PEN, AnnotationKind.HIGHLIGHTER, AnnotationKind.ARROW ->
            hypot(box.width, box.height) >= AnnotationConstants.MIN_DRAG_COMMIT
    }
}

/** Copy of [a] shifted by (dx, dy) — handles every kind (web translateAnnotation). */
fun translateAnnotation(a: Annotation, dx: Float, dy: Float): Annotation = when (a.kind) {
    AnnotationKind.PEN, AnnotationKind.HIGHLIGHTER ->
        a.copy(points = a.points.mapIndexed { i, v -> if (i % 2 == 0) v + dx else v + dy })
    AnnotationKind.ARROW ->
        a.copy(fromX = a.fromX + dx, fromY = a.fromY + dy, toX = a.toX + dx, toY = a.toY + dy)
    AnnotationKind.RECT, AnnotationKind.ELLIPSE, AnnotationKind.BLUR, AnnotationKind.TEXT ->
        a.copy(x = a.x + dx, y = a.y + dy)
}

private fun distanceToSegment(px: Float, py: Float, ax: Float, ay: Float, bx: Float, by: Float): Float {
    val abx = bx - ax; val aby = by - ay
    val lenSq = abx * abx + aby * aby
    if (lenSq <= 0f) return hypot(px - ax, py - ay)
    val t = max(0f, min(1f, ((px - ax) * abx + (py - ay) * aby) / lenSq))
    return hypot(px - (ax + t * abx), py - (ay + t * aby))
}

private fun hits(a: Annotation, px: Float, py: Float, tolerance: Float): Boolean = when (a.kind) {
    AnnotationKind.RECT, AnnotationKind.ELLIPSE, AnnotationKind.BLUR, AnnotationKind.TEXT ->
        // FULL INTERIOR hit area (web QA lock) — outline-only shapes still
        // select from the middle. Inflate by tolerance for edge grabs.
        normalizedBox(a).inflate(tolerance).contains(px, py)
    AnnotationKind.ARROW ->
        distanceToSegment(px, py, a.fromX, a.fromY, a.toX, a.toY) <= max(a.thickness / 2, tolerance)
    AnnotationKind.PEN, AnnotationKind.HIGHLIGHTER -> {
        val reach = max(a.thickness / 2, tolerance)
        var i = 0
        var hit = false
        while (i + 3 < a.points.size) {
            if (distanceToSegment(px, py, a.points[i], a.points[i + 1], a.points[i + 2], a.points[i + 3]) <= reach) {
                hit = true; break
            }
            i += 2
        }
        if (!hit && a.points.size == 2) {
            hit = hypot(px - a.points[0], py - a.points[1]) <= reach
        }
        hit
    }
}

/** Topmost hit wins — iterate back-to-front (list order is z-order). */
fun hitTest(annotations: List<Annotation>, px: Float, py: Float, tolerance: Float): AnnotationId? {
    for (a in annotations.asReversed()) {
        if (hits(a, px, py, tolerance)) return a.id
    }
    return null
}

// MARK: - Resize handles (web RESIZABLE_KINDS = rect/ellipse/blur/text; arrows
// get endpoint handles; freehand strokes are move-only)

enum class HandleKind { TOP_LEFT, TOP_RIGHT, BOTTOM_LEFT, BOTTOM_RIGHT, ARROW_FROM, ARROW_TO }

data class Handle(val kind: HandleKind, val x: Float, val y: Float)

fun handles(a: Annotation): List<Handle> = when (a.kind) {
    AnnotationKind.RECT, AnnotationKind.ELLIPSE, AnnotationKind.BLUR, AnnotationKind.TEXT -> {
        val b = normalizedBox(a)
        listOf(
            Handle(HandleKind.TOP_LEFT, b.minX, b.minY),
            Handle(HandleKind.TOP_RIGHT, b.maxX, b.minY),
            Handle(HandleKind.BOTTOM_LEFT, b.minX, b.maxY),
            Handle(HandleKind.BOTTOM_RIGHT, b.maxX, b.maxY),
        )
    }
    AnnotationKind.ARROW -> listOf(
        Handle(HandleKind.ARROW_FROM, a.fromX, a.fromY),
        Handle(HandleKind.ARROW_TO, a.toX, a.toY),
    )
    AnnotationKind.PEN, AnnotationKind.HIGHLIGHTER -> emptyList()
}

/**
 * Apply a handle drag. Box kinds: the dragged corner follows (px, py),
 * opposite corner anchors, edges clamp to MIN_BOX_EDGE. Text: fontSize scales
 * by the width ratio (web handleTransformEnd), floor MIN_TEXT_FONT_SIZE —
 * width/height update ALONGSIDE x/y so the anchor corner stays pinned (iOS
 * Task-2 review fix — the original snippet updated fontSize but dropped x/y/
 * width/height, letting the anchor drift). Arrow: dragged endpoint follows
 * (px, py).
 */
fun applyResize(a: Annotation, handle: HandleKind, px: Float, py: Float): Annotation {
    when (handle) {
        HandleKind.ARROW_FROM -> return a.copy(fromX = px, fromY = py)
        HandleKind.ARROW_TO -> return a.copy(toX = px, toY = py)
        else -> {
            val b = normalizedBox(a)
            val anchorX: Float
            val anchorY: Float
            when (handle) {
                HandleKind.TOP_LEFT -> { anchorX = b.maxX; anchorY = b.maxY }
                HandleKind.TOP_RIGHT -> { anchorX = b.minX; anchorY = b.maxY }
                HandleKind.BOTTOM_LEFT -> { anchorX = b.maxX; anchorY = b.minY }
                HandleKind.BOTTOM_RIGHT -> { anchorX = b.minX; anchorY = b.minY }
                else -> error("unreachable: arrow handles returned above")
            }
            val minEdge = AnnotationConstants.MIN_BOX_EDGE
            var w = px - anchorX
            var h = py - anchorY
            if (abs(w) < minEdge) w = if (w < 0) -minEdge else minEdge
            if (abs(h) < minEdge) h = if (h < 0) -minEdge else minEdge

            val newX = min(anchorX, anchorX + w)
            val newY = min(anchorY, anchorY + h)
            val newWidth = abs(w)
            val newHeight = abs(h)

            return if (a.kind == AnnotationKind.TEXT) {
                val oldW = max(b.width, 1f)
                val scale = abs(w) / oldW
                val newFontSize = max(AnnotationConstants.MIN_TEXT_FONT_SIZE, floor(a.fontSize * scale + 0.5f))
                // ties away from zero — matches Swift .rounded() (cross-platform fontSize parity)
                a.copy(fontSize = newFontSize, x = newX, y = newY, width = newWidth, height = newHeight)
            } else {
                a.copy(x = newX, y = newY, width = newWidth, height = newHeight)
            }
        }
    }
}
