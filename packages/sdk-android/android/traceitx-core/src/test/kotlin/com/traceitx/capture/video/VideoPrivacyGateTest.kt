// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.capture.video

import android.app.Activity
import android.view.View
import android.widget.EditText
import android.widget.FrameLayout
import com.traceitx.R
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], manifest = Config.NONE)
class VideoPrivacyGateTest {
    private class NativeSubclass(context: android.content.Context) : com.facebook.react.VideoPrivacyFixtureView(context)
    private class MutableTextView(context: android.content.Context) : android.widget.TextView(context) {
        var editor = false
        override fun onCheckIsTextEditor() = editor
    }
    private class NewView(context: android.content.Context) : View(context)

    @Test fun warmClassStillChecksMarkerPasswordAndEditorForEachInstance() {
        val a = Robolectric.buildActivity(Activity::class.java).setup().get()
        val root = FrameLayout(a); a.setContentView(root); root.layout(0,0,100,100)
        val first = MutableTextView(a); root.addView(first)
        val gate = VideoPrivacyGate({ a }, { 0L }, { true })
        val mutations: List<(MutableTextView) -> Unit> = listOf(
            { it.setTag(R.id.tx_sensitive, "unknown") },
            { it.transformationMethod = android.text.method.PasswordTransformationMethod.getInstance() },
            { it.editor = true },
        )
        try {
            for (mutate in mutations) {
                val second = MutableTextView(a); root.addView(second)
                repeat(2) { assertTrue(gate.observe(root).allowed) }
                mutate(second)
                assertFalse(gate.observe(root).allowed)
                // Observed sensitive instances remain in weak history until actual detach.
                root.removeView(second)
                assertTrue(gate.observe(root).allowed)
            }
        } finally { a.finish() }
    }

    @Test fun warmNativeSubclassStillChecksAdapterMutationRemovalAndReplacement() {
        val a = Robolectric.buildActivity(Activity::class.java).setup().get()
        val root = FrameLayout(a); a.setContentView(root); root.layout(0,0,100,100)
        var native = NativeSubclass(a); root.addView(native)
        val gate = VideoPrivacyGate({ a }, { 0L }, { true })
        var decision = VideoPrivacyAdapter.Classification.ORDINARY_VIEW
        val registration = VideoPrivacyGate.registerPlatformAdapter(VideoPrivacyAdapter {
            if (it === native) decision else VideoPrivacyAdapter.Classification.ORDINARY_VIEW
        })
        try {
            repeat(2) { assertTrue(gate.observe(root).allowed) }
            decision = VideoPrivacyAdapter.Classification.UNKNOWN
            assertFalse(gate.observe(root).allowed)
            decision = VideoPrivacyAdapter.Classification.ORDINARY_VIEW
            assertTrue(gate.observe(root).allowed)
            decision = VideoPrivacyAdapter.Classification.EXCLUDE
            assertFalse(gate.observe(root).allowed)
            root.removeView(native)
            native = NativeSubclass(a); root.addView(native)
            decision = VideoPrivacyAdapter.Classification.ORDINARY_VIEW
            assertTrue(gate.observe(root).allowed)
            registration.close()
            assertFalse("RN superclass still excludes without adapter", gate.observe(root).allowed)
            VideoPrivacyGate.registerPlatformAdapter(VideoPrivacyAdapter { error("replacement unavailable") }).use {
                assertFalse(gate.observe(root).allowed)
            }
            VideoPrivacyGate.registerPlatformAdapter(VideoPrivacyAdapter { VideoPrivacyAdapter.Classification.ORDINARY_VIEW }).use {
                assertTrue(gate.observe(root).allowed)
            }
            assertFalse(gate.observe(root).allowed)
        } finally { registration.close(); a.finish() }
    }

    @Test fun warmAncestryAvoidsRepeatedWorkButColdMissAndRemainingWorkStillHaveDeadline() {
        val a = Robolectric.buildActivity(Activity::class.java).setup().get()
        val root = FrameLayout(a); a.setContentView(root); root.layout(0,0,100,100)
        repeat(100) { root.addView(View(a)) }
        var now = 0L
        val cache = VideoPrivacyTypeCache { now += 2_000_001L; it.superclass }
        val gate = VideoPrivacyGate({ a }, { now }, { true }, typeCache = cache)
        try {
            cache.classify(FrameLayout::class.java); cache.classify(View::class.java)
            now = 0L
            assertTrue("warm traversal must avoid charged ancestry work", gate.observe(root).allowed)
            assertEquals(0L, now)
            root.addView(NewView(a))
            assertFalse("cold ancestry work is inside the original deadline", gate.observe(root).allowed)
            root.removeViewAt(root.childCount - 1)
            VideoPrivacyGate.registerPlatformAdapter(VideoPrivacyAdapter {
                now += 2_000_001L
                VideoPrivacyAdapter.Classification.ORDINARY_VIEW
            }).use {
                assertFalse("warm metadata cannot bypass remaining work deadline", gate.observe(root).allowed)
            }
            root.removeAllViews()
            repeat(2048) { root.addView(View(a)) }
            assertFalse("warm metadata cannot bypass node bound", gate.observe(root).allowed)
        } finally { a.finish() }
    }

