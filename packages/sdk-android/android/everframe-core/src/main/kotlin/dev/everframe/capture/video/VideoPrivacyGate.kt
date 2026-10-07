// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import android.app.Activity
import android.os.Looper
import android.os.SystemClock
import android.text.method.PasswordTransformationMethod
import android.view.SurfaceView
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebView
import android.widget.EditText
import android.widget.TextView
import dev.everframe.R
import dev.everframe.sensitive.TXSensitiveView
import java.lang.ref.WeakReference

/**
 * Main-only traversal. Inputs, TextureViews and sensitive views are masked; WebViews, Compose,
 * unclassified views and anything that cannot be placed on screen refuse the frame.
 */
internal class VideoPrivacyGate(
    private val activity: () -> Activity?,
    private val nowNanos: () -> Long = SystemClock::elapsedRealtimeNanos,
    private val windowFocused: (View) -> Boolean = { it.hasWindowFocus() },
    // Test investigation seam only. Production excludes Compose: framework semantics child-list
    // construction was measured to exceed the admission budget on nonsemantic layout nodes.
    private val composeInspector: ((View, Long, Int) -> Pair<VideoPrivacyAdapter.Classification, Int>)? = null,
    private val typeCache: VideoPrivacyTypeCache = VideoPrivacyTypeCache(),
) {
    private var rootRef = WeakReference<View>(null)
    private var previous: PrivacyObservation? = null
    private var epoch = 0L

    fun observe(root: View): PrivacyObservation {
        check(Looper.myLooper() == Looper.getMainLooper())
        val start = nowNanos()
        val window = activity()?.window
        val identity = root.windowToken
        var allowed = window != null && identity != null && root.isAttachedToWindow &&
            root.rootView === window.decorView && windowFocused(root) && root.width > 0 && root.height > 0 &&
            !VideoPrivacyRevocation.blocked &&
            (android.os.Build.VERSION.SDK_INT < 26 || window.colorMode == android.content.pm.ActivityInfo.COLOR_MODE_DEFAULT) &&
            window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE == 0
        val queue = ArrayDeque<View>()
        if (allowed) queue.add(root)
        val masks = LinkedHashSet<android.graphics.Rect>()
        // True when the view is hidden or its bounds were added as a mask; false when its
        // position on screen cannot be proven (not under this root), which refuses the frame.
        fun mask(view: View): Boolean {
            val bounds = VideoMaskBounds.of(view, root) ?: return false
            if (!bounds.isEmpty) masks.add(bounds)
            return true
        }
        var visited = if (allowed) VideoSensitiveViews.inspect(identity, start + 2_000_000L, 2048, nowNanos, ::mask) { view, remaining ->
            val marker = view.getTag(R.id.tx_sensitive)
            val classification = try { platformAdapter?.classify(view) } catch (_: Throwable) { VideoPrivacyAdapter.Classification.UNKNOWN }
            if ((marker != null && marker != false) || view is TXSensitiveView ||
                classification == VideoPrivacyAdapter.Classification.EXCLUDE || classification == VideoPrivacyAdapter.Classification.UNKNOWN ||
                (platformAdapter == null && typeCache.classify(view.javaClass)?.reactNative != false)) null
            else HiddenVideoWebView.inspect(view, start + 2_000_000L, remaining, nowNanos)
        } ?: 2049 else 0
        if (visited > 2048) allowed = false
        while (allowed && queue.isNotEmpty()) {
            if (visited + queue.size > 2048 || nowNanos() - start > 2_000_000L) { allowed = false; break }
            val view = queue.removeFirst(); visited++
            val adapter = platformAdapter
            val classification = try { adapter?.classify(view) } catch (_: Throwable) { VideoPrivacyAdapter.Classification.UNKNOWN }
            val types = typeCache.classify(view.javaClass)
            if (types == null || classification == VideoPrivacyAdapter.Classification.UNKNOWN ||
                (adapter == null && types.reactNative)) {
                allowed = false; break
            }
            val marker = view.getTag(R.id.tx_sensitive)
            if (classification == VideoPrivacyAdapter.Classification.EXCLUDE ||
                (marker != null && marker != false) || view is TXSensitiveView || view is EditText ||
                (view is TextView && (view.onCheckIsTextEditor() || view.transformationMethod is PasswordTransformationMethod)) ||
                view is TextureView) {
                // Painted black, children included, instead of refusing the frame. History keeps
                // it covered if it is later reparented into an overlay this walk cannot reach.
                VideoSensitiveViews.remember(view)
                if (!mask(view)) { allowed = false; break }
                continue
            }
            // A SurfaceView renders into its own surface, which a window PixelCopy never contains:
            // its area comes out empty without a mask, and overlays drawn above it (subtitles,
            // player controls) stay visible. A TextureView draws into the window and is masked.
            if (view is SurfaceView) continue
            if (view is WebView) {
                val hiddenVisits = HiddenVideoWebView.inspect(view, start + 2_000_000L, 2048 - visited - queue.size, nowNanos)
                if (hiddenVisits == null) {
                    VideoSensitiveViews.rememberObserved(view, automaticWebView = true)
                    allowed = false; break
                }
                visited += hiddenVisits
                val rememberedVisits = VideoSensitiveViews.rememberHiddenWebView(view, start + 2_000_000L, 2048 - visited - queue.size, nowNanos)
                if (rememberedVisits == null) { allowed = false; break }
                visited += rememberedVisits
            }
            if (types.composeHost) {
                val inspection = composeInspector?.invoke(view, start + 2_000_000L, 2048 - visited - queue.size)
                if (inspection?.first != VideoPrivacyAdapter.Classification.ORDINARY_VIEW) {
                    VideoSensitiveViews.rememberObserved(view)
                    allowed = false; break
                }
                visited += inspection.second
            }
            if (view is ViewGroup) {
                if (nowNanos() - start >= 2_000_000L) { allowed = false; break }
                if (visited + queue.size + view.childCount > 2048) { allowed = false; break }
                for (i in 0 until view.childCount) {
                    if (nowNanos() - start >= 2_000_000L) { allowed = false; break }
                    queue.add(view.getChildAt(i))
                }
            }
        }
        if (nowNanos() - start > 2_000_000L) allowed = false
        // While the keyboard pans the window (adjustPan), the decor is drawn shifted in the buffer
        // PixelCopy copies, so root-relative masks would land below the views they should cover.
        if (allowed && masks.isNotEmpty() && windowShifted(root)) allowed = false
        val old = previous
        val maskList = if (allowed) masks.toList() else emptyList()
        // A moved or new mask is a new privacy state: a pending copy made under the old masks is dropped.
        if (rootRef.get() !== root || old == null || old.windowIdentity !== identity || old.width != root.width ||
            old.height != root.height || old.allowed != allowed || !allowed || old.masks != maskList) epoch++
        rootRef = WeakReference(root)
        return PrivacyObservation(identity, root.width, root.height, epoch, allowed, maskList).also { previous = it }
    }

    // The decor's window location includes ViewRootImpl's pan offset (mCurScrollY).
    private fun windowShifted(root: View): Boolean {
        val decor = root.rootView
        val origin = IntArray(2).also { decor.getLocationInWindow(it) }
        return origin[0] != 0 || origin[1] != 0 || !decor.matrix.isIdentity
    }

    companion object {
        @Volatile private var platformAdapter: VideoPrivacyAdapter? = null
        private var adapterReferences = 0L
        fun registerPlatformAdapter(
            adapter: VideoPrivacyAdapter,
            beginAuthorityChange: () -> AutoCloseable = VideoPrivacyRevocation::begin,
        ): AutoCloseable {
            synchronized(this) {
                check(platformAdapter == null || platformAdapter === adapter) { "A different video privacy adapter is already registered" }
                adapterReferences++
                beginAuthorityChange().use { platformAdapter = adapter }
            }
            val closed = java.util.concurrent.atomic.AtomicBoolean()
            return AutoCloseable { synchronized(this) {
                if (closed.compareAndSet(false, true) && platformAdapter === adapter) {
                    adapterReferences--
                    if (adapterReferences == 0L) {
                        beginAuthorityChange().use { platformAdapter = null }
                    }
                }
            } }
        }
    }
}
