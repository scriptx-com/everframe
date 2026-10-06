// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.view.View
import kotlin.math.ceil
import kotlin.math.floor

/** Where a masked view lands in the captured frame, and painting those masks. */
internal object VideoMaskBounds {
    /**
     * Bounds of [view] in [root] coordinates, through every ancestor's transform and scroll,
     * padded by a pixel. An empty rect when the view or an ancestor is not visible. Null when
     * [view] is not under [root] (an overlay or a detached parent), so it cannot be placed.
     */
    fun of(view: View, root: View): Rect? {
        val r = RectF(0f, 0f, view.width.toFloat(), view.height.toFloat())
        var shown = view.visibility == View.VISIBLE
        var current = view
        while (current !== root) {
            val matrix = current.matrix
            if (!matrix.isIdentity) matrix.mapRect(r)
            r.offset(current.left.toFloat(), current.top.toFloat())
            val parent = current.parent as? View ?: return null
            r.offset(-parent.scrollX.toFloat(), -parent.scrollY.toFloat())
            if (parent.visibility != View.VISIBLE) shown = false
            current = parent
        }
        if (!shown) return Rect()
        return Rect(floor(r.left).toInt() - 1, floor(r.top).toInt() - 1, ceil(r.right).toInt() + 1, ceil(r.bottom).toInt() + 1)
    }

    private val black = Paint().apply { color = android.graphics.Color.BLACK; style = Paint.Style.FILL }

    /** Paints [observation]'s masks onto a frame copied from a window of the observed size. */
    fun paint(bitmap: Bitmap, observation: PrivacyObservation) {
        if (observation.masks.isEmpty() || observation.width <= 0 || observation.height <= 0) return
        val sx = bitmap.width.toFloat() / observation.width
        val sy = bitmap.height.toFloat() / observation.height
        val canvas = Canvas(bitmap)
        for (m in observation.masks) {
            canvas.drawRect(floor(m.left * sx), floor(m.top * sy), ceil(m.right * sx), ceil(m.bottom * sy), black)
        }
    }
}
