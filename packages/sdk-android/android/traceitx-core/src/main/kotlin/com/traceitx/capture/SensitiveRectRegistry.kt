// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Single source of truth for sensitive-view detection on Android. All four
// public marker surfaces funnel through `isSensitive(view)`:
//   • TXSensitiveView (FrameLayout subclass)
//   • View.setTag(R.id.tx_sensitive, true)
//   • EditText with inputType-password variation (auto-detect, PRIV-03)
//   • Modifier.txSensitive() — Compose-side, see W3 spike outcome below.
//
// Mirrors `packages/sdk-ios/Sources/TraceItX/Capture/SensitiveRectRegistry.swift`
// (44 lines).
//
// W3 — Compose Semantics introspection: REINSTATED in Phase 05.2 (post-2026-05-08).
// The original W3 spike documented this as a FALLBACK because reaching
// SemanticsOwner from production code required reflecting against
// package-private Compose API. The Phase 05.2 walker rework already accepted
// that reflection cost — see commit 5411cb0 for the Play-Protect /
// version-policy / R8-keep analysis. The SemanticsNode walk remains necessary
// for screenshot blackout after retirement of the tree replay producer.
// Without this, Modifier.txSensitive() and Compose
// Password fields were INVISIBLE to the screenshot redactor — leaking PII as
// an unredacted bitmap.
//
// Compose-version policy: pinned against compose-ui 1.7.x via
// libs.versions.toml. On rename of getSemanticsOwner / getRootSemanticsNode /
// getBoundsInWindow / getConfig (any future Compose release), the reflection
// fails silently and Compose-side rects are not emitted — screenshot still
// renders, just without the Compose-flagged regions blacked out. Track-down
// signal: the replay walk degrades the same way
// (`degradedReason="compose_semantics_unavailable"`).
//
// Threading: callable from main thread only. Plan 06 invokes this from inside
// the same suspendCancellableCoroutine that issues PixelCopy.request, so the
// rect-walk happens atomically with capture (T-05-03-I-2 mitigation).

package com.traceitx.capture

import android.app.Activity
import android.graphics.Rect
import android.text.InputType
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import com.traceitx.R
import com.traceitx.envelope.txGuard
import com.traceitx.sensitive.TXSensitiveView

// Plan 05-06 cross-module entry — :reporter-ui's TXReporterPresenter calls
// `collectInWindowCoords(activity)` before invoking ScreenshotCapture.
object SensitiveRectRegistry {

    /**
     * Single source of truth: does this View represent a sensitive subtree?
     * Mirrors iOS analog SensitiveRectRegistry.isSensitive (lines 27-31).
     *
     * Note on EditText masking: Android InputType packs class bits (low) and
     * variation bits (mid). Variation constants overlap across classes
     * (e.g. TYPE_NUMBER_VARIATION_PASSWORD=0x10 vs TYPE_TEXT_VARIATION_URI=0x10),
     * so a naive `inputType and pwdMask != 0` produces false positives. We
     * isolate the variation field via TYPE_MASK_VARIATION and compare against
     * each known password variation under the matching class.
     */
    fun isSensitive(view: View): Boolean = when {
        view is TXSensitiveView -> true
        view.getTag(R.id.tx_sensitive) == true -> true
        view is EditText -> isPasswordEditText(view.inputType)
        else -> false
    }

    internal fun isPasswordEditText(inputType: Int): Boolean {
        val cls = inputType and InputType.TYPE_MASK_CLASS
        val variation = inputType and InputType.TYPE_MASK_VARIATION
        return when (cls) {
            InputType.TYPE_CLASS_TEXT ->
                variation == InputType.TYPE_TEXT_VARIATION_PASSWORD ||
                    variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD ||
                    variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD
            InputType.TYPE_CLASS_NUMBER ->
                variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD
            else -> false
        }
    }

    /**
     * Walk the host Activity's content view and emit window-coordinate rects
     * for every sensitive subtree. ScreenshotCapture bakes these black over
     * the bitmap PRE-encode (PRIV-03).
     *
     * Returns an empty list (never null) on any failure — DEFE-02. The
     * Compose-side walk is intentionally absent (W3 FALLBACK — see file header).
     */
    fun collectInWindowCoords(activity: Activity): List<Rect> {
        return txGuard("sensitiveRects.collect") {
            val out = mutableListOf<Rect>()
            val root = activity.findViewById<View>(android.R.id.content) ?: return@txGuard out
            walk(root, out)
            out.toList()
        } ?: emptyList()
    }

