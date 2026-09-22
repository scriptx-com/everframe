// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// FocusedAnnotation — Phase 13.1 redesign, Android Task 5 rewire.
//
// Hosted full-screen by ReporterRoot when the user taps the modal screenshot
// thumbnail. Replaces both the Phase 13 inline-canvas-binding flow and the
// previous tablet-side-rails variant with a single layout matching the
// locked visual spec at
// `branding-explorations/bento-duo-blue/console-next/reporter/annotation-preview.html`.
//
// Surface anatomy (top → bottom):
//   • Top bar:           Cancel  |  "EDIT SCREENSHOT" eyebrow  |  Done (accent gradient)
//   • Canvas area:       AnnotationCanvas, model-driven (EditorState)
//   • Top-right cluster: Undo / Redo / Delete IconButtons (floating over canvas)
//   • Bottom palette:    tool rail (9 tools) + style row (swatches/thickness/size + Clear)
//
// Task 5: AnnotationCanvas now renders `EditorState.annotations` directly —
// there is NO bake inside this composable anymore. Done hands the current
// annotation list back to the host (ReporterRoot); ReporterRoot owns the
// BakeRenderer.bake(...) call (needed once, for the collapsed thumbnail
// preview) and re-bakes again at submit time if the user never re-opens the
// editor. This mirrors the iOS TouchSession model: the editor is a pure
// model mutator, baking is the host's job.
package com.traceitx.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.IconButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.painter.BitmapPainter
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.traceitx.ui.annotation.Annotation
import com.traceitx.ui.annotation.AnnotationConstants
import com.traceitx.ui.annotation.AnnotationCanvas
import com.traceitx.ui.annotation.AnnotationId
import com.traceitx.ui.annotation.AnnotationKind
import com.traceitx.ui.annotation.AnnotationTool
import com.traceitx.ui.annotation.EditorState
import com.traceitx.ui.annotation.ImageTransform
import com.traceitx.ui.annotation.TextCommitAction
import com.traceitx.ui.annotation.TextEditOverlay
import com.traceitx.ui.annotation.TextEditSession
import com.traceitx.ui.annotation.restampTextShape
import com.traceitx.ui.annotation.textCommitAction
import com.traceitx.ui.theme.LocalReporterTheme
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Phase 13.1 focused annotation surface.
 *
 * @param sourceBitmap raw screenshot the live canvas draws on top of. Always
 *  the ORIGINAL capture — annotations are model-driven and persist in
 *  [state] across open/close cycles, so there is no more "bake on top of a
 *  previous bake" layering (Task 4/5 simplification).
 * @param state shared editor state — mutations propagate after Done.
 * @param onCancel close without baking. Task 6: still commits any in-flight
 *  inline text edit first (via `commitPendingText()`) — this surface's
 *  "Cancel" only skips the bake, it never discards other annotation work
 *  already applied to [state], so a live text draft follows the same rule.
 * @param onDone close and hand back the current annotation list; the host
 *  bakes (no bake happens in this composable). Also commits any in-flight
 *  inline text edit first.
 */
