// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.view.View
import android.view.ViewGroup
import kotlin.math.ceil
import kotlin.math.floor

/** Where a masked view lands in the captured frame, and painting those masks. */
internal object VideoMaskBounds {
    /**
     * Bounds of [view] in [root] coordinates, through every ancestor's transform and scroll,
     * padded by a pixel. An empty rect only when the view or an ancestor is GONE as an ordinary
     * child, so nothing draws it. Null when its drawn position cannot be proven, which refuses
     * the frame: [view] is not under [root] (an overlay or a detached parent), a legacy
     * Animation, an animation matrix or a running LayoutTransition on it or an ancestor can draw
     * it away from these bounds, or it or an ancestor is INVISIBLE, transition-hidden, or GONE
     * while a removal transition still draws it.
     */
    fun of(view: View, root: View): Rect? {
        val r = RectF(0f, 0f, view.width.toFloat(), view.height.toFloat())
        var hidden = false
        var current = view
        while (true) {
            if (!provable(current)) return null
            if (current === root) { if (current.visibility == View.GONE) hidden = true; break }
            val parent = current.parent as? ViewGroup ?: return null
            if (current.visibility == View.GONE) {
                // startViewTransition keeps drawing a removed child, GONE or not: only an
                // ordinary child is proven hidden.
                if (parent.indexOfChild(current) < 0) return null
                hidden = true
            }
            val matrix = current.matrix
            if (!matrix.isIdentity) matrix.mapRect(r)
            r.offset(current.left.toFloat(), current.top.toFloat())
            r.offset(-parent.scrollX.toFloat(), -parent.scrollY.toFloat())
            current = parent
        }
        if (hidden) return Rect()
        return Rect(floor(r.left).toInt() - 1, floor(r.top).toInt() - 1, ceil(r.right).toInt() + 1, ceil(r.bottom).toInt() + 1)
    }

    // Tweens and animation matrices are applied while drawing, outside getMatrix(), and a layout
    // transition moves and fades children. A shared-element ghost draws an INVISIBLE original
    // from an overlay, and transition alpha hides an original while a copy is drawn.
    private fun provable(view: View) = view.animation == null && view.animationMatrix == null &&
        !(view is ViewGroup && view.layoutTransition?.isRunning == true) &&
        view.visibility != View.INVISIBLE && view.transitionAlpha == 1f

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
