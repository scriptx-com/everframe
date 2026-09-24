// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// ScreenshotStrip — horizontal thumbnail rail above (phone) / beside
// (tablet, inside the thumbnail column) the active-shot preview (Android
// Task 7, native report-window parity). One 72x48.dp rounded tile per shot
// — the active tile gets a 2.dp accent border, others 1.dp hair — each with
// a 20.dp "x" delete badge top-right. A trailing dashed-border add tile
// (hidden once the shot count hits ShotListOps.MAX_SHOTS) starts the next
// capture — Task 8's area-capture flow (see AreaCaptureOverlay.kt and
// ReporterRoot's `onAdd` wiring).
//
// Mirrors packages/sdk-ios/Sources/EverframeReporterUI/ScreenshotStripView.swift
// and packages/sdk-react/src/reporter-ui/ScreenshotStrip.tsx — same
// accessible-name copy ("Delete screenshot N", "Add another screenshot")
// for cross-platform parity (web QA lock).
//
// Stateless composable: the caller (ReporterRoot) owns `shots` /
// `activeIndex` and drives this via recomposition on every mutation. This
// composable never mutates caller state directly — it only reports intent
// through the three callbacks.
package dev.everframe.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.everframe.ui.annotation.ShotListOps
import dev.everframe.ui.theme.LocalReporterTheme

private val TileWidth = 72.dp
private val TileHeight = 48.dp
private val TileCorner = 8.dp
private val BadgeSize = 20.dp
private val BadgeCorner = 10.dp

/**
 * @param shots the report's full shot list (index 0 = open-time capture).
 * @param activeIndex which shot is currently shown in the large preview.
 * @param onSelect fired with the tapped tile's index.
 * @param onDelete fired with the tapped delete-badge's index. The caller
 *   decides whether to confirm (annotated shot) or delete immediately
 *   (blank shot) — see `requestDeleteShot` in ReporterRoot.kt.
 * @param onAdd fired when the trailing add tile is tapped.
 * @param enabled review finding (Task 7 fix round 1): the strip must be
 *   inert while the fullscreen annotation editor is open, so select/delete/
 *   add can never retarget or mutate the shot list out from under the
 *   editor session — belt-and-braces alongside the `editingShot` reference
 *   snapshot in ReporterRoot's `onDone`/`onCancel`. Defaults true so every
 *   existing call site (which doesn't gate on editor visibility) is
 *   unaffected.
 */
@Composable
internal fun ScreenshotStrip(
    shots: List<ShotState>,
    activeIndex: Int,
    onSelect: (Int) -> Unit,
    onDelete: (Int) -> Unit,
    onAdd: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    LazyRow(
        // Pinning the row's height to one tile keeps it from jittering as
        // tiles mount/unmount during add/delete (LazyRow would otherwise
        // size to its tallest child, which is already TileHeight anyway).
        modifier = modifier.height(TileHeight),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(shots.size) { i ->
            ScreenshotStripTile(
                shot = shots[i],
                index = i,
                total = shots.size,
                isActive = i == activeIndex,
                enabled = enabled,
                onSelect = { onSelect(i) },
                onDelete = { onDelete(i) },
            )
        }
        if (ShotListOps.showsAddTile(shots.size)) {
            item(key = "add-shot-tile") {
                AddShotTile(enabled = enabled, onClick = onAdd)
            }
        }
    }
}

@Composable
private fun ScreenshotStripTile(
    shot: ShotState,
    index: Int,
    total: Int,
    isActive: Boolean,
    enabled: Boolean,
    onSelect: () -> Unit,
    onDelete: () -> Unit,
) {
    val theme = LocalReporterTheme.current
    val borderWidth = if (isActive) 2.dp else 1.dp
    val borderColor = if (isActive) theme.accent else theme.hair
    val selectLabel = "Screenshot ${index + 1} of $total"
    val deleteLabel = "Delete screenshot ${index + 1}"

    Box(modifier = Modifier.size(TileWidth, TileHeight)) {
        Image(
            bitmap = shot.previewBitmap().asImageBitmap(),
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = Modifier
                .fillMaxSize()
                .clip(RoundedCornerShape(TileCorner))
                .border(borderWidth, borderColor, RoundedCornerShape(TileCorner))
                .clickable(
                    enabled = enabled,
                    onClickLabel = selectLabel,
                    role = Role.Button,
                    onClick = onSelect,
                )
                .semantics { contentDescription = selectLabel },
        )
        Box(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(2.dp)
                .size(BadgeSize)
                .clip(RoundedCornerShape(BadgeCorner))
                .background(theme.bg3)
                .clickable(
                    enabled = enabled,
                    onClickLabel = deleteLabel,
                    role = Role.Button,
                    onClick = onDelete,
                )
                .semantics { contentDescription = deleteLabel },
            contentAlignment = Alignment.Center,
        ) {
            Text(
                "×",
                color = theme.ink,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
            )
        }
    }
}

@Composable
private fun AddShotTile(enabled: Boolean, onClick: () -> Unit) {
    val theme = LocalReporterTheme.current
    val label = "Add another screenshot"
    Box(
        modifier = Modifier
            .size(TileWidth, TileHeight)
            .clip(RoundedCornerShape(TileCorner))
            .dashedBorder(theme.hair, TileCorner)
            .clickable(
                enabled = enabled,
                onClickLabel = label,
                role = Role.Button,
                onClick = onClick,
            )
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            "+",
            color = theme.accent,
            fontSize = 16.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

/** Plain `Modifier.border` has no dashed-line primitive — draw the dashed
 *  rounded rect ourselves via `PathEffect.dashPathEffect` (mirrors iOS's
 *  `DashedBorderButton` CAShapeLayer approach). */
private fun Modifier.dashedBorder(color: Color, cornerRadius: Dp, strokeWidth: Dp = 1.dp): Modifier =
    drawBehind {
        val stroke = Stroke(
            width = strokeWidth.toPx(),
            pathEffect = PathEffect.dashPathEffect(floatArrayOf(4f, 3f), 0f),
        )
        drawRoundRect(
            color = color,
            style = stroke,
            cornerRadius = CornerRadius(cornerRadius.toPx(), cornerRadius.toPx()),
        )
    }