@Composable
internal fun FocusedAnnotation(
    sourceBitmap: android.graphics.Bitmap,
    state: EditorState,
    onCancel: () -> Unit,
    onDone: (annotations: List<Annotation>) -> Unit,
    imageWidth: Float,
    imageHeight: Float,
    modifier: Modifier = Modifier,
) {
    val theme = LocalReporterTheme.current
    // ---------------- Task 6: inline text-editing session ----------------
    // `textSession` non-null means the inline editor is up; `textFieldValue`
    // is the ONE hoisted holder every commit call site reads from — see
    // TextEditOverlay.kt's file doc comment for why this beats a
    // callback-supplied value (focus-loss-ordering race, the web/iOS
    // lesson this task is explicitly avoiding).
    var textSession by remember { mutableStateOf<TextEditSession?>(null) }
    var textFieldValue by remember { mutableStateOf(TextFieldValue("")) }

    // The canvas card's rendered size/position, tracked independently from
    // AnnotationCanvas's own internal `boxSize` (Task 5, private to that
    // composable) but landing on an IDENTICAL ImageTransform, since both
    // read the size of the SAME fillMaxSize() card Box below.
    // TextEditOverlay needs this transform to line its anchor up with
    // AnnotationCanvas's own image-px -> view-px mapping.
    var canvasBoxSize by remember { mutableStateOf(IntSize.Zero) }
    var cardPositionInRootY by remember { mutableStateOf(0f) }
    var rootHeightPx by remember { mutableStateOf(0f) }
    var editorHeightPx by remember { mutableStateOf(0f) }
    val transform = remember(imageWidth, imageHeight, canvasBoxSize) {
        ImageTransform(imageWidth, imageHeight, canvasBoxSize.width.toFloat(), canvasBoxSize.height.toFloat())
    }

    /**
     * Executes the pure [textCommitAction] decision. The ONLY place that
     * tears down `textSession` / mutates `state.annotations`/`state.history`
     * for a text edit — every other mutation entry point in this file calls
     * this FIRST (see task-6-report.md's mutation-site audit table).
     * Session state is cleared BEFORE the branch runs — re-entrancy: if a
     * downstream mutation somehow triggers a nested commit call within the
     * same call stack, the guard below makes it a no-op instead of
     * double-committing (same discipline as iOS's `commitTextEditingIfAny`).
     */
    val commitPendingText: () -> Unit = commit@{
        val session = textSession ?: return@commit
        textSession = null
        val raw = textFieldValue.text
        when (val action = textCommitAction(session.existingId, raw)) {
            TextCommitAction.Cancel -> Unit // no history entry — a never-committed placement isn't an edit.
            TextCommitAction.AppendNew -> {
                state.history = state.history.push(state.annotations)
                val shape = restampTextShape(
                    Annotation.text(
                        x = session.imageX,
                        y = session.imageY,
                        text = raw.trim(),
                        color = session.color,
                        fontSize = session.fontSize,
                    ),
                )
                state.annotations = state.annotations + shape
                state.selectedId = shape.id
            }
            is TextCommitAction.Patch -> {
                state.history = state.history.push(state.annotations)
                state.annotations = state.annotations.map {
                    if (it.id == action.id) restampTextShape(it.copy(text = raw.trim())) else it
                }
            }
            is TextCommitAction.Delete -> {
                state.history = state.history.push(state.annotations)
                state.annotations = state.annotations.filterNot { it.id == action.id }
                if (state.selectedId == action.id) state.selectedId = null
            }
        }
    }

    /**
     * AnnotationCanvas hook — fired for a TEXT-tool empty-canvas tap (new
     * placement, `existingId == null`) or a second tap on an already-
     * selected TEXT shape (re-edit, `existingId` = that shape's id; Task 6
     * AnnotationCanvas.kt lock). Existing-shape origin/color/fontSize come
     * from the SHAPE itself, not the toolbar defaults.
     */
    val onRequestTextEdit: (imageX: Float, imageY: Float, existingId: AnnotationId?) -> Unit = { x, y, existingId ->
        val existing = existingId?.let { id -> state.annotations.firstOrNull { it.id == id } }
        val initial = existing?.text ?: ""
        textFieldValue = TextFieldValue(initial, selection = TextRange(initial.length))
        textSession = TextEditSession(
            imageX = x,
            imageY = y,
            existingId = existingId,
            initialText = initial,
            color = existing?.color ?: state.activeColor,
            fontSize = existing?.fontSize ?: state.activeFontSize,
        )
    }

    // System back closes just the inline editor (commit, don't discard)
    // while a session is up, instead of propagating to the outer dialog's
    // own BackHandler — same "commit before leaving" contract as
    // Cancel/Done below (brief: "by Done, and by back/dismiss").
    BackHandler(enabled = textSession != null) { commitPendingText() }

    val onCancelClick: () -> Unit = { commitPendingText(); onCancel() }
    val onDoneClick: () -> Unit = { commitPendingText(); onDone(state.annotations) }

    val onUndo: () -> Unit = {
        commitPendingText()
        state.history.undo(state.annotations)?.let { r ->
            state.history = r.history
            state.annotations = r.annotations
            if (state.annotations.none { it.id == state.selectedId }) state.selectedId = null
        }
    }
    val onRedo: () -> Unit = {
        commitPendingText()
        state.history.redo(state.annotations)?.let { r ->
            state.history = r.history
            state.annotations = r.annotations
            if (state.annotations.none { it.id == state.selectedId }) state.selectedId = null
        }
    }
    val onDelete: () -> Unit = {
        commitPendingText()
        val sel = state.selectedId
        if (sel != null) {
            state.history = state.history.push(state.annotations)
            state.annotations = state.annotations.filterNot { it.id == sel }
            state.selectedId = null
        }
    }
    val onClear: () -> Unit = {
        commitPendingText()
        if (state.annotations.isNotEmpty()) {
            state.history = state.history.push(state.annotations)
            state.annotations = emptyList()
            state.selectedId = null
        }
    }

    // Task 6 Lock 5 — IME insets: shift the canvas area up by exactly the
    // overlap between the editor's bottom edge and the keyboard's top edge,
    // animated alongside the IME's own show/hide. Compose recomposes
    // `WindowInsets.ime` continuously (not a one-shot notification like
    // UIKit), so this is correct whether a session STARTS with the
    // keyboard already up or the keyboard opens mid-session — no
    // notification-replay hack needed here (iOS Important finding).
    val density = LocalDensity.current
    val imeBottomPx = WindowInsets.ime.getBottom(density).toFloat()
    val canvasShift = remember { Animatable(0f) }
    LaunchedEffect(textSession, imeBottomPx, cardPositionInRootY, rootHeightPx, editorHeightPx) {
        val session = textSession
        val target = if (session == null || imeBottomPx <= 0f || rootHeightPx <= 0f) {
            0f
        } else {
            // Undo any shift already applied before measuring the overlap —
            // `cardPositionInRootY` is read DOWNSTREAM of the offset
            // applied below, so it already reflects the last-applied shift;
            // adding it back gives the UNSHIFTED baseline (iOS
            // `applyKeyboardShift`'s `unshiftedMaxY` trick).
            val unshiftedCardTop = cardPositionInRootY + canvasShift.value
            val editorBottom = unshiftedCardTop + transform.toViewY(session.imageY) + editorHeightPx
            val imeTop = rootHeightPx - imeBottomPx
            max(0f, editorBottom - imeTop + with(density) { 8.dp.toPx() })
        }
        canvasShift.animateTo(target, animationSpec = tween(220))
    }

    Box(
        modifier
            .fillMaxSize()
            // Task 10 (quiet-instrument): was a bespoke near-black literal —
            // now the same Bg token as the rest of the reporter (no separate
            // "editor" surface color).
            .background(theme.bg)
            .onGloballyPositioned { rootHeightPx = it.size.height.toFloat() },
    ) {
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val tablet = maxWidth >= 720.dp
            Column(modifier = Modifier.fillMaxSize()) {
                FocusedTopBar(onCancel = onCancelClick, onDone = onDoneClick, doneEnabled = true)

                // Canvas + floating history cluster — shifted up by
                // `canvasShift` while the IME would otherwise cover the
                // inline text editor.
                Box(
                    modifier = Modifier
                        .padding(horizontal = 14.dp)
                        .weight(1f)
                        .fillMaxWidth()
                        .offset { IntOffset(0, -canvasShift.value.roundToInt()) },
                ) {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            // Task 10 (quiet-instrument): web's canvas frame
                            // (.txx-annotate-canvas-frame) is a quiet white
                            // surface with a hairline border and a neutral
                            // ambient shadow — the screenshot is the subject,
                            // the frame stays out of the way. Was an accent
                            // glow + accent border.
                            .shadow(
                                elevation = 20.dp,
                                shape = RoundedCornerShape(10.dp),
                                ambientColor = Color.Black,
                                spotColor = Color.Black,
                            )
                            .clip(RoundedCornerShape(10.dp))
                            .background(Color.White)
                            .border(1.dp, theme.hair, RoundedCornerShape(10.dp))
                            .onGloballyPositioned { coords ->
                                canvasBoxSize = coords.size
                                cardPositionInRootY = coords.positionInRoot().y
                            },
                    ) {
                        // Stack the captured screenshot under the annotation
                        // canvas so the user paints on top of the actual capture.
                        androidx.compose.foundation.Image(
                            painter = BitmapPainter(sourceBitmap.asImageBitmap()),
                            contentDescription = "Captured screenshot",
                            modifier = Modifier.fillMaxSize(),
                        )
                        AnnotationCanvas(
                            state = state,
                            imageWidth = imageWidth,
                            imageHeight = imageHeight,
                            modifier = Modifier.fillMaxSize(),
                            onRequestTextEdit = onRequestTextEdit,
                            commitPendingText = commitPendingText,
                            textEditingId = textSession?.existingId,
                        )
                        textSession?.let { session ->
                            TextEditOverlay(
                                session = session,
                                transform = transform,
                                value = textFieldValue,
                                onValueChange = { textFieldValue = it },
                                onCommit = commitPendingText,
                                onMeasured = { _, heightPx -> editorHeightPx = heightPx },
                            )
                        }
                    }

                    HistoryCluster(
                        canUndo = state.history.canUndo,
                        canRedo = state.history.canRedo,
                        canDelete = state.selectedId != null,
                        onUndo = onUndo,
                        onRedo = onRedo,
                        onDelete = onDelete,
                        modifier = Modifier
                            .align(Alignment.TopEnd)
                            .padding(12.dp),
                    )
                }

                Spacer(Modifier.height(14.dp))

                BottomPalette(
                    state = state,
                    tablet = tablet,
                    onClear = onClear,
                    commitPendingText = commitPendingText,
                    modifier = Modifier
                        .padding(horizontal = 14.dp)
                        .padding(bottom = 22.dp)
                        .fillMaxWidth(),
                )
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Top bar
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun FocusedTopBar(
    onCancel: () -> Unit,
    onDone: () -> Unit,
    doneEnabled: Boolean,
) {
    val theme = LocalReporterTheme.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 14.dp, end = 14.dp, top = 60.dp, bottom = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(modifier = Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
            TextButton(onClick = onCancel, contentPadding = PaddingValues(0.dp)) {
                Text("Cancel", color = theme.ink2, fontSize = 15.sp)
            }
        }
        Text(
            "EDIT SCREENSHOT",
            color = theme.ink2,
            fontSize = 11.sp,
            fontFamily = FontFamily.Monospace,
            letterSpacing = 2.sp,
            fontWeight = FontWeight.Medium,
        )
        Box(modifier = Modifier.weight(1f), contentAlignment = Alignment.CenterEnd) {
            // Phase 13.1 fix: solid accent fill, matches every other primary
            // brand button in the reporter (no gradient). Task 10: radius
            // 10dp + AccentFg text match web's `.txx-annotate-done` (dark
            // text on amber holds AA, per the quiet-instrument accent-fg
            // token).
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(10.dp))
                    .background(theme.accent)
                    .clickable(enabled = doneEnabled, onClick = onDone)
                    .padding(horizontal = 16.dp, vertical = 8.dp),
            ) {
                Text(
                    "Done",
                    color = theme.accentFg,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-right floating history cluster
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun HistoryCluster(
    canUndo: Boolean,
    canRedo: Boolean,
    canDelete: Boolean,
    onUndo: () -> Unit,
    onRedo: () -> Unit,
    onDelete: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val theme = LocalReporterTheme.current
    Row(
        modifier = modifier
            .clip(RoundedCornerShape(12.dp))
            .background(theme.bg2.copy(alpha = 0.80f))
            .border(1.dp, theme.hair.copy(alpha = 0.6f), RoundedCornerShape(12.dp)),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onUndo, enabled = canUndo) {
            Text(
                "↶",
                color = if (canUndo) theme.ink else theme.ink3.copy(alpha = 0.5f),
                fontSize = 18.sp,
                fontWeight = FontWeight.SemiBold,
            )
        }
        IconButton(onClick = onRedo, enabled = canRedo) {
            Text(
                "↷",
                color = if (canRedo) theme.ink else theme.ink3.copy(alpha = 0.5f),
                fontSize = 18.sp,
                fontWeight = FontWeight.SemiBold,
            )
        }
        IconButton(onClick = onDelete, enabled = canDelete) {
            Text(
                "🗑",
                color = if (canDelete) theme.hot else theme.ink3.copy(alpha = 0.5f),
                fontSize = 16.sp,
            )
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bottom palette — tool rail + style row
// ─────────────────────────────────────────────────────────────────────────────

/** Tool rail order (CONTEXT-locked, matches iOS FocusedAnnotationViewController palette order). */
private val ToolOrder: List<Triple<AnnotationTool, String, String>> = listOf(
    Triple(AnnotationTool.POINTER, "↖", "Move"),
    Triple(AnnotationTool.PEN, "✎", "Pen"),
    Triple(AnnotationTool.HIGHLIGHTER, "▬", "Highlight"),
    Triple(AnnotationTool.RECT, "▭", "Rect"),
    Triple(AnnotationTool.ELLIPSE, "◯", "Ellipse"),
    Triple(AnnotationTool.ARROW, "→", "Arrow"),
    Triple(AnnotationTool.TEXT, "T", "Text"),
    Triple(AnnotationTool.REDACT, "■", "Redact"),
)

@Composable
private fun BottomPalette(
    state: EditorState,
    tablet: Boolean,
    onClear: () -> Unit,
    commitPendingText: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val theme = LocalReporterTheme.current
    val selectedShape = state.annotations.firstOrNull { it.id == state.selectedId }
    val showFontSize = state.activeTool == AnnotationTool.TEXT || selectedShape?.kind == AnnotationKind.TEXT

    // Task 6 mutation-site audit: every style-row action (color/thickness/
    // font-size) routes through here, so committing once at the top covers
    // all of them — a mid-edit tap must not silently drop the in-flight
    // text (same rationale as undo/redo/clear/delete in FocusedAnnotation).
    fun restyle(patch: (Annotation) -> Annotation, setDefault: () -> Unit) {
        commitPendingText()
        val sel = state.selectedId
        if (sel != null) {
            state.history = state.history.push(state.annotations)
            state.annotations = state.annotations.map { if (it.id == sel) patch(it) else it }
        } else {
            setDefault()
        }
    }

    // Quiet-instrument BottomPalette chrome: Hair border, 12dp radius
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(12.dp),
        color = theme.bg2.copy(alpha = 0.92f),
        border = BorderStroke(1.dp, theme.hair),
    ) {
        Column(modifier = Modifier.padding(horizontal = 8.dp, vertical = 8.dp)) {
            // ---------------- Tool rail ----------------
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 4.dp, vertical = 2.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                for ((tool, glyph, label) in ToolOrder) {
                    ToolButton(
                        glyph = glyph,
                        label = label,
                        active = state.activeTool == tool,
                        tablet = tablet,
                        // Task 6 mutation-site audit: tool-switch commits
                        // any in-flight text edit first (brief lock).
                        onClick = { commitPendingText(); state.activeTool = tool },
                    )
                }
            }

            HorizontalDivider(color = theme.ink3.copy(alpha = 0.2f))

            // ---------------- Style row ----------------
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 4.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // 5 inline color swatches.
                for (c in AnnotationConstants.PEN_COLORS) {
                    val active = (selectedShape?.color ?: state.activeColor) == c
                    ColorSwatch(color = c, active = active) {
                        restyle(
                            patch = { it.copy(color = c) },
                            setDefault = { state.activeColor = c },
                        )
                    }
                }
                PaletteSeparator()
                if (showFontSize) {
                    for (size in AnnotationConstants.TEXT_FONT_SIZES) {
                        val label = when (size) {
                            AnnotationConstants.TEXT_FONT_SIZES[0] -> "S"
                            AnnotationConstants.TEXT_FONT_SIZES[2] -> "L"
                            else -> "M"
                        }
                        val active = (selectedShape?.fontSize ?: state.activeFontSize) == size
                        SizeDot(label = label, active = active) {
                            restyle(
                                // Restamp width/height (Lock 4 spirit — same
                                // as a commit/resize) so hit-testing/handles
                                // stay in sync with the new rendered size;
                                // a no-op for non-TEXT selections.
                                patch = { restampTextShape(it.copy(fontSize = size)) },
                                setDefault = { state.activeFontSize = size },
                            )
                        }
                    }
                } else {
                    for (thickness in AnnotationConstants.PEN_THICKNESSES) {
                        val active = (selectedShape?.thickness ?: state.activeThickness) == thickness
                        ThicknessDot(thickness = thickness, active = active) {
                            restyle(
                                patch = { it.copy(thickness = thickness) },
                                setDefault = { state.activeThickness = thickness },
                            )
                        }
                    }
                }
                PaletteSeparator()
                TextButton(onClick = onClear) {
                    Text("Clear", color = theme.hot)
                }
            }
        }
    }
}

@Composable
private fun ColorSwatch(color: Long, active: Boolean, onClick: () -> Unit) {
    val theme = LocalReporterTheme.current
    Box(
        Modifier
            .size(28.dp)
            .clip(CircleShape)
            .background(if (active) theme.bg2 else Color.Transparent)
            .clickable(onClick = onClick)
            .padding(3.dp),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .size(if (active) 22.dp else 18.dp)
                .clip(CircleShape)
                .background(Color(color))
                .border(if (active) 2.dp else 1.dp, if (active) theme.accent else theme.hair, CircleShape),
        )
    }
}

@Composable
private fun ThicknessDot(thickness: Float, active: Boolean, onClick: () -> Unit) {
    val theme = LocalReporterTheme.current
    Box(
        Modifier
            .size(32.dp)
            .clip(CircleShape)
            .background(if (active) theme.accent.copy(alpha = 0.25f) else Color.Transparent)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .size((thickness + 6f).dp)
                .clip(CircleShape)
                .background(if (active) theme.accent else theme.ink2),
        )
    }
}

@Composable
private fun SizeDot(label: String, active: Boolean, onClick: () -> Unit) {
    val theme = LocalReporterTheme.current
    Box(
        Modifier
            .size(32.dp)
            .clip(CircleShape)
            .background(if (active) theme.accent else Color.Transparent)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            // Task 10: text-on-accent uses the AccentFg token (matches web's
            // `.txx-tool-btn-active { color: var(--txx-accent-fg) }`).
            color = if (active) theme.accentFg else theme.ink,
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
private fun PaletteSeparator() {
    val theme = LocalReporterTheme.current
    Box(
        Modifier
            .width(1.dp)
            .height(20.dp)
            .background(theme.ink3.copy(alpha = 0.3f)),
    )
}

@Composable
private fun ToolButton(
    glyph: String,
    label: String,
    active: Boolean,
    tablet: Boolean,
    onClick: () -> Unit,
) {
    val theme = LocalReporterTheme.current
    val activeBg = theme.accent
    // Task 10: text-on-accent uses the AccentFg token (matches web's
    // `.txx-tool-btn-active { color: var(--txx-accent-fg) }`).
    val activeFg = theme.accentFg
    if (tablet) {
        Box(
            modifier = Modifier
                .clip(RoundedCornerShape(999.dp))
                .background(if (active) activeBg else Color.Transparent)
                .clickable(onClick = onClick)
                .padding(horizontal = 12.dp, vertical = 6.dp),
            contentAlignment = Alignment.Center,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    glyph,
                    color = if (active) activeFg else theme.ink,
                    fontSize = 16.sp,
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    label,
                    color = if (active) activeFg else theme.ink,
                    fontSize = 13.sp,
                    fontWeight = if (active) FontWeight.SemiBold else FontWeight.Medium,
                )
            }
        }
    } else {
        Box(
            modifier = Modifier
                .size(36.dp)
                .clip(CircleShape)
                .background(if (active) activeBg else Color.Transparent)
                .clickable(onClick = onClick),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                glyph,
                color = if (active) activeFg else theme.ink,
                fontSize = 16.sp,
            )
        }
    }
}

// Unused import guard (Dp ref pulled in for future tablet measurements).
@Suppress("unused")
private val UnusedDp: Dp = 0.dp
