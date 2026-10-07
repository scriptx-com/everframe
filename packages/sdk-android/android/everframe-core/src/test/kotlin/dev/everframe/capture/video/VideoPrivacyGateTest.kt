// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import android.app.Activity
import android.view.View
import android.widget.EditText
import android.widget.FrameLayout
import dev.everframe.R
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

    private fun masked(o: PrivacyObservation, view: View, root: View): Boolean {
        val bounds = VideoMaskBounds.of(view, root) ?: return false
        // Masks are clipped to the frame: nothing needs covering when the view is entirely outside it.
        if (!bounds.intersect(0, 0, root.width, root.height)) return o.allowed
        return o.allowed && o.masks.any { it.contains(bounds) }
    }

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
                assertTrue("sensitive instance is masked", masked(gate.observe(root), second, root))
                // Observed sensitive instances remain in weak history until actual detach.
                root.removeView(second)
                val clean = gate.observe(root)
                assertTrue(clean.allowed); assertTrue(clean.masks.isEmpty())
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
            assertTrue("adapter exclusion is masked", masked(gate.observe(root), native, root))
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
                    val seen = gate.observe(root)
                    if (child is android.webkit.WebView || child.javaClass == composeType) {
                        assertFalse("unsupported warm type ${child.javaClass.name}", seen.allowed)
                    } else if (child is android.view.SurfaceView) {
                        assertTrue("SurfaceView pixels are never in a window copy", seen.allowed && seen.masks.isEmpty())
                    } else {
                        assertTrue("maskable warm type ${child.javaClass.name}", masked(seen, child, root))
                    }
                    root.removeView(child)
                    if (child is android.webkit.WebView) child.destroy()
                    assertTrue(gate.observe(root).allowed)
                }
            }
        } finally { a.finish() }
    }

    private fun historyEntries(view: View): Int {
        val views = VideoSensitiveViews::class.java.getDeclaredField("views").apply { isAccessible = true }.get(null) as List<*>
        return views.count { entry ->
            val reference = entry!!.javaClass.getDeclaredField("reference").apply { isAccessible = true }.get(entry)
            (reference as java.lang.ref.WeakReference<*>).get() === view
        }
    }

    @Test fun refusedComposeHostIsRememberedOnceAcrossFrames() {
        val a = Robolectric.buildActivity(androidx.activity.ComponentActivity::class.java).setup().get()
        val root = FrameLayout(a); a.setContentView(root); root.layout(0,0,100,100)
        val compose = Class.forName("androidx.compose.ui.platform.AndroidComposeView")
            .getConstructor(android.content.Context::class.java, kotlin.coroutines.CoroutineContext::class.java)
            .newInstance(a, kotlin.coroutines.EmptyCoroutineContext) as View
        root.addView(compose, FrameLayout.LayoutParams(100,100)); compose.layout(0,0,100,100)
        val gate = VideoPrivacyGate({ a }, { 0L }, { true })
        try {
            repeat(50) { assertFalse(gate.observe(root).allowed) }
            // An entry per refused frame would fill the 2,048-entry history, which disables video until restart.
            assertEquals(1, historyEntries(compose))
        } finally { root.removeView(compose); a.finish() }
    }

    @Test fun flutterHostRefusesFramesAlthoughItsSurfaceIsSkipped() {
        val a = Robolectric.buildActivity(Activity::class.java).setup().get()
        val root = FrameLayout(a); a.setContentView(root); root.layout(0,0,100,100)
        val flutter = object : io.flutter.embedding.android.FlutterView(a) {}
        root.addView(flutter); flutter.layout(0,0,100,100)
        // With hybrid composition the paused surface stays attached while an image view draws the UI.
        flutter.addView(android.view.SurfaceView(a)); flutter.addView(View(a))
        val gate = VideoPrivacyGate({ a }, { 0L }, { true })
        try {
            repeat(3) { assertFalse("Flutter pixels are recorded only through the masked Dart replay", gate.observe(root).allowed) }
            assertEquals(1, historyEntries(flutter))
            root.removeView(flutter)
            assertTrue(gate.observe(root).allowed)
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
        val thread = Thread { dev.everframe.Everframe.markSensitive(view) }
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
        val input = EditText(a); root.addView(input)
        val excluded = gate.observe(root)
        assertTrue(masked(excluded, input, root))
        assertTrue("a new mask is a new privacy state", excluded.epoch > clean.epoch)
        assertTrue("ordinary gaps preserve already-safe history", VideoPrivacyRevocation.permits(before))
        a.finish()
    }
    @Test fun markedViewInOverlayRemainsExcludedUntilActualDetach() {
        val a = Robolectric.buildActivity(Activity::class.java).setup().get()
        val root = FrameLayout(a); a.setContentView(root); root.layout(0,0,100,100)
        val child = View(a); root.addView(child)
        dev.everframe.Everframe.markSensitive(child)
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
        dev.everframe.Everframe.markSensitive(root)
        val marked = gate.observe(root)
        assertTrue("pre-start sensitivity must persist: the whole root is masked",
            marked.allowed && marked.masks.any { it.contains(android.graphics.Rect(0, 0, root.width, root.height)) })
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
        val child = View(activity); child.setTag(R.id.tx_sensitive,true); root.addView(child)
        val sensitive = gate.observe(root); assertTrue(masked(sensitive, child, root))
        root.removeAllViews(); assertTrue(gate.observe(root).epoch > sensitive.epoch)
        child.setTag(R.id.tx_sensitive,"unknown"); root.addView(child); assertTrue(masked(gate.observe(root), child, root))
        root.removeAllViews(); val input = EditText(activity); root.addView(input); assertTrue(masked(gate.observe(root), input, root))
        // Entirely outside the frame there is nothing to paint.
        root.removeAllViews(); child.translationX = 10000f; root.addView(child)
        val offscreen = gate.observe(root); assertTrue(offscreen.allowed); assertTrue(offscreen.masks.isEmpty())
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

    @Test fun masksFollowTransformsScrollAndVisibilityAndSkipChildren() {
        val a = Robolectric.buildActivity(Activity::class.java).setup().get()
        val root = FrameLayout(a); a.setContentView(root); root.layout(0,0,400,400)
        val scroller = FrameLayout(a); root.addView(scroller); scroller.layout(0,0,400,400); scroller.scrollTo(0, 50)
        val holder = FrameLayout(a); scroller.addView(holder); holder.layout(100,100,300,300)
        val input = EditText(a); holder.addView(input); input.layout(10,20,110,60)
        // Refuses the frame if the walk ever classifies it: no adapter is registered.
        val inside = com.facebook.react.VideoPrivacyFixtureView(a)
        val gate = VideoPrivacyGate({ a }, { 0L }, { true })
        try {
            val o = gate.observe(root)
            assertTrue(o.allowed)
            assertEquals(listOf(android.graphics.Rect(109, 69, 211, 111)), o.masks)
            holder.translationX = 30f
            assertEquals(android.graphics.Rect(139, 69, 241, 111), gate.observe(root).masks.single())
            holder.visibility = View.INVISIBLE
            assertFalse("an overlay ghost may draw an invisible original", gate.observe(root).allowed)
            holder.visibility = View.GONE
            val hidden = gate.observe(root)
            assertTrue(hidden.allowed); assertTrue("a GONE ordinary child is not drawn", hidden.masks.isEmpty())
            holder.visibility = View.VISIBLE
            val group = FrameLayout(a); root.addView(group); group.layout(0,0,50,50)
            group.setTag(R.id.tx_sensitive, true)
            group.addView(inside); inside.layout(5,5,20,20)
            val withGroup = gate.observe(root)
            assertTrue("children of a masked view are covered, not walked", withGroup.allowed)
            assertEquals(setOf(android.graphics.Rect(139, 69, 241, 111), android.graphics.Rect(0, 0, 51, 51)), withGroup.masks.toSet())
        } finally { a.finish() }
    }

    /** root 400x400, holder at (0,0,400,400), input at (10,10,110,60) inside it. */
    private fun placementFixture(test: (FrameLayout, FrameLayout, EditText, VideoPrivacyGate) -> Unit) {
        val a = Robolectric.buildActivity(Activity::class.java).setup().get()
        val root = FrameLayout(a); a.setContentView(root); root.layout(0,0,400,400)
        val holder = FrameLayout(a); root.addView(holder); holder.layout(0,0,400,400)
        val input = EditText(a); holder.addView(input); input.layout(10,10,110,60)
        try { test(root, holder, input, VideoPrivacyGate({ a }, { 0L }, { true })) } finally { a.finish() }
    }

    @Test fun legacyAnimationsRefuseMaskedFrames() = placementFixture { root, holder, input, gate ->
        assertTrue(masked(gate.observe(root), input, root))
        // A tween is applied while drawing, outside View.getMatrix(): the field is drawn away from its mask.
        holder.startAnimation(android.view.animation.TranslateAnimation(0f, 200f, 0f, 0f).apply { duration = 1000 })
        assertFalse("tween on an ancestor", gate.observe(root).allowed)
        holder.clearAnimation()
        assertTrue(masked(gate.observe(root), input, root))
        input.startAnimation(android.view.animation.TranslateAnimation(0f, 200f, 0f, 0f).apply { duration = 1000 })
        assertFalse("tween on the masked view", gate.observe(root).allowed)
        input.clearAnimation()
        assertTrue(masked(gate.observe(root), input, root))
    }

    // The legacy RenderNode shadow drops animation matrices; native graphics keeps them.
    @org.robolectric.annotation.GraphicsMode(org.robolectric.annotation.GraphicsMode.Mode.NATIVE)
    @Test fun animationMatrixRefusesMaskedFrames() = placementFixture { root, holder, input, gate ->
        holder.animationMatrix = android.graphics.Matrix().apply { setTranslate(200f, 0f) }
        assertNotNull("fixture must keep the animation matrix", holder.animationMatrix)
        assertFalse("animation matrix on an ancestor", gate.observe(root).allowed)
        holder.animationMatrix = null
        assertTrue(masked(gate.observe(root), input, root))
    }

    @Test fun exitTweenOnRememberedRemovalTransitionChildRefusesFrames() = placementFixture { root, holder, input, gate ->
        assertTrue(masked(gate.observe(root), input, root))
        root.startViewTransition(holder); root.removeView(holder)
        try {
            assertTrue(input.isAttachedToWindow); assertEquals(-1, root.indexOfChild(holder))
            assertTrue("history still masks the retained input", masked(gate.observe(root), input, root))
            holder.startAnimation(android.view.animation.TranslateAnimation(0f, 200f, 0f, 0f).apply { duration = 1000 })
            assertFalse("the exit tween moves the input away from its mask", gate.observe(root).allowed)
        } finally { holder.clearAnimation(); root.endViewTransition(holder) }
    }

    /** Robolectric never reports the app window visible, and LayoutTransition skips hidden windows. */
    private fun showWindow(view: View) {
        val info = org.robolectric.util.ReflectionHelpers.getField<Any>(view, "mAttachInfo")
        org.robolectric.util.ReflectionHelpers.setField(info, "mWindowVisibility", View.VISIBLE)
    }

    @Test fun runningLayoutTransitionRefusesMaskedFrames() = placementFixture { root, holder, input, gate ->
        showWindow(root)
        holder.layoutTransition = android.animation.LayoutTransition()
        val sibling = View(root.context); holder.addView(sibling)
        try {
            assertTrue("fixture must run an appearing transition", holder.layoutTransition.isRunning)
            assertFalse("children move while a layout transition runs", gate.observe(root).allowed)
        } finally { holder.layoutTransition = null }
        assertTrue(masked(gate.observe(root), input, root))
    }

    @Test fun ghostedOrTransitionHiddenInputRefusesFrames() = placementFixture { root, holder, input, gate ->
        assertTrue(masked(gate.observe(root), input, root))
        holder.transitionAlpha = 0f
        assertFalse("a transition can hide the original while drawing a copy", gate.observe(root).allowed)
        holder.transitionAlpha = 1f
        input.setTransitionVisibility(View.INVISIBLE)
        assertFalse("transition visibility hides the original, not its pixels", gate.observe(root).allowed)
        input.setTransitionVisibility(View.VISIBLE)
        assertTrue(masked(gate.observe(root), input, root))
        // The platform's actual shared-element ghost: it hides the original and draws it from the decor overlay.
        val ghostType = Class.forName("android.view.GhostView")
        try {
            ghostType.getDeclaredMethod("addGhost", View::class.java, android.view.ViewGroup::class.java, android.graphics.Matrix::class.java)
                .invoke(null, holder, root.rootView, android.graphics.Matrix())
            assertEquals(View.INVISIBLE, holder.visibility)
            assertNull(holder.animation)
            assertFalse("the ghost draws the input where no mask is", gate.observe(root).allowed)
        } finally {
            ghostType.getDeclaredMethod("removeGhost", View::class.java).invoke(null, holder)
        }
        assertTrue(masked(gate.observe(root), input, root))
    }

    @Test fun goneInputIsUnmaskedOnlyWhileNothingCanStillDrawIt() = placementFixture { root, holder, input, gate ->
        assertTrue(masked(gate.observe(root), input, root))
        holder.visibility = View.GONE
        val gone = gate.observe(root)
        assertTrue("an ordinary GONE child is not drawn", gone.allowed); assertTrue(gone.masks.isEmpty())
        holder.visibility = View.VISIBLE
        // A removal transition keeps drawing the removed child, GONE or not.
        root.startViewTransition(holder); holder.visibility = View.GONE; root.removeView(holder)
        try {
            assertTrue(input.isAttachedToWindow); assertSame(root, holder.parent); assertEquals(-1, root.indexOfChild(holder))
            assertNull(holder.animation)
            assertFalse("a disappearing child can draw despite GONE", gate.observe(root).allowed)
        } finally { root.endViewTransition(holder) }
    }

    @Test fun goneInputThatIsStillAnimatingOutRefusesFrames() = placementFixture { root, holder, input, gate ->
        input.startAnimation(android.view.animation.AlphaAnimation(1f, 0f).apply { duration = 300 })
        input.visibility = View.GONE
        assertFalse("ViewGroup draws a GONE child while its animation runs", gate.observe(root).allowed)
        input.clearAnimation()
        val gone = gate.observe(root); assertTrue(gone.allowed); assertTrue(gone.masks.isEmpty())
        input.visibility = View.VISIBLE
        showWindow(root)
        holder.layoutTransition = android.animation.LayoutTransition()
        input.visibility = View.GONE
        try {
            assertTrue("fixture must run a disappearing transition", holder.layoutTransition.isRunning)
            assertFalse("the layout transition fades the GONE input out on screen", gate.observe(root).allowed)
        } finally { holder.layoutTransition = null }
        val hidden = gate.observe(root); assertTrue(hidden.allowed); assertTrue(hidden.masks.isEmpty())
    }

    @Test fun keyboardPannedWindowRefusesFramesThatNeedMasks() {
        val a = Robolectric.buildActivity(Activity::class.java).setup().get()
        val root = FrameLayout(a); a.setContentView(root); root.layout(0,0,300,300)
        val input = EditText(a); root.addView(input); input.layout(0,100,200,150)
        val decor = a.window.decorView
        val viewRoot = decor.parent
        val gate = VideoPrivacyGate({ a }, { 0L }, { true })
        fun windowRect(view: View) = IntArray(2).also { view.getLocationInWindow(it) }
            .let { android.graphics.Rect(it[0], it[1], it[0] + view.width, it[1] + view.height) }
        try {
            assertTrue(masked(gate.observe(decor), input, decor))
            val before = windowRect(input)
            // adjustPan: ViewRootImpl draws the whole decor shifted up by mCurScrollY, and PixelCopy copies that buffer.
            org.robolectric.util.ReflectionHelpers.setField(viewRoot, "mCurScrollY", 60)
            assertEquals("fixture must pan the window", before.top - 60, windowRect(input).top)
            val panned = gate.observe(decor)
            assertTrue("a decor-relative mask lands below the panned field",
                !panned.allowed || panned.masks.any { it.contains(windowRect(input)) })
            root.removeView(input)
            assertTrue("a panned frame with nothing to mask is still recorded", gate.observe(decor).allowed)
        } finally { org.robolectric.util.ReflectionHelpers.setField(viewRoot, "mCurScrollY", 0); a.finish() }
    }

    @Test fun maskedGroupUnderNonClippingParentCoversChildrenDrawnOutsideIt() {
        val a = Robolectric.buildActivity(Activity::class.java).setup().get()
        val root = FrameLayout(a); a.setContentView(root); root.layout(0,0,400,400)
        val container = FrameLayout(a); root.addView(container); container.layout(0,0,400,400)
        val group = FrameLayout(a); container.addView(group); group.layout(10,10,60,60)
        group.setTag(R.id.tx_sensitive, true)
        val child = View(a); group.addView(child); child.layout(60,0,160,50)
        val inner = FrameLayout(a); group.addView(inner); inner.layout(0,0,50,50)
        val deep = View(a); inner.addView(deep); deep.layout(200,200,250,250)
        val gate = VideoPrivacyGate({ a }, { 0L }, { true })
        try {
            assertEquals("a clipping parent confines the group's subtree to its bounds",
                listOf(android.graphics.Rect(9, 9, 61, 61)), gate.observe(root).masks)
            // React Native views never clip children, so the group's own bounds cover nothing outside them.
            container.clipChildren = false
            assertTrue("a child laid out outside the group", masked(gate.observe(root), child, root))
            child.layout(0,0,50,50); child.translationX = 100f
            assertTrue("a child translated outside the group", masked(gate.observe(root), child, root))
            assertFalse("a clipping group confines inner's subtree to inner's bounds",
                gate.observe(root).masks.any { it.contains(VideoMaskBounds.of(deep, root)!!) })
            group.clipChildren = false
            assertTrue("a grandchild drawn outside a non-clipping child", masked(gate.observe(root), deep, root))
            // History covers the same subtree once only it can reach the group.
            root.startViewTransition(container); root.removeView(container)
            try {
                assertEquals(-1, root.indexOfChild(container))
                assertTrue("history covers a retained group's children", masked(gate.observe(root), deep, root))
            } finally { root.endViewTransition(container) }
        } finally { a.finish() }
    }

    @Test fun descendantsOfATransformedMaskedGroupMapThroughItsTransform() {
        val a = Robolectric.buildActivity(Activity::class.java).setup().get()
        val root = FrameLayout(a); a.setContentView(root); root.layout(0,0,400,400)
        root.clipChildren = false
        val group = FrameLayout(a); root.addView(group); group.layout(10,10,60,60)
        group.setTag(R.id.tx_sensitive, true)
        val child = View(a); group.addView(child); child.layout(60,0,160,50)
        group.pivotX = 0f; group.pivotY = 0f; group.scaleX = 2f
        val gate = VideoPrivacyGate({ a }, { 0L }, { true })
        try {
            // The child spans x 60..160 inside the group, so 10 + 2*60 .. 10 + 2*160 in the root.
            assertEquals(setOf(android.graphics.Rect(9, 9, 111, 61), android.graphics.Rect(129, 9, 331, 61)),
                gate.observe(root).masks.toSet())
            group.scrollTo(20, 0)
            assertTrue("the group's scroll moves its children", gate.observe(root).masks.contains(android.graphics.Rect(89, 9, 291, 61)))
        } finally { a.finish() }
    }

    @Test fun unplaceableOrOversizedSubtreeOfNonClippedMaskRefuses() {
        val a = Robolectric.buildActivity(Activity::class.java).setup().get()
        val root = FrameLayout(a); a.setContentView(root); root.layout(0,0,400,400)
        root.clipChildren = false
        val group = FrameLayout(a); root.addView(group); group.layout(10,10,60,60)
        group.setTag(R.id.tx_sensitive, true)
        val child = View(a); group.addView(child); child.layout(0,0,50,50)
        val gate = VideoPrivacyGate({ a }, { 0L }, { true })
        try {
            assertTrue(masked(gate.observe(root), child, root))
            child.startAnimation(android.view.animation.TranslateAnimation(0f, 200f, 0f, 0f).apply { duration = 1000 })
            assertFalse("a descendant animated outside the group", gate.observe(root).allowed)
            child.clearAnimation()
            repeat(2048) { group.addView(View(a)) }
            assertFalse("covering a subtree shares the node budget", gate.observe(root).allowed)
        } finally { a.finish() }
    }

    @Test fun masksAreClippedToTheFrameSoMovementOutsideItKeepsThePrivacyState() {
        val a = Robolectric.buildActivity(Activity::class.java).setup().get()
        val root = FrameLayout(a); a.setContentView(root); root.layout(0,0,100,100)
        val scroller = FrameLayout(a); root.addView(scroller); scroller.layout(0,0,100,100)
        val input = EditText(a); scroller.addView(input); input.layout(0,40,100,60)
        val gate = VideoPrivacyGate({ a }, { 0L }, { true })
        try {
            assertEquals(listOf(android.graphics.Rect(0, 39, 100, 61)), gate.observe(root).masks)
            scroller.scrollTo(0, 100)
            val above = gate.observe(root)
            assertTrue(above.allowed); assertTrue("nothing of the input is inside the frame", above.masks.isEmpty())
            scroller.scrollTo(0, 110)
            assertEquals("moving entirely outside the frame is not a new privacy state", above.epoch, gate.observe(root).epoch)
            scroller.scrollTo(0, 50)
            assertEquals("scrolling back in is", listOf(android.graphics.Rect(0, 0, 100, 11)), gate.observe(root).masks)
        } finally { a.finish() }
    }

    @Test fun removalTransitionChildIsMaskedFromHistoryAlone() {
        val a = Robolectric.buildActivity(Activity::class.java).setup().get()
        val root = FrameLayout(a); a.setContentView(root); root.layout(0,0,100,100)
        val input = EditText(a); root.addView(input); input.layout(10,10,50,30)
        val gate = VideoPrivacyGate({ a }, { 0L }, { true })
        try {
            assertTrue(masked(gate.observe(root), input, root))
            // Still attached and drawn, but no longer reachable through getChildAt.
            root.startViewTransition(input); root.removeView(input)
            try {
                assertTrue(input.isAttachedToWindow); assertSame(root, input.parent); assertEquals(-1, root.indexOfChild(input))
                val retained = gate.observe(root)
                assertTrue(retained.allowed)
                assertEquals(listOf(android.graphics.Rect(9, 9, 51, 31)), retained.masks)
            } finally { root.endViewTransition(input) }
            val clean = gate.observe(root)
            assertTrue(clean.allowed); assertTrue(clean.masks.isEmpty())
        } finally { a.finish() }
    }

    @Test fun scaledAndRotatedMasksCoverTheTransformedBounds() {
        val a = Robolectric.buildActivity(Activity::class.java).setup().get()
        val root = FrameLayout(a); a.setContentView(root); root.layout(0,0,400,400)
        val input = EditText(a); root.addView(input); input.layout(100,100,200,150)
        val gate = VideoPrivacyGate({ a }, { 0L }, { true })
        try {
            input.pivotX = 0f; input.pivotY = 0f; input.scaleX = 2f
            assertEquals(listOf(android.graphics.Rect(99, 99, 301, 151)), gate.observe(root).masks)
            input.scaleX = 1f; input.pivotX = 50f; input.pivotY = 25f; input.rotation = 90f
            // 100x50 turned about its centre (150,125) spans x 125..175 and y 75..175, padded by a pixel.
            val turned = gate.observe(root).masks.single()
            assertTrue("$turned", kotlin.math.abs(turned.left - 124) <= 1 && kotlin.math.abs(turned.top - 74) <= 1 &&
                kotlin.math.abs(turned.right - 176) <= 1 && kotlin.math.abs(turned.bottom - 176) <= 1)
        } finally { a.finish() }
    }

    @Test fun rememberedInputIsMaskedOnLaterFramesUntilDetached() {
        val a = Robolectric.buildActivity(Activity::class.java).setup().get()
        val root = FrameLayout(a); a.setContentView(root); root.layout(0,0,100,100)
        val input = EditText(a); root.addView(input); input.layout(0,0,40,20)
        val gate = VideoPrivacyGate({ a }, { 0L }, { true })
        try {
            repeat(3) { assertTrue("an input seen once must not stop later frames", masked(gate.observe(root), input, root)) }
            root.removeView(input)
            val clean = gate.observe(root)
            assertTrue(clean.allowed); assertTrue(clean.masks.isEmpty())
        } finally { a.finish() }
    }
}
