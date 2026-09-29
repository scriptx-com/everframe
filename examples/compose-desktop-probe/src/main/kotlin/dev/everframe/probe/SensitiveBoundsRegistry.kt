// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.probe

import java.awt.Rectangle
import kotlin.math.ceil
import kotlin.math.floor

/** Latest Compose layout bounds in content coordinates; an invalid update clears them. */
class SensitiveBoundsRegistry {
    private var bounds: Rectangle? = null

    @Synchronized
    fun update(x: Float, y: Float, width: Float, height: Float) {
        val right = x + width
        val bottom = y + height
        if (!x.isFinite() || !y.isFinite() || !right.isFinite() || !bottom.isFinite() ||
            x < 0 || y < 0 || width <= 0 || height <= 0 ||
            right >= Int.MAX_VALUE || bottom >= Int.MAX_VALUE) {
            bounds = null
            return
        }
        val leftPx = floor(x).toInt()
        val topPx = floor(y).toInt()
        val rightPx = ceil(right).toInt()
        val bottomPx = ceil(bottom).toInt()
        bounds = Rectangle(leftPx, topPx, rightPx - leftPx, bottomPx - topPx)
    }

    @Synchronized
    fun snapshot(): Rectangle? = bounds?.let(::Rectangle)

    @Synchronized
    fun clear() { bounds = null }
}
