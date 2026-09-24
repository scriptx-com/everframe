// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// AnnotationCanvas — Android Task 5 rewrite: model-driven rendering (draws
// the EditorState.annotations list, not tool-specific record collections)
// plus a single one-session gesture recognizer covering draw / select /
// move / resize for all drawing/pointer tools.
//
// Mirrors packages/sdk-ios/Sources/EverframeReporterUI/FocusedAnnotationViewController.swift's
// TouchSession + the model-driven render pass, adapted to Compose Canvas +
// pointerInput's awaitEachGesture primitives. All shape drawing happens in
// raw image-pixel space inside a single `withTransform` block — the same
// coordinate space BakeRenderer.bake draws into — so the live preview lines
// up with the baked composite to within sub-pixel rounding (PRIV-03
// preview==bake honesty, most visible for BLUR which renders solid black
// live, not a translucent preview).
package dev.everframe.ui.annotation

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.awaitTouchSlopOrCancellation
import androidx.compose.foundation.gestures.drag
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import dev.everframe.ui.theme.LocalReporterTheme
import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin

/**
 * Holds the pending annotation list + undo/redo history + selection/tool
 * state for one editing session. Survives configuration changes via
 * rememberSaveable (flat-primitives Saver — see [editorStateSaver]), the
 * same Bundle-survival contract the deleted `AnnotationState` Saver had.
 */
internal class EditorState {
    var annotations: List<Annotation> by mutableStateOf(emptyList())
    var history: EditorHistory by mutableStateOf(EditorHistory())
    var selectedId: AnnotationId? by mutableStateOf(null)
    var activeTool: AnnotationTool by mutableStateOf(AnnotationTool.PEN)
    var activeColor: Long by mutableStateOf(AnnotationConstants.PEN_COLORS[0])
    var activeThickness: Float by mutableStateOf(AnnotationConstants.PEN_THICKNESSES[1])
    var activeFontSize: Float by mutableStateOf(AnnotationConstants.TEXT_FONT_SIZES[1])
}

@Composable
internal fun rememberEditorState(): EditorState =
    rememberSaveable(saver = editorStateSaver()) { EditorState() }

/** Flattens one [Annotation] to a primitive row — order must match [rowToAnnotation]. */
private fun annotationToRow(a: Annotation): List<Any> = listOf(
    a.id, a.kind.name, a.points, a.x, a.y, a.width, a.height,
    a.fromX, a.fromY, a.toX, a.toY, a.text, a.color, a.thickness, a.fontSize,
)

private fun rowToAnnotation(row: List<Any?>): Annotation = Annotation(
    id = row[0] as String,
    kind = AnnotationKind.valueOf(row[1] as String),
    points = (row[2] as? List<*>)?.map { (it as Number).toFloat() } ?: emptyList(),
    x = (row[3] as Number).toFloat(),
    y = (row[4] as Number).toFloat(),
    width = (row[5] as Number).toFloat(),
    height = (row[6] as Number).toFloat(),
    fromX = (row[7] as Number).toFloat(),
    fromY = (row[8] as Number).toFloat(),
    toX = (row[9] as Number).toFloat(),
    toY = (row[10] as Number).toFloat(),
    text = row[11] as String,
    color = (row[12] as Number).toLong(),
    thickness = (row[13] as Number).toFloat(),
    fontSize = (row[14] as Number).toFloat(),
)

@Suppress("UNCHECKED_CAST")
private fun restoreSnapshots(saved: List<List<List<Any?>>>): List<List<Annotation>> =
    saved.map { snapshot -> snapshot.map { row -> rowToAnnotation(row) } }

