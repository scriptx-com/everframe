// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import android.content.Intent
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Build
import android.os.SystemClock
import android.text.InputType
import android.view.SurfaceView
import android.view.TextureView
import android.view.View
import android.view.WindowManager
import android.webkit.WebView
import android.widget.EditText
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import dev.everframe.R
import dev.everframe.sensitive.TXSensitiveView
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.lang.ref.WeakReference
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class VideoPrivacyFixtureActivity : ComponentActivity()

/** Runs real PixelCopy and native Views. No encoder receives excluded pixels. */
class VideoPrivacyInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private fun fixture(block: (ActivityScenario<VideoPrivacyFixtureActivity>, VideoPrivacyFixtureActivity, FrameLayout) -> Unit) {
        assumeTrue(Build.VERSION.SDK_INT >= 29)
        val intent = Intent(instrumentation.context, VideoPrivacyFixtureActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ActivityScenario.launch<VideoPrivacyFixtureActivity>(intent).use { scenario ->
            lateinit var activity: VideoPrivacyFixtureActivity
            lateinit var root: FrameLayout
            scenario.onActivity {
                activity = it
                root = FrameLayout(it)
                root.addView(Shapes(it), FrameLayout.LayoutParams(-1,-1))
                it.setContentView(root)
            }
            val deadline = SystemClock.uptimeMillis() + 3000
            var ready = false
            while (!ready && SystemClock.uptimeMillis() < deadline) {
                scenario.onActivity { ready = root.hasWindowFocus() && root.width > 0 }
                if (!ready) SystemClock.sleep(20)
            }
            assertTrue("fixture must have a focused hardware window",ready)
            block(scenario, activity, root)
        }
    }
    private fun capture(activity: VideoPrivacyFixtureActivity): PixelCopyVideoCapture {
        val weak = WeakReference(activity)
        return PixelCopyVideoCapture.forActivity { weak.get() }!!
    }
    private fun waitReleased(diagnostics: () -> String = { "" }, timeoutMs: Long = 3000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val probe = VideoCaptureLease().tryAcquire(VideoOwner("probe","probe"), VideoSize(2,2))
            if (probe != null) { probe.complete(); return }
            SystemClock.sleep(10)
        }
        fail("capture lease was not released: ${diagnostics()}")
    }
    private fun excluded(install: (VideoPrivacyFixtureActivity, FrameLayout) -> Unit) = fixture { scenario, activity, root ->
        scenario.onActivity { install(it,root) }
        val admissions = AtomicInteger()
        val recorder = capture(activity)
        assertTrue(recorder.request(VideoOwner("device","excluded"),VideoSize(480,854)) {
            admissions.incrementAndGet(); it.close()
        })
        waitReleased()
        assertEquals("unsafe pixels reached encoder spy",0,admissions.get())
        recorder.cancel()
    }
    @Test fun markedOverlayAndDisappearingViewsRemainExcluded() {
        excluded { a, root ->
            val child = Shapes(a); root.addView(child)
            dev.everframe.Everframe.markSensitive(child)
            root.overlay.add(child)
            assertTrue("overlay view stays attached", child.isAttachedToWindow)
        }
        excluded { a, root ->
            val child = Shapes(a); root.addView(child)
            dev.everframe.Everframe.markSensitive(child)
            root.startViewTransition(child); root.removeView(child)
            assertTrue("transition view stays attached", child.isAttachedToWindow)
        }
    }
    @Test fun previouslyObservedInputMovedToOverlayRemainsExcluded() = excluded { a, root ->
        val input = EditText(a); root.addView(input)
        assertFalse(VideoPrivacyGate({ a }, { 0L }, { true }).observe(root).allowed)
        root.overlay.add(input)
        assertTrue(input.isAttachedToWindow)
    }
    @Test fun directOverlayInputDocumentsPublicTraversalBoundary() = fixture { scenario, _, root ->
        scenario.onActivity { a ->
            val input = EditText(a)
            input.layout(0, 0, 200, 100)
            root.overlay.add(input)
            val result = VideoPrivacyGate({ a }, { 0L }, { true }).observe(root)
            android.util.Log.i("EverframeOverlayBoundary", "attached=${input.isAttachedToWindow} publicChildren=${root.childCount} allowed=${result.allowed}")
            assertTrue("public overlay fixture must render an attached input", input.isAttachedToWindow)
            root.overlay.remove(input)
        }
    }
    @Test fun nativeTagsIncludingPreAttachmentCustomViewExcludePixels() = excluded { a,r ->
        r.addView(Shapes(a).apply { setTag(R.id.tx_sensitive,true) })
    }
    @Test fun sensitiveContainerExcludesPixels() = excluded { a,r -> r.addView(TXSensitiveView(a)) }
    @Test fun textInputExcludesPixels() = excluded { a,r -> r.addView(EditText(a).apply { setText("private") }) }
    @Test fun passwordInputExcludesPixels() = excluded { a,r ->
        r.addView(EditText(a).apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD; setText("secret") })
    }
    @Test fun secureWindowExcludesPixels() = excluded { a,_ -> a.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE) }
    @Test fun unknownNativeMarkerExcludesPixels() = excluded { a,r -> r.addView(View(a).apply { setTag(R.id.tx_sensitive,"unknown") }) }
    @Test fun movingOffscreenSensitiveChildExcludesPixels() = excluded { a,r ->
        r.addView(Shapes(a).apply {
            setTag(R.id.tx_sensitive,true); translationX = 10000f
            animate().translationX(0f).setDuration(500).start()
        })
    }
    @Test fun webViewExcludesPixels() = excluded { a,r -> r.addView(WebView(a), FrameLayout.LayoutParams(100,100)) }
    @Test fun textureViewExcludesPixels() = excluded { a,r -> r.addView(TextureView(a)) }
    @Test fun surfaceViewExcludesPixels() = excluded { a,r -> r.addView(SurfaceView(a)) }
    @Test fun composePasswordSemanticsFailClosed() = excluded { a,r ->
        r.addView(ComposeView(a).apply { setContent {
            val value = mutableStateOf("private")
            BasicTextField(value.value, { value.value = it }, visualTransformation = PasswordVisualTransformation())
        } })
    }
    @Test fun detachedRootAndGeometryChangeInvalidateObservation() = fixture { scenario, activity, root ->
        scenario.onActivity {
            val gate = VideoPrivacyGate({activity})
            val before = gate.observe(root)
            root.layout(0,0,root.height,root.width)
            val rotated = gate.observe(root)
            assertTrue(before.width != rotated.width || before.height != rotated.height)
            assertNotEquals(before.epoch,rotated.epoch)
            activity.setContentView(FrameLayout(activity))
            assertFalse(gate.observe(root).allowed)
        }
    }
    /** Readiness is outside capture and uses the unchanged production privacy/time budget. */
    private fun awaitNativeReadiness(
        scenario: ActivityScenario<VideoPrivacyFixtureActivity>, native: AndroidVideoCapturePlatform,
    ): String {
        val history = mutableListOf<String>()
        var previous: PrivacyObservation? = null
        var stable = 0
        val deadline = SystemClock.uptimeMillis() + 5000
        repeat(12) {
            if (SystemClock.uptimeMillis() >= deadline) return@repeat
            val committed = CountDownLatch(1)
            var unregister: (() -> Unit)? = null
            scenario.onActivity { activity ->
                val root = activity.window.decorView
                val observer = root.viewTreeObserver
                val callback = Runnable { committed.countDown() }
                observer.registerFrameCommitCallback(callback)
                unregister = { if (observer.isAlive) observer.unregisterFrameCommitCallback(callback); Unit }
                root.invalidate()
            }
            val readyFrame = committed.await(400,TimeUnit.MILLISECONDS)
            scenario.onActivity { activity ->
                unregister?.invoke()
                val start = SystemClock.elapsedRealtimeNanos()
                val current = native.observe()
                val elapsed = SystemClock.elapsedRealtimeNanos() - start
                history.add("commit=$readyFrame allowed=${current.allowed} epoch=${current.epoch} size=${current.width}x${current.height} ns=$elapsed focus=${activity.window.decorView.hasWindowFocus()}")
                val old = previous
                stable = if (readyFrame && current.allowed && old != null && old.allowed &&
                    old.epoch == current.epoch && old.windowIdentity === current.windowIdentity &&
                    old.width == current.width && old.height == current.height) stable + 1 else 0
                previous = current
            }
            if (stable >= 2) return history.joinToString("; ")
        }
        throw AssertionError("native fixture never became ready: ${history.joinToString("; ")}")
    }
    /** Test-only counters contain no pixels or window tokens and retain one observation. */
    private class CaptureDiagnostics(private val native: VideoCapturePlatform) : VideoCapturePlatform by native {
        val observations = AtomicInteger()
        val sawUnsafe = java.util.concurrent.atomic.AtomicBoolean(false)
        val primaryCommits = AtomicInteger()
        val extraTraversals = AtomicInteger()
        val submissions = AtomicInteger()
        val completions = AtomicInteger()
        val copySucceeded = java.util.concurrent.atomic.AtomicBoolean(false)
        val lastObservation = java.util.concurrent.atomic.AtomicReference("none")
        override fun observe(): PrivacyObservation {
            val start = SystemClock.elapsedRealtimeNanos()
            return native.observe().also {
                observations.incrementAndGet()
                if (!it.allowed) sawUnsafe.set(true)
                lastObservation.set("allowed=${it.allowed} epoch=${it.epoch} size=${it.width}x${it.height} ns=${SystemClock.elapsedRealtimeNanos()-start}")
            }
        }
        override fun commit(callback: () -> Unit): () -> Unit = native.commit {
            primaryCommits.incrementAndGet(); callback()
        }
        override fun watch(onPreDraw: () -> Unit, onExtraCommit: () -> Unit): () -> Unit = native.watch(onPreDraw) {
            extraTraversals.incrementAndGet(); onExtraCommit()
        }
        override fun copy(bitmap: android.graphics.Bitmap, callback: (Boolean) -> Unit) {
            submissions.incrementAndGet()
            native.copy(bitmap) { result ->
                copySucceeded.set(result); completions.incrementAndGet(); callback(result)
            }
        }
        fun summary() = "observations=${observations.get()} last=${lastObservation.get()} primary=${primaryCommits.get()} extra=${extraTraversals.get()} submissions=${submissions.get()} completions=${completions.get()} copySuccess=${copySucceeded.get()}"
    }
    @Test fun sensitiveAppearsAndDisappearsBeforeHeldNativeCallbackNeverAdmits() = fixture { scenario, activity, root ->
        val native = AndroidVideoCapturePlatform({ activity })
        val readiness = awaitNativeReadiness(scenario,native)
        val copied = CountDownLatch(1)
        val held = java.util.concurrent.atomic.AtomicReference<(() -> Unit)?>()
        val success = java.util.concurrent.atomic.AtomicBoolean(false)
        val diagnostics = CaptureDiagnostics(native)
        val platform = object : VideoCapturePlatform by diagnostics {
            override fun copy(bitmap: android.graphics.Bitmap, callback: (Boolean) -> Unit) {
                diagnostics.copy(bitmap) { result -> success.set(result); held.set { callback(result) }; copied.countDown() }
            }
        }
        val admissions = AtomicInteger()
        val recorder = PixelCopyVideoCapture(platform, AndroidVideoCaptureScheduler)
        try {
            assertTrue(recorder.request(VideoOwner("device","held"),VideoSize(480,854)) {
                admissions.incrementAndGet(); it.close()
            })
            val received = copied.await(3,TimeUnit.SECONDS)
            assertTrue("setup never reached native callback: ${diagnostics.summary()}; readiness=$readiness",received)
            assertTrue("native PixelCopy failed before the sensitive transition",success.get())
            assertEquals("fixture encountered an extra traversal before installing sensitivity",0,diagnostics.extraTraversals.get())
            assertFalse("fixture was already unsafe before installing sensitivity",diagnostics.sawUnsafe.get())
            lateinit var child: View
            val drawn = CountDownLatch(1)
            scenario.onActivity {
                child = View(it).apply { setTag(R.id.tx_sensitive,true) }
                root.addView(child)
                val observer = root.viewTreeObserver
                lateinit var listener: android.view.ViewTreeObserver.OnPreDrawListener
                listener = android.view.ViewTreeObserver.OnPreDrawListener {
                    observer.removeOnPreDrawListener(listener); drawn.countDown(); true
                }
                observer.addOnPreDrawListener(listener); root.invalidate()
            }
            assertTrue("sensitive child never reached a pre-draw",drawn.await(3,TimeUnit.SECONDS))
            assertTrue("capture did not observe the sensitive pre-draw (it may have timed out)",diagnostics.sawUnsafe.get())
            scenario.onActivity { root.removeView(child) }
            held.getAndSet(null)!!.invoke()
            waitReleased(); assertEquals(0,admissions.get())
        } finally {
            recorder.cancel()
            held.getAndSet(null)?.invoke()
        }
    }
    @Test fun actualSizeRotationAdvancesPrivacyEpoch() = fixture { scenario, activity, root ->
        val gate = VideoPrivacyGate({ activity })
        lateinit var before: PrivacyObservation
        scenario.onActivity {
            before = gate.observe(it.window.decorView)
            it.requestedOrientation = if (root.width < root.height)
                android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
                else android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        }
        var changed = false
        val deadline = SystemClock.uptimeMillis() + 3000
        while (!changed && SystemClock.uptimeMillis() < deadline) {
            scenario.onActivity {
                val after = gate.observe(it.window.decorView)
                changed = after.width != before.width || after.height != before.height
                if (changed) assertNotEquals(before.epoch,after.epoch)
            }
            if (!changed) SystemClock.sleep(20)
        }
        assertTrue("fixture window did not rotate",changed)
    }
    @Test fun hiddenWebViewAppearingBeforeCopyCallbackInvalidatesFrame() = fixture { scenario, activity, root ->
        lateinit var container: FrameLayout
        scenario.onActivity {
            container = FrameLayout(it).apply { alpha = 0f }
            container.addView(WebView(it), FrameLayout.LayoutParams(100,100))
            root.addView(container, FrameLayout.LayoutParams(100,100))
        }
        val native = AndroidVideoCapturePlatform({ activity })
        val readiness = awaitNativeReadiness(scenario,native)
        val diagnostics = CaptureDiagnostics(native)
        val copied = CountDownLatch(1)
        val held = java.util.concurrent.atomic.AtomicReference<(() -> Unit)?>()
        val platform = object : VideoCapturePlatform by diagnostics {
            override fun copy(bitmap: android.graphics.Bitmap, callback: (Boolean) -> Unit) {
                diagnostics.copy(bitmap) { result -> held.set { callback(result) }; copied.countDown() }
            }
        }
        val admissions = AtomicInteger()
        val recorder = PixelCopyVideoCapture(platform, AndroidVideoCaptureScheduler)
        try {
            assertTrue(recorder.request(VideoOwner("device","webview-transition"),VideoSize(480,854)) {
                admissions.incrementAndGet(); it.close()
            })
            assertTrue("hidden WebView prevented native copy: ${diagnostics.summary()}; $readiness", copied.await(3,TimeUnit.SECONDS))
            assertTrue(diagnostics.copySucceeded.get())
            val drawn = CountDownLatch(1)
            scenario.onActivity {
                container.alpha = 1f
                val observer = root.viewTreeObserver
                lateinit var listener: android.view.ViewTreeObserver.OnPreDrawListener
                listener = android.view.ViewTreeObserver.OnPreDrawListener {
                    observer.removeOnPreDrawListener(listener); drawn.countDown(); true
                }
                observer.addOnPreDrawListener(listener); root.invalidate()
            }
            assertTrue(drawn.await(3,TimeUnit.SECONDS))
            assertTrue("visible WebView must revoke pending frame",diagnostics.sawUnsafe.get())
            scenario.onActivity { container.alpha = 0f }
            held.getAndSet(null)!!.invoke()
            waitReleased()
            assertEquals("hiding again cannot revive an invalidated frame",0,admissions.get())
            awaitNativeReadiness(scenario,native)
        } finally { recorder.cancel(); held.getAndSet(null)?.invoke() }
    }
    @Test fun cleanCanvasProducesExpectedNonblankShapesAndText() = assertCleanCanvas { _, _ -> }

    @Test fun invisibleSpeedTestWebViewStillProducesExpectedNonblankShapesAndText() = assertCleanCanvas { activity, root ->
        val background = FrameLayout(activity).apply { alpha = 0f }
        background.addView(WebView(activity), FrameLayout.LayoutParams(-1,-1))
        root.addView(background, FrameLayout.LayoutParams(3,3).apply { leftMargin = -3; topMargin = -3 })
    }

    private fun assertCleanCanvas(install: (VideoPrivacyFixtureActivity, FrameLayout) -> Unit) = fixture { scenario, activity, root ->
        scenario.onActivity { install(it,root) }
        val native = AndroidVideoCapturePlatform({ activity })
        val readiness = awaitNativeReadiness(scenario,native)
        val diagnostics = CaptureDiagnostics(native)
        val recorder = PixelCopyVideoCapture(diagnostics, AndroidVideoCaptureScheduler)
        val attempts = mutableListOf<String>()
        val colors = IntArray(4)
        val entered = java.util.concurrent.atomic.AtomicBoolean(false)
        val done = CountDownLatch(1)
        val workerFailure = java.util.concurrent.atomic.AtomicReference<Throwable?>()
        val deadline = SystemClock.uptimeMillis() + 6000
        try {
            for (attempt in 1..6) {
                if (SystemClock.uptimeMillis() >= deadline) break
                val started = SystemClock.uptimeMillis()
                assertTrue("clean attempt $attempt could not reserve released lease: ${diagnostics.summary()}",
                    recorder.request(VideoOwner("device","clean-$attempt"),VideoSize(480,854)) { frame ->
                        entered.set(true)
                        try {
                            assertTrue("accepted clean frame lost authorization",frame.withPixels { bitmap ->
                                val pixels = IntArray(bitmap.width * bitmap.height)
                                bitmap.getPixels(pixels,0,bitmap.width,0,0,bitmap.width,bitmap.height)
                                for (pixel in pixels) when (pixel) {
                                    Color.RED -> colors[0]++
                                    Color.BLUE -> colors[1]++
                                    Color.WHITE -> colors[2]++
                                    Color.BLACK -> colors[3]++
                                }
                            })
                        } catch (failure: Throwable) { workerFailure.set(failure) }
                        finally { frame.close(); done.countDown() }
                    })
                // Native ownership must finish, including late callbacks, before any retry.
                // Quarantine or a stuck worker fails here; neither is bypassed by a new attempt.
                waitReleased({ "attempt=$attempt ${diagnostics.summary()}; readiness=$readiness" },
                    (deadline-SystemClock.uptimeMillis()).coerceIn(1,2500))
                attempts.add("attempt=$attempt ${diagnostics.summary()}")
                if (entered.get()) {
                    assertTrue("accepted worker did not finish",done.await(250,TimeUnit.MILLISECONDS))
                    workerFailure.get()?.let { throw AssertionError("clean worker failed",it) }
                    break
                }
                // At most 5 fps. Only missing admission is retried, never pixel assertions.
                val pause = (200-(SystemClock.uptimeMillis()-started)).coerceAtLeast(0)
                if (pause > 0) SystemClock.sleep(pause)
            }
            assertTrue("no clean native frame after bounded attempts: ${attempts.joinToString("; ")}; readiness=$readiness",entered.get())
            assertTrue("red rectangle missing", colors[0] > 100)
            assertTrue("blue circle missing", colors[1] > 100)
            assertTrue("white canvas missing", colors[2] > 100)
            assertTrue("black text missing", colors[3] > 20)
        } finally { recorder.cancel() }
    }
    private class Shapes(context: android.content.Context) : View(context) {
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        override fun onDraw(canvas: Canvas) {
            canvas.drawColor(Color.WHITE)
            paint.color = Color.RED; canvas.drawRect(width*.1f,height*.1f,width*.4f,height*.4f,paint)
            paint.color = Color.BLUE; canvas.drawCircle(width*.7f,height*.3f,width*.12f,paint)
            paint.color = Color.BLACK; paint.textSize = 48f; canvas.drawText("SAFE NATIVE",30f,height*.7f,paint)
        }
    }
}
