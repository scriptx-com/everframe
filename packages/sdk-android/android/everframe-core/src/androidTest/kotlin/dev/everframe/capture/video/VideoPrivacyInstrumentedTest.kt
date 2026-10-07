// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import android.animation.LayoutTransition
import android.animation.ValueAnimator
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.SurfaceTexture
import android.os.Build
import android.os.SystemClock
import android.text.InputType
import android.view.Gravity
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.TextureView
import android.view.View
import android.view.WindowManager
import android.view.animation.TranslateAnimation
import android.webkit.WebView
import android.widget.EditText
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
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

/** Runs real PixelCopy and native Views. No encoder receives refused frames or unmasked sensitive pixels. */
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
    private fun refused(install: (VideoPrivacyFixtureActivity, FrameLayout) -> Unit) = fixture { scenario, activity, root ->
        scenario.onActivity { install(it,root) }
        val admissions = AtomicInteger()
        val recorder = capture(activity)
        assertTrue(recorder.request(VideoOwner("device","refused"),VideoSize(480,854)) {
            admissions.incrementAndGet(); it.close()
        })
        waitReleased()
        assertEquals("unsafe pixels reached encoder spy",0,admissions.get())
        recorder.cancel()
    }
    /** Sensitive fixtures draw this; it never appears in the base Shapes canvas. */
    private val secret = Color.MAGENTA
    // Matches magenta also where scaling or a fade blends it with white.
    private fun isSecret(pixel: Int) = Color.red(pixel) > 150 && Color.blue(pixel) > 150 &&
        Color.green(pixel) < minOf(Color.red(pixel), Color.blue(pixel)) - 60
    private fun swatch(context: android.content.Context) = View(context).apply { setBackgroundColor(secret) }
    /** Bottom-left, clear of the base Shapes' red rectangle, blue circle and text. */
    private fun bottomLeft() = FrameLayout.LayoutParams(400, 200, Gravity.BOTTOM or Gravity.START)

    /** Runs [inspect] on the worker with the first admitted frame, within bounded attempts at most 5 fps. */
    private fun firstAdmittedFrame(
        scenario: ActivityScenario<VideoPrivacyFixtureActivity>, activity: VideoPrivacyFixtureActivity, inspect: (Bitmap) -> Unit,
    ) {
        val native = AndroidVideoCapturePlatform({ activity })
        val readiness = awaitNativeReadiness(scenario,native)
        val diagnostics = CaptureDiagnostics(native)
        val recorder = PixelCopyVideoCapture(diagnostics, AndroidVideoCaptureScheduler)
        val attempts = mutableListOf<String>()
        val entered = java.util.concurrent.atomic.AtomicBoolean(false)
        val done = CountDownLatch(1)
        val workerFailure = java.util.concurrent.atomic.AtomicReference<Throwable?>()
        val deadline = SystemClock.uptimeMillis() + 6000
        try {
            for (attempt in 1..6) {
                if (SystemClock.uptimeMillis() >= deadline) break
                val started = SystemClock.uptimeMillis()
                assertTrue("attempt $attempt could not reserve released lease: ${diagnostics.summary()}",
                    recorder.request(VideoOwner("device","admitted-$attempt"),VideoSize(480,854)) { frame ->
                        entered.set(true)
                        try { assertTrue("admitted frame lost authorization", frame.withPixels(inspect)) }
                        catch (failure: Throwable) { workerFailure.set(failure) }
                        finally { frame.close(); done.countDown() }
                    })
                waitReleased({ "attempt=$attempt ${diagnostics.summary()}; readiness=$readiness" },
                    (deadline-SystemClock.uptimeMillis()).coerceIn(1,2500))
                attempts.add("attempt=$attempt ${diagnostics.summary()}")
                if (entered.get()) {
                    assertTrue("admitted worker did not finish",done.await(250,TimeUnit.MILLISECONDS))
                    workerFailure.get()?.let { throw AssertionError("admitted frame check failed",it) }
                    return
                }
                val pause = (200-(SystemClock.uptimeMillis()-started)).coerceAtLeast(0)
                if (pause > 0) SystemClock.sleep(pause)
            }
            fail("no admitted native frame after bounded attempts: ${attempts.joinToString("; ")}; readiness=$readiness")
        } finally { recorder.cancel() }
    }

    /**
     * The frame is recorded with the sensitive view painted black: no admitted pixel shows
     * [secret], its window region is black in the downscaled frame, and the base Shapes
     * elsewhere are still recorded.
     */
    private fun masked(ready: () -> Unit = {}, install: (VideoPrivacyFixtureActivity, FrameLayout) -> View) = fixture { scenario, activity, root ->
        lateinit var sensitive: View
        scenario.onActivity {
            // A software keyboard would pan the window, which refuses masked frames.
            it.window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN or
                WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
            sensitive = install(it,root)
        }
        ready()
        assertMaskedFrame(scenario, activity, sensitive)
    }

    /** The first admitted frame shows no [secret], is black over [sensitive], and still shows the base Shapes. */
    private fun assertMaskedFrame(
        scenario: ActivityScenario<VideoPrivacyFixtureActivity>, activity: VideoPrivacyFixtureActivity, sensitive: View,
    ) {
        val region = Rect()
        var window = 0 to 0
        val laidOut = SystemClock.uptimeMillis() + 3000
        while (region.isEmpty && SystemClock.uptimeMillis() < laidOut) {
            scenario.onActivity {
                val origin = IntArray(2).also { sensitive.getLocationInWindow(it) }
                region.set(origin[0], origin[1], origin[0] + sensitive.width, origin[1] + sensitive.height)
                window = it.window.decorView.width to it.window.decorView.height
            }
            if (region.isEmpty) SystemClock.sleep(20)
        }
        assertFalse("sensitive fixture must be laid out", region.isEmpty)
        val counts = IntArray(4)
        firstAdmittedFrame(scenario, activity) { bitmap ->
            val pixels = IntArray(bitmap.width * bitmap.height)
            bitmap.getPixels(pixels,0,bitmap.width,0,0,bitmap.width,bitmap.height)
            for (pixel in pixels) {
                if (isSecret(pixel)) counts[0]++
                if (pixel == Color.RED) counts[1]++
                if (pixel == Color.BLUE) counts[2]++
            }
            // Masks are padded and rounded outwards, so the scaled interior is black throughout.
            val sx = bitmap.width.toFloat() / window.first
            val sy = bitmap.height.toFloat() / window.second
            for (y in kotlin.math.ceil(region.top * sy).toInt() + 1 until kotlin.math.floor(region.bottom * sy).toInt() - 1) {
                for (x in kotlin.math.ceil(region.left * sx).toInt() + 1 until kotlin.math.floor(region.right * sx).toInt() - 1) {
                    if (x in 0 until bitmap.width && y in 0 until bitmap.height && bitmap.getPixel(x, y) != Color.BLACK) counts[3]++
                }
            }
        }
        assertEquals("sensitive pixels reached the encoder", 0, counts[0])
        assertEquals("sensitive region is not black", 0, counts[3])
        assertTrue("red rectangle elsewhere missing", counts[1] > 100)
        assertTrue("blue circle elsewhere missing", counts[2] > 100)
    }

    /**
     * Requests frames at about 5 fps for [durationMs]; fails if an admitted frame shows [secret].
     * With [settledAtMs], a frame requested after that point must also be admitted and show the
     * base Shapes, so a capture that refuses everything cannot pass.
     */
    private fun neverShowsSecret(activity: VideoPrivacyFixtureActivity, durationMs: Long, settledAtMs: Long?) {
        val recorder = capture(activity)
        val admitted = AtomicInteger()
        val settled = AtomicInteger()
        val leaked = AtomicInteger()
        val began = SystemClock.uptimeMillis()
        val deadline = began + durationMs
        var attempt = 0
        var accepted = 0
        try {
            while (SystemClock.uptimeMillis() < deadline) {
                val started = SystemClock.uptimeMillis()
                val afterSettling = settledAtMs != null && started - began >= settledAtMs
                attempt++
                val requested = recorder.request(VideoOwner("device","watch-$attempt"),VideoSize(480,854)) { frame ->
                    try {
                        frame.withPixels { bitmap ->
                            admitted.incrementAndGet()
                            val pixels = IntArray(bitmap.width * bitmap.height)
                            bitmap.getPixels(pixels,0,bitmap.width,0,0,bitmap.width,bitmap.height)
                            if (pixels.any { isSecret(it) }) leaked.incrementAndGet()
                            if (afterSettling && pixels.count { it == Color.RED } > 100 && pixels.count { it == Color.BLUE } > 100) {
                                settled.incrementAndGet()
                            }
                        }
                    } finally { frame.close() }
                }
                if (requested) { accepted++; waitReleased({ "attempt=$attempt" }) }
                val pause = (200-(SystemClock.uptimeMillis()-started)).coerceAtLeast(0)
                if (pause > 0) SystemClock.sleep(pause)
            }
        } finally { recorder.cancel() }
        assertEquals("sensitive pixels reached the encoder in ${admitted.get()} admitted frames", 0, leaked.get())
        assertTrue("no frame request was accepted in $attempt attempts", accepted > 0)
        if (settledAtMs != null) {
            assertTrue("no admitted frame showed the base Shapes after $settledAtMs ms (${admitted.get()} admitted)", settled.get() > 0)
        }
    }
    @Test fun markedOverlayViewRemainsExcluded() = refused { a, root ->
        val child = Shapes(a); root.addView(child)
        dev.everframe.Everframe.markSensitive(child)
        root.overlay.add(child)
        assertTrue("overlay view stays attached", child.isAttachedToWindow)
    }
    @Test fun markedRemovalTransitionViewIsMaskedFromHistory() = masked { a, root ->
        val child = swatch(a); root.addView(child, bottomLeft())
        dev.everframe.Everframe.markSensitive(child)
        // Removed before any traversal lays it out: give the retained view its drawn bounds.
        child.layout(0, root.height - 200, 400, root.height)
        root.startViewTransition(child); root.removeView(child)
        assertTrue("transition view stays attached", child.isAttachedToWindow)
        assertEquals(-1, root.indexOfChild(child))
        child
    }
    @Test fun previouslyObservedInputMovedToOverlayRemainsExcluded() = refused { a, root ->
        val input = EditText(a); root.addView(input)
        val seen = VideoPrivacyGate({ a }, { 0L }, { true }).observe(root)
        assertTrue("an input in the tree is masked, not refused", seen.allowed && seen.masks.isNotEmpty())
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
    @Test fun nativeTagsIncludingPreAttachmentCustomViewMaskPixels() = masked { a,r ->
        swatch(a).apply { setTag(R.id.tx_sensitive,true) }.also { r.addView(it, bottomLeft()) }
    }
    @Test fun sensitiveContainerMasksPixels() = masked { a,r ->
        TXSensitiveView(a).apply { setBackgroundColor(secret) }.also { r.addView(it, bottomLeft()) }
    }
    @Test fun textInputMasksPixels() = masked { a,r ->
        EditText(a).apply { setBackgroundColor(secret); setTextColor(secret); setText("private") }.also { r.addView(it, bottomLeft()) }
    }
    @Test fun passwordInputMasksPixels() = masked { a,r ->
        EditText(a).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            setBackgroundColor(secret); setTextColor(secret); setText("secret")
        }.also { r.addView(it, bottomLeft()) }
    }
    @Test fun secureWindowExcludesPixels() = refused { a,_ -> a.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE) }
    @Test fun unknownNativeMarkerMasksPixels() = masked { a,r ->
        swatch(a).apply { setTag(R.id.tx_sensitive,"unknown") }.also { r.addView(it, bottomLeft()) }
    }
    @Test fun sensitiveChildSlidingOnScreenIsNeverRecordedUnmasked() = fixture { scenario, activity, root ->
        // With animations off the slide ends at once and there is nothing to catch.
        assumeTrue("animator duration scale is 0", ValueAnimator.areAnimatorsEnabled())
        scenario.onActivity { a ->
            root.addView(swatch(a).apply {
                setTag(R.id.tx_sensitive,true); translationX = 10000f
                animate().translationX(0f).setDuration(500).start()
            }, bottomLeft())
        }
        // Once the 500 ms slide ends the swatch is masked in place and frames are recorded.
        neverShowsSecret(activity, 2000, settledAtMs = 800)
    }
    @Test fun tweenOnAncestorOfMaskedViewIsNeverRecordedUnmasked() = fixture { scenario, activity, root ->
        scenario.onActivity { a ->
            val holder = FrameLayout(a)
            holder.addView(swatch(a).apply { setTag(R.id.tx_sensitive,true) }, FrameLayout.LayoutParams(400, 200))
            root.addView(holder, bottomLeft())
            // Applied while drawing, so the view's layout and getMatrix() never move.
            holder.startAnimation(TranslateAnimation(0f, 300f, 0f, 0f).apply { duration = 1000 })
        }
        // Without fillAfter the 1 s tween is cleared when it ends, and the swatch is masked in place.
        neverShowsSecret(activity, 2500, settledAtMs = 1300)
    }
    @Test fun layoutTransitionFadingOutMaskedViewIsNeverRecordedUnmasked() = fixture { scenario, activity, root ->
        assumeTrue("animator duration scale is 0", ValueAnimator.areAnimatorsEnabled())
        lateinit var container: FrameLayout
        lateinit var row: View
        scenario.onActivity { a ->
            container = FrameLayout(a).apply { layoutTransition = LayoutTransition() }
            row = swatch(a).apply { setTag(R.id.tx_sensitive,true) }
            container.addView(row, FrameLayout.LayoutParams(400, 200))
            root.addView(container, bottomLeft())
        }
        SystemClock.sleep(800) // Let the appearing transition finish.
        // GONE under a running layout transition still fades out on screen.
        scenario.onActivity {
            row.visibility = View.GONE
            assertTrue("the fixture must fade the row out", container.layoutTransition.isRunning)
        }
        // After the 300 ms fade the row is hidden and frames are recorded.
        neverShowsSecret(activity, 1800, settledAtMs = 700)
    }
    @Test fun transparentContainerRedrawnFromTheOverlayIsNeverRecorded() = fixture { scenario, activity, root ->
        lateinit var holder: FrameLayout
        lateinit var input: EditText
        lateinit var redraw: android.graphics.drawable.Drawable
        val redraws = AtomicInteger()
        scenario.onActivity { a ->
            a.window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN or
                WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
            holder = FrameLayout(a)
            input = EditText(a).apply { setBackgroundColor(secret); setTextColor(secret); setText("draft") }
            holder.addView(input, FrameLayout.LayoutParams(400, 200))
            root.addView(holder, bottomLeft())
            // How a container transform works: the container turns transparent while an overlay
            // drawable draws it, input included, somewhere else (here the top-left corner).
            redraw = object : android.graphics.drawable.Drawable() {
                override fun draw(canvas: Canvas) { redraws.incrementAndGet(); holder.draw(canvas) }
                override fun setAlpha(alpha: Int) = Unit
                override fun setColorFilter(colorFilter: android.graphics.ColorFilter?) = Unit
                @Deprecated("Deprecated in Java")
                override fun getOpacity() = android.graphics.PixelFormat.TRANSLUCENT
            }
            redraw.setBounds(0, 0, 400, 200)
            holder.alpha = 0f
            root.overlay.add(redraw)
        }
        neverShowsSecret(activity, 1000, settledAtMs = null)
        assertTrue("the overlay never drew the container", redraws.get() > 0)
        // Positive control: once the transform ends the input is drawn in place and masked.
        scenario.onActivity { root.overlay.remove(redraw); holder.alpha = 1f }
        assertMaskedFrame(scenario, activity, input)
    }
    @Test fun goneTransparentContainerRedrawnFromTheOverlayIsNeverRecorded() = fixture { scenario, activity, root ->
        lateinit var holder: FrameLayout
        lateinit var input: EditText
        lateinit var redraw: android.graphics.drawable.Drawable
        val redraws = AtomicInteger()
        scenario.onActivity { a ->
            a.window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN or
                WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
            holder = FrameLayout(a)
            input = EditText(a).apply { setBackgroundColor(secret); setTextColor(secret); setText("draft") }
            holder.addView(input, FrameLayout.LayoutParams(400, 200))
            root.addView(holder, bottomLeft())
        }
        // The container is laid out before it closes, and a GONE child keeps those bounds.
        var laidOut = false
        val layoutDeadline = SystemClock.uptimeMillis() + 3000
        while (!laidOut && SystemClock.uptimeMillis() < layoutDeadline) {
            scenario.onActivity { laidOut = holder.isLaidOut && input.width > 0 }
            if (!laidOut) SystemClock.sleep(20)
        }
        assertTrue("the container must be laid out before it closes", laidOut)
        scenario.onActivity {
            // Material's reverse container transform: the app sets the container it closes GONE,
            // and the transform sets it to alpha 0 and draws it from an overlay drawable (here in
            // the top-left corner) through View.draw, which never checks visibility.
            redraw = object : android.graphics.drawable.Drawable() {
                override fun draw(canvas: Canvas) { redraws.incrementAndGet(); holder.draw(canvas) }
                override fun setAlpha(alpha: Int) = Unit
                override fun setColorFilter(colorFilter: android.graphics.ColorFilter?) = Unit
                @Deprecated("Deprecated in Java")
                override fun getOpacity() = android.graphics.PixelFormat.TRANSLUCENT
            }
            redraw.setBounds(0, 0, 400, 200)
            holder.visibility = View.GONE
            holder.alpha = 0f
            root.overlay.add(redraw)
        }
        var onScreen = false
        val drawDeadline = SystemClock.uptimeMillis() + 3000
        while (!onScreen && SystemClock.uptimeMillis() < drawDeadline) {
            onScreen = windowShowsSecret(scenario)
            if (!onScreen) SystemClock.sleep(50)
        }
        assertTrue("the overlay never drew the GONE container's input on screen", onScreen)
        neverShowsSecret(activity, 1000, settledAtMs = null)
        assertTrue("the overlay never drew the container", redraws.get() > 0)
        // Positive controls: once the transform ends and restores alpha, nothing draws the GONE
        // container and frames are recorded; shown again, its input is masked in place.
        scenario.onActivity { root.overlay.remove(redraw); holder.alpha = 1f }
        neverShowsSecret(activity, 1500, settledAtMs = 0)
        scenario.onActivity { holder.visibility = View.VISIBLE }
        assertMaskedFrame(scenario, activity, input)
    }
    /** Whether a direct copy of the window, outside capture, shows [secret]: proves a fixture draws it on screen. */
    private fun windowShowsSecret(scenario: ActivityScenario<VideoPrivacyFixtureActivity>): Boolean {
        val copied = CountDownLatch(1)
        val result = AtomicInteger(-1)
        lateinit var bitmap: Bitmap
        scenario.onActivity { a ->
            bitmap = Bitmap.createBitmap(a.window.decorView.width, a.window.decorView.height, Bitmap.Config.ARGB_8888)
            android.view.PixelCopy.request(a.window, bitmap, { result.set(it); copied.countDown() },
                android.os.Handler(android.os.Looper.getMainLooper()))
        }
        assertTrue("window copy timed out", copied.await(3, TimeUnit.SECONDS))
        assertEquals("window copy failed", android.view.PixelCopy.SUCCESS, result.get())
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels,0,bitmap.width,0,0,bitmap.width,bitmap.height)
        bitmap.recycle()
        return pixels.any { isSecret(it) }
    }
    @Test fun keyboardPannedWindowNeverRecordsTheFocusedFieldUnmasked() = fixture { scenario, activity, root ->
        lateinit var input: EditText
        scenario.onActivity { a ->
            a.window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_PAN)
            input = EditText(a).apply { setBackgroundColor(secret); setTextColor(secret); setText("4111 1111 1111 1111") }
            root.addView(input, FrameLayout.LayoutParams(-1, 200, Gravity.BOTTOM))
        }
        scenario.onActivity { a ->
            input.requestFocus()
            WindowCompat.getInsetsController(a.window, input).show(WindowInsetsCompat.Type.ime())
        }
        var panned = false
        val deadline = SystemClock.uptimeMillis() + 3000
        while (!panned && SystemClock.uptimeMillis() < deadline) {
            scenario.onActivity { a ->
                val origin = IntArray(2).also { a.window.decorView.getLocationInWindow(it) }
                panned = origin[1] != 0
            }
            if (!panned) SystemClock.sleep(50)
        }
        assumeTrue("no software keyboard panned the window", panned)
        try { neverShowsSecret(activity, 1000, settledAtMs = null) }
        finally { scenario.onActivity { a -> WindowCompat.getInsetsController(a.window, input).hide(WindowInsetsCompat.Type.ime()) } }
        // Positive control: without the keyboard the window is drawn unshifted and the field is masked in place.
        var restored = false
        val unpanned = SystemClock.uptimeMillis() + 3000
        while (!restored && SystemClock.uptimeMillis() < unpanned) {
            scenario.onActivity { a ->
                val origin = IntArray(2).also { a.window.decorView.getLocationInWindow(it) }
                restored = origin[1] == 0
            }
            if (!restored) SystemClock.sleep(50)
        }
        assertTrue("the window stayed panned after the keyboard was hidden", restored)
        assertMaskedFrame(scenario, activity, input)
    }
    @Test fun webViewExcludesPixels() = refused { a,r -> r.addView(WebView(a), FrameLayout.LayoutParams(100,100)) }
    @Test fun textureViewMasksPixels() {
        val drawn = CountDownLatch(1)
        masked({ assertTrue("texture never drawn", drawn.await(3, TimeUnit.SECONDS)) }) { a,r ->
            TextureView(a).apply {
                surfaceTextureListener = object : TextureView.SurfaceTextureListener {
                    override fun onSurfaceTextureAvailable(texture: SurfaceTexture, width: Int, height: Int) {
                        lockCanvas()?.let { it.drawColor(secret); unlockCanvasAndPost(it); drawn.countDown() }
                    }
                    override fun onSurfaceTextureSizeChanged(texture: SurfaceTexture, width: Int, height: Int) = Unit
                    override fun onSurfaceTextureDestroyed(texture: SurfaceTexture) = true
                    override fun onSurfaceTextureUpdated(texture: SurfaceTexture) = Unit
                }
            }.also { r.addView(it, bottomLeft()) }
        }
    }
    @Test fun surfaceViewContentIsAbsentButViewsAboveItAreRecorded() = fixture { scenario, activity, root ->
        val drawn = CountDownLatch(1)
        scenario.onActivity { a ->
            val surface = SurfaceView(a)
            surface.holder.addCallback(object : SurfaceHolder.Callback {
                override fun surfaceCreated(holder: SurfaceHolder) {
                    holder.lockCanvas()?.let { it.drawColor(secret); holder.unlockCanvasAndPost(it); drawn.countDown() }
                }
                override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) = Unit
                override fun surfaceDestroyed(holder: SurfaceHolder) = Unit
            })
            root.addView(surface, bottomLeft())
            // Subtitles or player controls drawn above the video live in the window itself.
            root.addView(View(a).apply { setBackgroundColor(Color.CYAN) }, FrameLayout.LayoutParams(100, 50, Gravity.BOTTOM or Gravity.START))
        }
        assertTrue("surface never drawn", drawn.await(3, TimeUnit.SECONDS))
        val counts = IntArray(2)
        firstAdmittedFrame(scenario, activity) { bitmap ->
            val pixels = IntArray(bitmap.width * bitmap.height)
            bitmap.getPixels(pixels,0,bitmap.width,0,0,bitmap.width,bitmap.height)
            for (pixel in pixels) {
                if (isSecret(pixel)) counts[0]++
                if (pixel == Color.CYAN) counts[1]++
            }
        }
        assertEquals("SurfaceView content is never part of a window copy", 0, counts[0])
        assertTrue("a view drawn above the surface is recorded", counts[1] > 20)
    }
    @Test fun composePasswordSemanticsFailClosed() = refused { a,r ->
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
        // A refusal or a mask: the frame needed privacy handling.
        val sawSensitive = java.util.concurrent.atomic.AtomicBoolean(false)
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
                if (!it.allowed || it.masks.isNotEmpty()) sawSensitive.set(true)
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
            assertFalse("fixture was already sensitive before installing sensitivity",diagnostics.sawSensitive.get())
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
            assertTrue("capture did not observe the sensitive pre-draw (it may have timed out)",diagnostics.sawSensitive.get())
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
            assertTrue("visible WebView must revoke pending frame",diagnostics.sawSensitive.get())
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
