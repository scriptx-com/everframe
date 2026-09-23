// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// AreaCaptureOverlay — Task 8 (native report-window parity, area capture).
// A fullscreen, TRANSPARENT Compose Dialog presented while the reporter
// Dialog is hidden (see ReporterRoot's `areaCapturing` wiring). Because
// this is its OWN Window, it is automatically excluded from a PixelCopy of
// the host Activity's window — no explicit skip-capture flag needed (unlike
// web's `data-everframe-skip-capture`, which exists because the web capture
// path walks the DOM the modal itself lives in).
//
// Copy + interaction model matches:
//   • packages/sdk-react/src/reporter-ui/AreaCaptureOverlay.tsx (copy:
//     "Drag to select an area", "Cancel", "Capture visible area"; MIN_DRAG_EDGE)
//   • packages/sdk-ios/Sources/EverframeReporterUI/AreaCaptureViewController.swift
//     (same copy; also gates "Capture visible area" on a dragged rect ≥
//     8×8pt — unlike web, neither native surface offers a separate
//     always-enabled full-viewport shortcut, since the host window already
//     IS the visible area a full-viewport drag would select).
//
// Coordinate space: pointerInput delivers positions in Compose's `px` unit,
// which is already device pixels (Compose measures/draws 1:1 with the
// underlying View's canvas — there's no extra scale factor to undo, unlike
// dp→px). This overlay Dialog is fullscreen edge-to-edge
// (decorFitsSystemWindows = false), exactly like the reporter Dialog it
// swaps places with — so its own window bounds coincide with the Activity
// window's bounds. ASSUMPTION (mirrors AreaCropMath.swift's analogous
// note): both windows span the same screen with no relative offset, so a
// pointer position captured here can be handed to
// ScreenshotCapture.captureRegion(activity, regionPx, …) UNCONVERTED and
// still land in the Activity window's own pixel-coordinate space.
package dev.everframe.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.border
import androidx.compose.ui.draw.clip
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect as ComposeRect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.everframe.ui.theme.LocalReporterTheme
import kotlin.math.roundToInt

/** Drags smaller than this (either edge) are treated as stray taps —
 *  mirrors web's `MIN_DRAG_EDGE` (CSS px) / iOS's `minDragEdge` (pt). */
private val MinDragEdge = 8.dp

/**
 * @param onCapture fired with the dragged selection rect in Activity-window
 *   PIXEL coordinates (see file header for the identity-mapping assumption)
 *   once "Capture visible area" is tapped.
 * @param onCancel fired on Cancel, system Back, or an outside dismiss.
 */
@Composable
internal fun AreaCaptureOverlay(
    onCapture: (android.graphics.Rect) -> Unit,
    onCancel: () -> Unit,
) {
    // Review finding 2 (Task 8 fix round 1) — in-flight guard: true from the
    // instant "Capture visible area" is tapped until this whole overlay is
    // torn down (ReporterRoot flips `areaCapturing` false once
    // ScreenshotCapture.captureRegion resolves, which unmounts this
    // composable and drops this state). Hoisted up to the Dialog level
    // (not just AreaCaptureOverlayContent) so it can also gate
    // `onDismissRequest` — system Back is wired to `dismissOnBackPress =
    // true` below, and without this guard it could race a Cancel in behind
    // a capture that's already in flight, exactly like a Cancel-button tap
    // could. While true: both buttons are disabled and drag input is
    // ignored (see AreaCaptureOverlayContent).
    var capturing by remember { mutableStateOf(false) }

    Dialog(
        onDismissRequest = { if (!capturing) onCancel() },
        properties = DialogProperties(
            usePlatformDefaultWidth = false,
            decorFitsSystemWindows = false,
            dismissOnBackPress = true,
            // The whole point of this surface is drag-to-select over the
            // host app underneath — an outside tap must NOT dismiss it.
            dismissOnClickOutside = false,
        ),
    ) {
        AreaCaptureOverlayContent(
            capturing = capturing,
            onCaptureStart = { capturing = true },
            onCapture = onCapture,
            onCancel = { if (!capturing) onCancel() },
        )
    }
}