private fun editorStateSaver(): Saver<EditorState, Any> =
    Saver(
        save = { state ->
            mapOf(
                "annotations" to state.annotations.map { annotationToRow(it) },
                "historyPast" to state.history.past.map { snap -> snap.map { annotationToRow(it) } },
                "historyFuture" to state.history.future.map { snap -> snap.map { annotationToRow(it) } },
                "selectedId" to state.selectedId,
                "tool" to state.activeTool.name,
                "color" to state.activeColor,
                "thickness" to state.activeThickness,
                "fontSize" to state.activeFontSize,
            )
        },
        restore = { saved ->
            @Suppress("UNCHECKED_CAST")
            val m = saved as Map<String, Any?>
            val s = EditorState()
            s.annotations = (m["annotations"] as? List<List<Any?>>)?.map { rowToAnnotation(it) } ?: emptyList()
            @Suppress("UNCHECKED_CAST")
            val past = (m["historyPast"] as? List<List<List<Any?>>>)?.let { restoreSnapshots(it) } ?: emptyList()
            @Suppress("UNCHECKED_CAST")
            val future = (m["historyFuture"] as? List<List<List<Any?>>>)?.let { restoreSnapshots(it) } ?: emptyList()
            s.history = EditorHistory(past = past, future = future)
            s.selectedId = m["selectedId"] as? String
            s.activeTool = AnnotationTool.valueOf(m["tool"] as? String ?: "PEN")
            s.activeColor = (m["color"] as? Number)?.toLong() ?: AnnotationConstants.PEN_COLORS[0]
            s.activeThickness = (m["thickness"] as? Number)?.toFloat() ?: AnnotationConstants.PEN_THICKNESSES[1]
            s.activeFontSize = (m["fontSize"] as? Number)?.toFloat() ?: AnnotationConstants.TEXT_FONT_SIZES[1]
            s
        },
    )

/**
 * Model-driven annotation canvas — Android Task 5. Draws [EditorState.annotations]
 * (plus any in-progress shape) transformed into view space via [ImageTransform],
 * and runs one [awaitEachGesture] session per (tool, transform) covering
 * draw / tap-select / deselect / move / resize for every drawing tool.
 *
 * @param onRequestTextEdit fired on an empty-canvas tap while TEXT is active,
 *  or (Task 6) when re-opening an existing text shape; a no-op default keeps
 *  this composable usable before Task 6 wires the editing overlay.
 * @param commitPendingText deterministic-commit hook (Task 6) — invoked
 *  FIRST on every pointer-down so an in-progress text edit commits before
 *  the new tap/drag acts on the model.
 * @param textEditingId shape currently being text-edited (Task 6) — skipped
 *  by the render pass so the live text-edit overlay owns its pixels.
 */
