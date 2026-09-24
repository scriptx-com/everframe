// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// BakeRenderer — annotation flatten at submit time. Model-driven Annotation
// list accumulated by the user in the reporter Dialog is baked into the
// captured screenshot's pixels BEFORE the multipart upload (PRIV-03 ANN-02).
//
// Compositing order (PRIV-03 order lock):
//   1. BLUR (redactions) FIRST, baked as opaque black — regardless of the
//      annotation's position in the array — because they must permanently
//      obscure underlying pixels before anything else lands.
//   2. Every other shape, in array order (pen/highlighter/rect/ellipse/
//      arrow/text) — z-order matches the on-canvas stacking order.
//
// Mirrors `packages/sdk-ios/Sources/EverframeReporterUI/Annotation/BakeRenderer.swift`.
package dev.everframe.ui.annotation

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin

object BakeRenderer {
    /**
     * Bake annotations (image-pixel space) into a mutable copy of [source].
     * PRIV-03 order lock: BLUR (redactions) first as opaque black, then every
     * other shape in array order.
     */
    fun bake(source: Bitmap, annotations: List<Annotation>): Bitmap {
        val out = source.copy(Bitmap.Config.ARGB_8888, true)
        val canvas = Canvas(out)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        for (a in annotations) if (a.kind == AnnotationKind.BLUR) {
            paint.reset(); paint.style = Paint.Style.FILL; paint.color = Color.BLACK
            val b = normalizedBox(a)
            canvas.drawRect(b.x, b.y, b.x + b.width, b.y + b.height, paint)
        }
        for (a in annotations) if (a.kind != AnnotationKind.BLUR) draw(a, canvas)
        return out
    }

    private fun draw(a: Annotation, canvas: Canvas) {
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = a.color.toInt()
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
        }
        when (a.kind) {
            AnnotationKind.PEN, AnnotationKind.HIGHLIGHTER -> {
                if (a.points.size < 4) return
                paint.style = Paint.Style.STROKE
                if (a.kind == AnnotationKind.HIGHLIGHTER) {
                    paint.strokeWidth = a.thickness * AnnotationConstants.HIGHLIGHTER_WIDTH_MULTIPLIER
                    paint.alpha = (AnnotationConstants.HIGHLIGHTER_OPACITY * 255).toInt()
                } else paint.strokeWidth = a.thickness
                val path = Path().apply {
                    moveTo(a.points[0], a.points[1])
                    var i = 2
                    while (i + 1 < a.points.size) { lineTo(a.points[i], a.points[i + 1]); i += 2 }
                }
                canvas.drawPath(path, paint)
            }
            AnnotationKind.RECT -> {
                paint.style = Paint.Style.STROKE; paint.strokeWidth = a.thickness
                val b = normalizedBox(a)
                canvas.drawRect(b.x, b.y, b.x + b.width, b.y + b.height, paint)
            }
            AnnotationKind.ELLIPSE -> {
                paint.style = Paint.Style.STROKE; paint.strokeWidth = a.thickness
                val b = normalizedBox(a)
                canvas.drawOval(RectF(b.x, b.y, b.x + b.width, b.y + b.height), paint)
            }
            AnnotationKind.ARROW -> {
                paint.style = Paint.Style.STROKE; paint.strokeWidth = a.thickness
                canvas.drawLine(a.fromX, a.fromY, a.toX, a.toY, paint)
                val angle = atan2(a.toY - a.fromY, a.toX - a.fromX)
                val headLen = maxOf(12f, a.thickness * 3)   // same chevron geometry as before
                for (side in floatArrayOf((PI / 6).toFloat(), (-PI / 6).toFloat())) {
                    canvas.drawLine(
                        a.toX, a.toY,
                        a.toX - headLen * cos(angle + side), a.toY - headLen * sin(angle + side), paint)
                }
            }
            AnnotationKind.TEXT -> {
                paint.style = Paint.Style.FILL
                paint.textSize = a.fontSize
                // Model y is the text's TOP (web/Konva convention); drawText wants baseline.
                val baseline = a.y - paint.fontMetrics.ascent
                var lineY = baseline
                for (line in a.text.split("\n")) {
                    canvas.drawText(line, a.x, lineY, paint)
                    lineY += a.fontSize * AnnotationConstants.TEXT_LINE_HEIGHT
                }
            }
            AnnotationKind.BLUR -> Unit  // stage 1
        }
    }
}