@Composable
private fun AreaCaptureOverlayContent(
    capturing: Boolean,
    onCaptureStart: () -> Unit,
    onCapture: (android.graphics.Rect) -> Unit,
    onCancel: () -> Unit,
) {
    val theme = LocalReporterTheme.current
    val density = LocalDensity.current
    val minDragEdgePx = with(density) { MinDragEdge.toPx() }
    val borderWidthPx = with(density) { 1.dp.toPx() }

    // Raw drag endpoints in overlay-local px (== window px, see file header).
    // `dragStart` doubles as "has a drag begun" — non-null hides the hint
    // the instant a touch is recognized as a drag (mirrors iOS's
    // `case .began: hintLabel.isHidden = true`), even before any movement.
    var dragStart by remember { mutableStateOf<Offset?>(null) }
    var dragCurrent by remember { mutableStateOf<Offset?>(null) }

    val selection: ComposeRect? = run {
        val start = dragStart
        val current = dragCurrent
        if (start == null || current == null) {
            null
        } else {
            ComposeRect(
                left = minOf(start.x, current.x),
                top = minOf(start.y, current.y),
                right = maxOf(start.x, current.x),
                bottom = maxOf(start.y, current.y),
            )
        }
    }
    val selectionValid = selection != null &&
        selection.width >= minDragEdgePx &&
        selection.height >= minDragEdgePx

    Box(
        modifier = Modifier
            .fillMaxSize()
            // Review finding 2: keyed on `capturing` so the pointerInput
            // coroutine restarts (cancelling any gesture-in-progress) the
            // instant a capture starts, and — via the early return — a new
            // drag can't begin while one is in flight. Combined with the
            // disabled buttons below, the overlay is fully inert once
            // "Capture visible area" has been tapped.
            .pointerInput(capturing) {
                if (capturing) return@pointerInput
                detectDragGestures(
                    onDragStart = { offset ->
                        dragStart = offset
                        dragCurrent = offset
                    },
                    onDrag = { change, _ ->
                        dragCurrent = change.position
                    },
                    onDragCancel = {
                        dragStart = null
                        dragCurrent = null
                    },
                    // onDragEnd intentionally leaves dragStart/dragCurrent as-is —
                    // the selection must survive the gesture ending so the
                    // bottom pill's "Capture visible area" button has
                    // something to read when tapped afterward.
                )
            },
    ) {
        // Dim everything OUTSIDE the current selection at 40% black — a
        // single even-odd Path (outer full-bounds rect XOR the selection
        // rect) rather than four separate scrims. When there's no
        // selection yet, the inner rect is simply omitted and the whole
        // surface reads as one uniform dim.
        Canvas(modifier = Modifier.fillMaxSize()) {
            val path = Path().apply {
                fillType = PathFillType.EvenOdd
                addRect(ComposeRect(Offset.Zero, size))
                selection?.let { addRect(it) }
            }
            drawPath(path, color = Color.Black.copy(alpha = 0.4f))
            selection?.let {
                drawRect(
                    color = theme.accent,
                    topLeft = it.topLeft,
                    size = it.size,
                    style = Stroke(width = borderWidthPx),
                )
            }
        }

        if (dragStart == null) {
            Text(
                "Drag to select an area",
                color = theme.ink,
                fontSize = 15.sp,
                fontWeight = FontWeight.Medium,
                modifier = Modifier.align(Alignment.Center),
            )
        }

        Row(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 16.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(theme.bg3)
                .border(1.dp, theme.hair, RoundedCornerShape(10.dp))
                .padding(horizontal = 16.dp, vertical = 8.dp),
        ) {
            // Review finding 2: disabled while a capture is in flight so
            // Cancel can't race a pending capture — see `capturing`'s
            // doc comment on AreaCaptureOverlay for the full race this
            // closes (the `onDismissRequest`/Back-press path is guarded
            // there too).
            TextButton(onClick = onCancel, enabled = !capturing) {
                Text("Cancel", color = theme.ink)
            }
            Button(
                // Review finding 2: `!capturing` on top of `selectionValid`
                // is what actually stops a double-tap — once the first tap
                // flips `capturing` true (via `onCaptureStart` below), this
                // button disables before a second tap can land, so
                // `onCapture` can fire at most once per overlay instance.
                enabled = selectionValid && !capturing,
                onClick = {
                    val sel = selection ?: return@Button
                    onCaptureStart()
                    onCapture(
                        android.graphics.Rect(
                            sel.left.roundToInt(),
                            sel.top.roundToInt(),
                            sel.right.roundToInt(),
                            sel.bottom.roundToInt(),
                        ),
                    )
                },
                colors = ButtonDefaults.buttonColors(
                    containerColor = theme.accent,
                    // Task 10 leftover fix (Task 8 hardcoded Color.Black
                    // before AccentFg existed): text-on-accent uses the
                    // token, matching every other accent-filled control.
                    contentColor = theme.accentFg,
                    disabledContainerColor = theme.accent.copy(alpha = 0.35f),
                    disabledContentColor = theme.accentFg.copy(alpha = 0.5f),
                ),
            ) {
                Text("Capture visible area", fontWeight = FontWeight.SemiBold)
            }
        }
    }
}