@Composable
internal fun AnnotationCanvas(
    state: EditorState,
    imageWidth: Float,
    imageHeight: Float,
    modifier: Modifier = Modifier,
    onRequestTextEdit: (imageX: Float, imageY: Float, existingId: AnnotationId?) -> Unit = { _, _, _ -> },
    commitPendingText: () -> Unit = {},
    textEditingId: AnnotationId? = null,
) {
    val theme = LocalReporterTheme.current
    var boxSize by remember { mutableStateOf(IntSize.Zero) }
    val transform = remember(imageWidth, imageHeight, boxSize) {
        ImageTransform(imageWidth, imageHeight, boxSize.width.toFloat(), boxSize.height.toFloat())
    }

    // In-progress shape being drawn (image-px space) — null when idle.
    var inProgress by remember { mutableStateOf<Annotation?>(null) }

    val textPaint = remember {
        android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
            style = android.graphics.Paint.Style.FILL
        }
    }

    Canvas(
        modifier = modifier
            .fillMaxSize()
            .onSizeChanged { boxSize = it }
            .pointerInput(state.activeTool, transform) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    // Web QA lock: commit any in-progress text edit BEFORE
                    // the tap/drag acts on the model (Task 6 fills the hook;
                    // no-op today).
                    commitPendingText()
                    down.consume()

                    val imgDown = Offset(transform.toImageX(down.position.x), transform.toImageY(down.position.y))
                    val selected = state.annotations.firstOrNull { it.id == state.selectedId }
                    val handleRadiusPx = 22.dp.toPx()
                    val onHandle = selected?.let { sel -> nearestHandleWithin(sel, down.position, transform, handleRadiusPx) }
                    val onShape = hitTest(state.annotations, imgDown.x, imgDown.y, 8f / transform.scale)

                    var overSlop = Offset.Zero
                    val drag = awaitTouchSlopOrCancellation(down.id) { change, over ->
                        change.consume()
                        overSlop = over
                    }

                    if (drag == null) {
                        // TAP.
                        when (val res = resolveTap(state.activeTool, onShape)) {
                            is TapResolution.Select -> {
                                // Task 6 lock: tapping an ALREADY-SELECTED
                                // TEXT shape re-opens the inline editor
                                // (second tap on the same shape) — mirrors
                                // iOS gestureEnded's `.select` case, no
                                // activeTool gate (works from any tool, same
                                // as iOS). A first tap (not yet selected)
                                // only selects, same as every other kind.
                                val tappedShape = state.annotations.firstOrNull { it.id == res.id }
                                if (res.id == state.selectedId && tappedShape?.kind == AnnotationKind.TEXT) {
                                    onRequestTextEdit(tappedShape.x, tappedShape.y, tappedShape.id)
                                } else {
                                    state.selectedId = res.id
                                }
                            }
                            TapResolution.Deselect -> {
                                state.selectedId = null
                                if (state.activeTool == AnnotationTool.TEXT) {
                                    onRequestTextEdit(imgDown.x, imgDown.y, null)
                                }
                            }
                        }
                        return@awaitEachGesture
                    }

                    // DRAG.
                    when (val res = resolveDrag(state.activeTool, onHandle, onShape, state.selectedId)) {
                        is PendingResolution.Resize -> {
                            val shape0 = selected ?: return@awaitEachGesture
                            state.history = state.history.push(state.annotations)
                            var current = shape0
                            fun applyAt(pos: Offset) {
                                val ix = transform.toImageX(pos.x)
                                val iy = transform.toImageY(pos.y)
                                current = applyResize(current, res.handle, ix, iy)
                                state.annotations = state.annotations.map { if (it.id == current.id) current else it }
                            }
                            applyAt(drag.position)
                            drag(down.id) { change ->
                                change.consume()
                                applyAt(change.position)
                            }
                            // Task 6 Lock 4: `applyResize`'s width/height for
                            // TEXT is only a live-preview approximation (it
                            // scales fontSize/box linearly from the drag
                            // position) — re-stamp from actual measured text
                            // extent once the drag ends so hit-testing/
                            // handles never drift from what renders.
                            if (current.kind == AnnotationKind.TEXT) {
                                current = restampTextShape(current)
                                state.annotations = state.annotations.map { if (it.id == current.id) current else it }
                            }
                        }
                        is PendingResolution.Move -> {
                            state.selectedId = res.id
                            state.history = state.history.push(state.annotations)
                            var current = state.annotations.first { it.id == res.id }
                            var lastPos = down.position
                            fun applyDeltaTo(pos: Offset) {
                                val dxImg = (pos.x - lastPos.x) / transform.scale
                                val dyImg = (pos.y - lastPos.y) / transform.scale
                                current = translateAnnotation(current, dxImg, dyImg)
                                state.annotations = state.annotations.map { if (it.id == current.id) current else it }
                                lastPos = pos
                            }
                            applyDeltaTo(drag.position)
                            drag(down.id) { change ->
                                change.consume()
                                applyDeltaTo(change.position)
                            }
                        }
                        PendingResolution.Draw -> {
                            var shape = newInProgressShape(state.activeTool, imgDown, state)
                            inProgress = shape
                            fun updateTo(pos: Offset) {
                                val ix = transform.toImageX(pos.x)
                                val iy = transform.toImageY(pos.y)
                                shape = updateInProgressShape(shape, state.activeTool, imgDown, ix, iy)
                                inProgress = shape
                            }
                            updateTo(drag.position)
                            drag(down.id) { change ->
                                change.consume()
                                updateTo(change.position)
                            }
                            if (meetsCommitThreshold(shape)) {
                                state.history = state.history.push(state.annotations)
                                state.annotations = state.annotations + shape
                                state.selectedId = shape.id
                                // Tool stays active (web lock) — no reset here.
                            }
                            inProgress = null
                        }
                        PendingResolution.Ignore -> Unit
                    }
                }
            },
    ) {
        withTransform({
            translate(transform.offsetX, transform.offsetY)
            scale(transform.scale, transform.scale, pivot = Offset.Zero)
        }) {
            // 1. Redactions FIRST as solid black, regardless of array
            //    position — mirrors BakeRenderer.bake so preview == bake
            //    (PRIV-03 honesty: never a translucent "preview" of a
            //    permanent redaction).
            for (a in state.annotations) {
                if (a.kind == AnnotationKind.BLUR && a.id != textEditingId) drawAnnotationShape(a, textPaint)
            }
            // 2. Every other shape, in array order (z-order matches stacking).
            for (a in state.annotations) {
                if (a.kind != AnnotationKind.BLUR && a.id != textEditingId) drawAnnotationShape(a, textPaint)
            }
            // 3. In-progress shape being drawn right now.
            inProgress?.let { drawAnnotationShape(it, textPaint) }

            // 4. Selection chrome for the selected shape (resize handles).
            val sel = state.annotations.firstOrNull { it.id == state.selectedId && it.id != textEditingId }
            if (sel != null) {
                if (sel.kind != AnnotationKind.ARROW) {
                    val b = normalizedBox(sel).inflate(4f / transform.scale)
                    drawRect(
                        color = theme.accent,
                        topLeft = Offset(b.x, b.y),
                        size = Size(b.width, b.height),
                        style = Stroke(
                            width = 2f / transform.scale,
                            pathEffect = PathEffect.dashPathEffect(
                                floatArrayOf(6f / transform.scale, 4f / transform.scale),
                            ),
                        ),
                    )
                }
                val handleRadius = 8f / transform.scale
                for (h in handles(sel)) {
                    drawCircle(color = theme.accent, radius = handleRadius, center = Offset(h.x, h.y))
                    drawCircle(
                        color = Color.White,
                        radius = handleRadius,
                        center = Offset(h.x, h.y),
                        style = Stroke(width = 1.5f / transform.scale),
                    )
                }
            }
        }
    }
}