    @Test fun warmUnsupportedTypesStillExcludeEvenWithOrdinaryAdapter() {
        val a = Robolectric.buildActivity(androidx.activity.ComponentActivity::class.java).setup().get()
        val root = FrameLayout(a); a.setContentView(root); root.layout(0,0,100,100)
        val cache = VideoPrivacyTypeCache()
        val gate = VideoPrivacyGate({ a }, { 0L }, { true }, typeCache = cache)
        val composeType = Class.forName("androidx.compose.ui.platform.AndroidComposeView")
        val factories: List<() -> View> = listOf(
            { android.webkit.WebView(a) },
            { android.view.SurfaceView(a) },
            { android.view.TextureView(a) },
            { EditText(a) },
            { composeType.getConstructor(android.content.Context::class.java, kotlin.coroutines.CoroutineContext::class.java)
                .newInstance(a, kotlin.coroutines.EmptyCoroutineContext) as View },
        )
        try {
            VideoPrivacyGate.registerPlatformAdapter(VideoPrivacyAdapter { VideoPrivacyAdapter.Classification.ORDINARY_VIEW }).use {
                for (create in factories) {
                    val child = create()
                    cache.classify(child.javaClass) // Warm immutable type before its first attachment.
                    root.addView(child, FrameLayout.LayoutParams(100,100))
                    val size = View.MeasureSpec.makeMeasureSpec(500, View.MeasureSpec.EXACTLY)
                    a.window.decorView.measure(size, size)
                    a.window.decorView.layout(0, 0, 500, 500)
                    child.layout(0, 0, 100, 100)
                    // Robolectric's WebView provider leaves setFrame unimplemented.
                    child.left = 0; child.top = 0; child.right = 100; child.bottom = 100
                    assertFalse("unsupported warm type ${child.javaClass.name}", gate.observe(root).allowed)
                    root.removeView(child)
                    if (child is android.webkit.WebView) child.destroy()
                    assertTrue(gate.observe(root).allowed)
                }
            }
        } finally { a.finish() }
    }

    @Test fun unknownTypeAncestryFailsClosedAndCanBeRetried() {
        val a = Robolectric.buildActivity(Activity::class.java).setup().get()
        val root = FrameLayout(a); a.setContentView(root); root.layout(0,0,100,100)
        var fail = true
        val cache = VideoPrivacyTypeCache { if (fail) error("unknown type") else it.superclass }
        val gate = VideoPrivacyGate({ a }, { 0L }, { true }, typeCache = cache)
        try {
            assertFalse(gate.observe(root).allowed)
            fail = false
            assertTrue(gate.observe(root).allowed)
        } finally { a.finish() }
    }

