// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import android.view.View
import java.lang.ref.WeakReference

/** Main-thread, bounded weak history also covers marked views reparented into overlays. */
internal object VideoSensitiveViews {
    private class Entry(view: View, var automaticWebView: Boolean) {
        val reference = WeakReference(view)
    }
    private val views = ArrayList<Entry>()
    private var overflowed = false

    fun remember(view: View) {
        check(android.os.Looper.myLooper() == android.os.Looper.getMainLooper())
        val iterator = views.iterator()
        while (iterator.hasNext()) {
            val entry = iterator.next()
            val existing = entry.reference.get()
            if (existing === view) { entry.automaticWebView = false; return }
            if (existing == null) iterator.remove()
        }
        rememberObserved(view)
    }

    /** Gate already scanned/pruned history in its shared budget; append in constant time. */
    fun rememberObserved(view: View, automaticWebView: Boolean = false) {
        if (views.size == 2048) {
            if (!overflowed) { overflowed = true; VideoPrivacyRevocation.begin() }
            return // Permanent uncertainty: never drop a marker and then authorize pixels.
        }
        views.add(Entry(view, automaticWebView))
    }

    /** Hidden WebViews also need overlay history; identity deduplication shares the gate budget. */
    fun rememberHiddenWebView(view: View, deadlineNs: Long, remaining: Int, now: () -> Long): Int? {
        var visited = 0
        for (entry in views) {
            if (++visited > remaining || now() >= deadlineNs) return null
            if (entry.reference.get() === view) return visited
        }
        rememberObserved(view, automaticWebView = true)
        return if (overflowed) null else visited
    }

    /** Returns SDK nodes consumed, or null for sensitive/uncertain/over-budget. */
    fun inspect(windowIdentity: Any?, deadlineNs: Long, remaining: Int, now: () -> Long,
                hiddenWebView: (View, Int) -> Int? = { _, _ -> null }): Int? {
        if (overflowed) return null
        var visited = 0
        val iterator = views.iterator()
        while (iterator.hasNext()) {
            if (++visited > remaining || now() >= deadlineNs) return null
            val entry = iterator.next()
            val view = entry.reference.get()
            if (view == null) { iterator.remove(); continue }
            if (view.isAttachedToWindow && view.windowToken === windowIdentity) {
                if (!entry.automaticWebView) return null
                visited += hiddenWebView(view, remaining - visited) ?: return null
            }
        }
        return visited
    }
}
