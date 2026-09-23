// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import android.graphics.Rect
import android.view.View
import android.view.ViewGroup

/** Visibility proof only for automatically excluded WebViews, never explicit sensitive markers. */
internal object HiddenVideoWebView {
    /** SDK/framework ancestor visits consumed, or null when pixels may be visible/uncertain. */
    fun inspect(view: View, deadlineNs: Long, remaining: Int, now: () -> Long): Int? {
        var current: View? = view
        var ancestors = 0
        var visited = 0
        var hidden = false
        var clippingKnown = true
        val root = view.rootView
        while (current != null) {
            // Reserve a second ancestor walk for Android's clipping calculation below. Keep
            // framework recursion shallow and include all work in the gate's existing budget.
            if (++ancestors > 64 || visited + 2 > remaining || now() >= deadlineNs) return null
            visited += 2
            if (current.animation != null || current.animationMatrix != null ||
                (current is ViewGroup && current.layoutTransition?.isRunning == true)) return null
            // Shared-element ghosts draw from an overlay while the original is
            // INVISIBLE. Transition alpha can likewise hide an original while a
            // copy remains visible. Reject before either alpha or geometry can
            // supply a proof; public APIs cannot identify all overlay ghosts.
            if (current.visibility == View.INVISIBLE || current.transitionAlpha != 1f) return null
            // getGlobalVisibleRect is not a rendering proof for hierarchies permitting
            // children to draw outside parent bounds. Alpha/visibility proofs still apply.
            if (current is ViewGroup && !current.clipChildren) clippingKnown = false
            if (current.visibility == View.GONE || current.alpha == 0f) hidden = true
            if (current === root) {
                val clipped = !hidden && clippingKnown && !view.getGlobalVisibleRect(Rect())
                if (now() >= deadlineNs) return null
                return if (hidden || clipped) visited else null
            }
            val parent = current.parent as? ViewGroup ?: return null
            // startViewTransition/removeView preserves attachment and ancestry
            // while drawing the removed child separately, even when it is GONE.
            // Only ordinary child membership supplies a visibility proof. Scan
            // explicitly so sibling visits and time share the admission budget.
            var found = false
            for (index in 0 until parent.childCount) {
                if (++visited > remaining || now() >= deadlineNs) return null
                if (parent.getChildAt(index) === current) { found = true; break }
            }
            if (!found) return null
            current = parent
        }
        return null // An uninspectable parent/overlay never supplies a visibility proof.
    }
}