    @Test fun finalAdapterRemovalPublishesBeforeReleasingItsFence() {
        val a = Robolectric.buildActivity(Activity::class.java).setup().get()
        val root = FrameLayout(a); a.setContentView(root); root.layout(0,0,100,100)
        root.addView(com.facebook.react.VideoPrivacyFixtureView(a))
        val gate = VideoPrivacyGate({ a }, { 0L }, { true })
        val fenceReleased = java.util.concurrent.CountDownLatch(1)
        val finishClose = java.util.concurrent.CountDownLatch(1)
        val closeFailure = java.util.concurrent.atomic.AtomicReference<Throwable?>()
        var transition = 0
        val registration = VideoPrivacyGate.registerPlatformAdapter(
            VideoPrivacyAdapter { VideoPrivacyAdapter.Classification.ORDINARY_VIEW },
            beginAuthorityChange = {
                val token = VideoPrivacyRevocation.begin()
                val finalRemoval = ++transition == 2
                AutoCloseable {
                    token.close()
                    if (finalRemoval) {
                        fenceReleased.countDown()
                        check(finishClose.await(3, java.util.concurrent.TimeUnit.SECONDS))
                    }
                }
            },
        )
        assertTrue(gate.observe(root).allowed)
        val thread = Thread { try { registration.close() } catch (error: Throwable) { closeFailure.set(error) } }
        thread.start()
        try {
            assertTrue(fenceReleased.await(3, java.util.concurrent.TimeUnit.SECONDS))
            assertFalse(VideoPrivacyRevocation.blocked)
            // Exact vulnerable boundary: capture can now snapshot the new generation.
            val snapshot = VideoPrivacyRevocation.current
            assertFalse("released fence must already expose adapter absence", gate.observe(root).allowed)
            assertTrue("ordinary absence is a gap, not another global revocation", VideoPrivacyRevocation.permits(snapshot))
        } finally {
            finishClose.countDown(); thread.join(3000)
            registration.close(); a.finish()
        }
        assertFalse(thread.isAlive)
        assertNull(closeFailure.get())
    }
    @Test fun backgroundMarkerBlocksBeforeMainMutationThenPreservesTag() {
        val a = Robolectric.buildActivity(Activity::class.java).setup().get()
        val view = View(a)
        val before = VideoPrivacyRevocation.current
        val thread = Thread { com.traceitx.TraceItX.markSensitive(view) }
        thread.start(); thread.join()
        assertFalse(VideoPrivacyRevocation.permits(before))
        assertTrue("mutation is pending on main", VideoPrivacyRevocation.blocked)
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
        assertEquals(true, view.getTag(R.id.tx_sensitive))
        assertFalse(VideoPrivacyRevocation.blocked)
        a.finish()
    }
    @Test fun ordinaryExclusionChangesLocalEpochWithoutRevokingRetainedGeneration() {
        val a = Robolectric.buildActivity(Activity::class.java).setup().get()
        val root = FrameLayout(a); a.setContentView(root); root.layout(0,0,100,100)
        val gate = VideoPrivacyGate({ a }, { 0L }, { true })
        val clean = gate.observe(root)
        val before = VideoPrivacyRevocation.current
        root.addView(EditText(a))
        val excluded = gate.observe(root)
        assertFalse(excluded.allowed)
        assertTrue(excluded.epoch > clean.epoch)
        assertTrue("ordinary gaps preserve already-safe history", VideoPrivacyRevocation.permits(before))
        a.finish()
    }
    @Test fun markedViewInOverlayRemainsExcludedUntilActualDetach() {
        val a = Robolectric.buildActivity(Activity::class.java).setup().get()
        val root = FrameLayout(a); a.setContentView(root); root.layout(0,0,100,100)
        val child = View(a); root.addView(child)
        com.traceitx.TraceItX.markSensitive(child)
        root.overlay.add(child)
        assertTrue("fixture must remain attached", child.isAttachedToWindow)
        val gate = VideoPrivacyGate({ a }, { 0L }, { true })
        assertFalse("overlay pixels retain sensitivity", gate.observe(root).allowed)
        root.overlay.remove(child)
        assertTrue(gate.observe(root).allowed)
        a.finish()
    }
    @Test fun sharedAdapterRegistrationsAreIdempotentlyReferenceCountedAndErrorsExclude() {
        val a = Robolectric.buildActivity(Activity::class.java).setup().get()
        val root = FrameLayout(a); a.setContentView(root); root.layout(0,0,100,100)
        val adapter = VideoPrivacyAdapter { throw IllegalStateException() }
        val first = VideoPrivacyGate.registerPlatformAdapter(adapter)
        val second = VideoPrivacyGate.registerPlatformAdapter(adapter)
        try {
            first.close(); first.close()
            assertFalse(VideoPrivacyGate({ a }, { 0L }, { true }).observe(root).allowed)
        } finally { first.close(); second.close(); a.finish() }
    }
    @Test fun preStartMarkerAndUnsupportedColorModeExclude() {
        val a = Robolectric.buildActivity(Activity::class.java).setup().get()
        val root = FrameLayout(a); a.setContentView(root); root.layout(0,0,100,100)
        val gate = VideoPrivacyGate({ a }, { 0L }, { true })
        com.traceitx.TraceItX.markSensitive(root)
        assertFalse("pre-start sensitivity must persist", gate.observe(root).allowed)
        val clean = FrameLayout(a); a.setContentView(clean); clean.layout(0,0,100,100)
        assertTrue(gate.observe(clean).allowed)
        a.window.colorMode = android.content.pm.ActivityInfo.COLOR_MODE_WIDE_COLOR_GAMUT
        assertFalse("non-SDR window", gate.observe(clean).allowed)
        a.window.colorMode = android.content.pm.ActivityInfo.COLOR_MODE_HDR
        assertFalse(gate.observe(clean).allowed)
        a.finish()
    }
    @Test fun inputsUnknownTagsAndOffscreenSensitiveViewsAreExcluded() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val root = FrameLayout(activity); activity.setContentView(root)
        val gate = VideoPrivacyGate({ activity }, { 0L }, { true })
        root.layout(0,0,100,100)
        assertTrue(gate.observe(root).allowed)
        val child = View(activity); child.translationX = 10000f; child.setTag(R.id.tx_sensitive,true); root.addView(child)
        val sensitive = gate.observe(root); assertFalse(sensitive.allowed)
        root.removeAllViews(); assertTrue(gate.observe(root).epoch > sensitive.epoch)
        child.setTag(R.id.tx_sensitive,"unknown"); root.addView(child); assertFalse(gate.observe(root).allowed)
        root.removeAllViews(); root.addView(EditText(activity)); assertFalse(gate.observe(root).allowed)
        activity.finish()
    }
    @Test fun countAndTimeBudgetFailClosed() {
        val a = Robolectric.buildActivity(Activity::class.java).setup().get()
        val root = FrameLayout(a); a.setContentView(root); root.layout(0,0,100,100)
        repeat(2048) { root.addView(View(a)) }
        assertFalse(VideoPrivacyGate({ a }, { 0L }, { true }).observe(root).allowed)
        root.removeAllViews()
        var now = 0L
        assertFalse(VideoPrivacyGate({ a }, { now.also { now += 2_000_001 } }, { true }).observe(root).allowed)
        a.finish()
    }
}