/**
 * Nearest resize handle of [shape] within [radiusPx] of [viewPos] (VIEW
 * space) — handle hit-testing is against the SELECTED shape ONLY, per the
 * iOS-round lock (never hit-test handles of an unselected shape).
 */
private fun nearestHandleWithin(
    shape: Annotation,
    viewPos: Offset,
    transform: ImageTransform,
    radiusPx: Float,
): HandleKind? {
    var best: HandleKind? = null
    var bestDist = Float.MAX_VALUE
    for (h in handles(shape)) {
        val hv = Offset(transform.toViewX(h.x), transform.toViewY(h.y))
        val d = (hv - viewPos).getDistance()
        if (d <= radiusPx && d < bestDist) {
            bestDist = d
            best = h.kind
        }
    }
    return best
}

private fun newInProgressShape(tool: AnnotationTool, anchor: Offset, state: EditorState): Annotation = when (tool) {
    AnnotationTool.PEN -> Annotation.pen(points = listOf(anchor.x, anchor.y), color = state.activeColor, thickness = state.activeThickness)
    AnnotationTool.HIGHLIGHTER -> Annotation.highlighter(points = listOf(anchor.x, anchor.y), color = state.activeColor, thickness = state.activeThickness)
    AnnotationTool.RECT -> Annotation.rect(anchor.x, anchor.y, 0f, 0f, state.activeColor, state.activeThickness)
    AnnotationTool.ELLIPSE -> Annotation.ellipse(anchor.x, anchor.y, 0f, 0f, state.activeColor, state.activeThickness)
    AnnotationTool.REDACT -> Annotation.blur(anchor.x, anchor.y, 0f, 0f)
    AnnotationTool.ARROW -> Annotation.arrow(anchor.x, anchor.y, anchor.x, anchor.y, state.activeColor, state.activeThickness)
    AnnotationTool.POINTER, AnnotationTool.TEXT ->
        error("$tool is not a drawing tool — isDrawingTool() should have gated this")
}

