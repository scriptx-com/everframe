// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Matrix
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
     * child and none of them is fully transparent: no parent draws a GONE child. Null when its
     * drawn position cannot be proven, which refuses the frame: [view] is not under [root] (an
     * overlay or a detached parent), a legacy Animation, an animation matrix or a running
     * LayoutTransition on it or an ancestor can draw it away from these bounds, or it or an
     * ancestor (the root included) is INVISIBLE, transition-hidden, fully transparent even when
     * GONE, or GONE while a removal transition still draws it.
     */
    fun of(view: View, root: View): Rect? {
        val r = RectF(0f, 0f, view.width.toFloat(), view.height.toFloat())
        var hidden = false
        var current = view
        while (true) {
            if (!provable(current)) return null
            // A transparent view draws nothing itself, so only another drawing can show it, even
            // when it is GONE: a container transform sets the GONE container it closes to alpha 0
            // and draws it from an overlay through View.draw, which never checks visibility.
            if (current.alpha == 0f) return null
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
        return padded(r)
    }

    /**
     * Adds the rects covering [view]'s drawn subtree to [into]: its own bounds and, below any
     * node whose parent does not clip children (React Native views never do), the bounds of each
     * descendant that extends past them, clipped to [root]. Returns the descendants visited, or
     * null when one cannot be placed or the budget runs out.
     */
    fun cover(view: View, root: View, remaining: Int, deadlineNs: Long, now: () -> Long, into: MutableCollection<Rect>): Int? {
        val bounds = of(view, root) ?: return null
        if (bounds.isEmpty) return 0
        // Painting covers anything inside the view's own bounds, so a descendant moving there is
        // not a new privacy state: only one extending past them adds a mask.
        val own = if (add(bounds, root, into)) bounds else null
        // A parent that clips children confines the view's whole subtree to its bounds.
        if (view === root || view !is ViewGroup || (view.parent as? ViewGroup)?.clipChildren == true) return 0
        // Each descendant is an ordinary child of a node already proven above it, so only its
        // own state needs checking, and its parent's transform to the root maps its bounds.
        val pending = ArrayDeque<Pair<View, Matrix>>()
        var visited = 0
        fun expand(group: ViewGroup, toRoot: Matrix): Boolean {
            if (visited + pending.size + group.childCount > remaining) return false
            for (i in 0 until group.childCount) pending.add(group.getChildAt(i) to toRoot)
            return true
        }
        if (!expand(view, toRoot(view, root))) return null
        while (true) {
            val (node, parentToRoot) = pending.removeFirstOrNull() ?: return visited
            if (++visited > remaining || now() >= deadlineNs) return null
            if (!provable(node)) return null
            if (node.visibility == View.GONE) continue
            val parent = node.parent as ViewGroup
            val toRoot = Matrix(parentToRoot).apply {
                preTranslate(node.left - parent.scrollX.toFloat(), node.top - parent.scrollY.toFloat())
                preConcat(node.matrix)
            }
            val r = RectF(0f, 0f, node.width.toFloat(), node.height.toFloat()).also { toRoot.mapRect(it) }
            add(padded(r), root, into, own)
            if (node is ViewGroup && !parent.clipChildren && !expand(node, toRoot)) return null
        }
    }

    /** [view]'s local coordinates to [root]'s, for a chain [of] has already proven. */
    private fun toRoot(view: View, root: View): Matrix {
        val m = Matrix()
        var current = view
        while (current !== root) {
            val parent = current.parent as ViewGroup
            m.postConcat(current.matrix)
            m.postTranslate(current.left - parent.scrollX.toFloat(), current.top - parent.scrollY.toFloat())
            current = parent
        }
        return m
    }

    // A mask entirely outside the frame paints nothing; keeping it would make every scroll of
    // off-screen content a new privacy state that drops the pending frame. Nor does one inside
    // [within], a mask already added. Returns whether [bounds], now clipped, was added.
    private fun add(bounds: Rect, root: View, into: MutableCollection<Rect>, within: Rect? = null): Boolean {
        if (!bounds.intersect(0, 0, root.width, root.height) || within?.contains(bounds) == true) return false
        into.add(bounds)
        return true
    }

    private fun padded(r: RectF) =
        Rect(floor(r.left).toInt() - 1, floor(r.top).toInt() - 1, ceil(r.right).toInt() + 1, ceil(r.bottom).toInt() + 1)

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