    private fun walk(view: View, out: MutableList<Rect>) {
        if (isSensitive(view)) {
            // Full subtree is sensitive — emit our rect, do NOT descend.
            // Mirrors iOS analog lines 33-42 (early-return invariant).
            val loc = IntArray(2)
            view.getLocationInWindow(loc)
            if (view.width > 0 && view.height > 0) {
                out += Rect(loc[0], loc[1], loc[0] + view.width, loc[1] + view.height)
            }
            return
        }
        // Compose screenshot sensitivity reflects AndroidComposeView's
        // SemanticsOwner. Detection is by class FQN
        // (avoids a compile-time dep on the package-private class).
        val isAbstractCompose = try {
            Class.forName("androidx.compose.ui.platform.AbstractComposeView")
                .isAssignableFrom(view.javaClass)
        } catch (_: Throwable) { false }
        val isAndroidCompose =
            view.javaClass.name == "androidx.compose.ui.platform.AndroidComposeView"
        if (isAbstractCompose || isAndroidCompose) {
            collectComposeSensitiveRects(view, out)
            // Continue to normal child walk below — AbstractComposeView's
            // android child (AndroidComposeView) may itself host other Views
            // (RippleHostView, AndroidView interop) that still need View-tier
            // marker checks.
        }
        if (view is ViewGroup) {
            for (i in 0 until view.childCount) {
                walk(view.getChildAt(i), out)
            }
        }
    }

    /** Walk the Compose SemanticsNode tree on `host` and emit window-coord
     *  rects for any node whose SemanticsConfiguration carries
     *  `traceitx.sensitive` (TX_SENSITIVE_KEY) or Compose's built-in `Password`
     *  key. No-op on reflection failure (graceful degrade — UI-tree envelope
     *  surfaces the same degrade signal). */
    private fun collectComposeSensitiveRects(host: View, out: MutableList<Rect>) {
        val rootSemNode = txGuard("sensitiveRects.composeSemanticsRoot") {
            val getSemOwner = host.javaClass.methods.firstOrNull { it.name == "getSemanticsOwner" }
                ?: return@txGuard null
            val owner = getSemOwner.invoke(host) ?: return@txGuard null
            // Prefer the unmerged tree (decision of 2026-05-08). Sensitive containers that use `mergeDescendants`
            // would otherwise hide behind a merged ancestor; the unmerged walk
            // surfaces the exact node carrying the TX_SENSITIVE_KEY / Password
            // marker. Falls back to merged on older Compose versions.
            val unmergedRoot = owner.javaClass.methods.firstOrNull {
                it.name == "getUnmergedRootSemanticsNode"
            }
            val rootMethod = unmergedRoot
                ?: owner.javaClass.methods.firstOrNull { it.name == "getRootSemanticsNode" }
                ?: return@txGuard null
            rootMethod.invoke(owner)
        } ?: return

        // BFS so a sensitive ancestor is detected before its descendants are
        // visited (mirrors the View-tier early-return invariant).
        val frontier = ArrayDeque<Any>()
        frontier.addLast(rootSemNode)
        while (frontier.isNotEmpty()) {
            val node = frontier.removeFirst()
            if (isSensitiveSemNode(node)) {
                val rect = readSemNodeWindowRect(node)
                if (rect != null && !rect.isEmpty) out += rect
                // Do NOT descend — full subtree is sensitive.
                continue
            }
            for (child in readSemanticsChildren(node)) frontier.addLast(child)
        }
    }

    private fun isSensitiveSemNode(node: Any): Boolean {
        val config = try {
            node.javaClass.methods.firstOrNull { it.name == "getConfig" }?.invoke(node)
        } catch (_: Throwable) { null } ?: return false
        return try {
            val iter = (config as Iterable<*>).iterator()
            while (iter.hasNext()) {
                val entry = iter.next() ?: continue
                val key = entry.javaClass.methods.firstOrNull { it.name == "getKey" }?.invoke(entry)
                    ?: continue
                val keyName = key.javaClass.methods.firstOrNull { it.name == "getName" }
                    ?.invoke(key) as? String ?: continue
                // PRIV-02 / PRIV-03 sensitivity markers for screenshot blackout.
                if (keyName == "traceitx.sensitive" || keyName == "Password") return true
            }
            false
        } catch (_: Throwable) { false }
    }

    private fun readSemanticsChildren(node: Any): List<Any> {
        val getChildren = node.javaClass.methods.firstOrNull { it.name == "getChildren" }
            ?: return emptyList()
        @Suppress("UNCHECKED_CAST")
        return (getChildren.invoke(node) as? List<Any>) ?: emptyList()
    }

    private fun readSemNodeWindowRect(node: Any): Rect? {
        return try {
            val m = node.javaClass.methods.firstOrNull { it.name == "getBoundsInWindow" }
                ?: return null
            val rect = m.invoke(node) ?: return null
            // androidx.compose.ui.geometry.Rect — left/top/right/bottom as Float
            val left = (rect.javaClass.getMethod("getLeft").invoke(rect) as Float).toInt()
            val top = (rect.javaClass.getMethod("getTop").invoke(rect) as Float).toInt()
            val right = (rect.javaClass.getMethod("getRight").invoke(rect) as Float).toInt()
            val bottom = (rect.javaClass.getMethod("getBottom").invoke(rect) as Float).toInt()
            Rect(left, top, right, bottom)
        } catch (_: Throwable) {
            null
        }
    }
}