private fun updateInProgressShape(shape: Annotation, tool: AnnotationTool, anchor: Offset, curX: Float, curY: Float): Annotation = when (tool) {
    AnnotationTool.PEN, AnnotationTool.HIGHLIGHTER -> shape.copy(points = shape.points + listOf(curX, curY))
    AnnotationTool.RECT, AnnotationTool.ELLIPSE, AnnotationTool.REDACT ->
        shape.copy(x = anchor.x, y = anchor.y, width = curX - anchor.x, height = curY - anchor.y)
    AnnotationTool.ARROW -> shape.copy(toX = curX, toY = curY)
    AnnotationTool.POINTER, AnnotationTool.TEXT -> shape
}

/**
 * Draws one annotation in image-px space (caller wraps in withTransform).
 * Structurally mirrors [BakeRenderer.draw] shape-for-shape so the live
 * preview matches the baked composite (same geometry, same paint config).
 */
private fun DrawScope.drawAnnotationShape(
    a: Annotation,
    textPaint: android.graphics.Paint,
) {
    when (a.kind) {
        AnnotationKind.BLUR -> {
            val b = normalizedBox(a)
            drawRect(color = Color.Black, topLeft = Offset(b.x, b.y), size = Size(b.width, b.height))
        }
        AnnotationKind.PEN, AnnotationKind.HIGHLIGHTER -> {
            if (a.points.size < 4) return
            val path = Path().apply {
                moveTo(a.points[0], a.points[1])
                var i = 2
                while (i + 1 < a.points.size) { lineTo(a.points[i], a.points[i + 1]); i += 2 }
            }
            val isHighlighter = a.kind == AnnotationKind.HIGHLIGHTER
            val width = if (isHighlighter) a.thickness * AnnotationConstants.HIGHLIGHTER_WIDTH_MULTIPLIER else a.thickness
            val alpha = if (isHighlighter) AnnotationConstants.HIGHLIGHTER_OPACITY else 1f
            drawPath(
                path = path,
                color = Color(a.color).copy(alpha = alpha),
                style = Stroke(width = width, cap = StrokeCap.Round, join = StrokeJoin.Round),
            )
        }
        AnnotationKind.RECT -> {
            val b = normalizedBox(a)
            drawRect(color = Color(a.color), topLeft = Offset(b.x, b.y), size = Size(b.width, b.height), style = Stroke(width = a.thickness))
        }
        AnnotationKind.ELLIPSE -> {
            val b = normalizedBox(a)
            drawOval(color = Color(a.color), topLeft = Offset(b.x, b.y), size = Size(b.width, b.height), style = Stroke(width = a.thickness))
        }
        AnnotationKind.ARROW -> {
            val color = Color(a.color)
            drawLine(color = color, start = Offset(a.fromX, a.fromY), end = Offset(a.toX, a.toY), strokeWidth = a.thickness)
            val angle = atan2(a.toY - a.fromY, a.toX - a.fromX)
            val headLen = maxOf(12f, a.thickness * 3)
            for (side in floatArrayOf((PI / 6).toFloat(), (-PI / 6).toFloat())) {
                drawLine(
                    color = color,
                    start = Offset(a.toX, a.toY),
                    end = Offset(a.toX - headLen * cos(angle + side), a.toY - headLen * sin(angle + side)),
                    strokeWidth = a.thickness,
                )
            }
        }
        AnnotationKind.TEXT -> {
            drawIntoCanvas { canvas ->
                textPaint.color = a.color.toInt()
                textPaint.textSize = a.fontSize
                // Model y is the text's TOP (web/Konva convention); drawText wants baseline.
                val baseline = a.y - textPaint.fontMetrics.ascent
                var lineY = baseline
                for (line in a.text.split("\n")) {
                    canvas.nativeCanvas.drawText(line, a.x, lineY, textPaint)
                    lineY += a.fontSize * AnnotationConstants.TEXT_LINE_HEIGHT
                }
            }
        }
    }
}
