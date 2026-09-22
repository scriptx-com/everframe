// ImageTransform.kt
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The ONE view↔image mapping for the annotation editor. Aspect-fit, centered,
// upscale capped at ×4 so tiny area-capture crops stay workable (web parity —
// sdk-react ×4 cap). Pure Kotlin — no android.* imports.
package com.traceitx.ui.annotation

import kotlin.math.min

class ImageTransform(
    val imageWidth: Float,
    val imageHeight: Float,
    val viewWidth: Float,
    val viewHeight: Float,
    val maxUpscale: Float = 4f
) {
    val scale: Float
    val offsetX: Float
    val offsetY: Float

    init {
        if (imageWidth > 0 && imageHeight > 0 && viewWidth > 0 && viewHeight > 0) {
            val fit = min(viewWidth / imageWidth, viewHeight / imageHeight)
            val s = min(fit, maxUpscale)
            scale = s
            offsetX = (viewWidth - imageWidth * s) / 2
            offsetY = (viewHeight - imageHeight * s) / 2
        } else {
            scale = 1f
            offsetX = 0f
            offsetY = 0f
        }
    }

    /** The image's rendered frame inside the view (letterbox excluded). */
    fun imageFrameInView(): Box =
        Box(offsetX, offsetY, imageWidth * scale, imageHeight * scale)

    /** Convert view coordinates to image coordinates. */
    fun toImageX(vx: Float): Float = (vx - offsetX) / scale

    fun toImageY(vy: Float): Float = (vy - offsetY) / scale

    /** Convert image coordinates to view coordinates. */
    fun toViewX(ix: Float): Float = ix * scale + offsetX

    fun toViewY(iy: Float): Float = iy * scale + offsetY
}
