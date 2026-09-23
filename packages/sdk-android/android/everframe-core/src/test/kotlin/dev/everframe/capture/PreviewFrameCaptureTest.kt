// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Task 11b — Robolectric unit tests for `ScreenshotCapture.capturePreviewFrame`.
//
// Unlike `CompanionSubmissionComposerTest`'s comment ("Real Bitmap drawing
// (PixelCopy needs a real Activity surface)"), Robolectric 4.13 ships a real
// `ShadowPixelCopy` (org.robolectric.shadows.ShadowPixelCopy) that draws the
// target View onto the destination bitmap via a software Canvas and — when
// the completion Handler's Looper IS the main Looper, which
// `ScreenshotCapture`'s own `Handler(Looper.getMainLooper())` always is —
// invokes the finished-listener SYNCHRONOUSLY inside `PixelCopy.request(...)`
// itself, rather than posting. That means `capturePreviewFrame`'s
// `suspendCancellableCoroutine` resumes before `PixelCopy.request` returns,
// so a plain `runBlocking { ... }` on the test thread completes without ever
// needing to pump the Robolectric main-looper queue.
package dev.everframe.capture

import android.app.Activity
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Rect
import android.widget.FrameLayout
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
// REQUIRED for any assertion about pixel VALUES, not just bitmap dimensions.
// Robolectric's default (LEGACY) graphics mode does not rasterize — Canvas
// draw calls are no-ops and every `PixelCopy` destination comes back
// uniformly black. The masking test written in Task 11b sampled a pixel
// inside the sensitive rect, found it black, and passed — on a frame where
// EVERY pixel was black and nothing had been captured at all. That is the
// "no negative control" finding from the Task 11b review turning out to be
// live rather than theoretical: the privacy assertion this suite exists for
// was vacuous. NATIVE mode rasterizes through real Skia, so white content
// reads back white and a baked rect reads back black for the right reason.
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PreviewFrameCaptureTest {

    /** A laid-out Activity with a real, non-zero-size decorView content. */
    private fun laidOutActivity(width: Int = 1200, height: Int = 2400): Activity {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val container = FrameLayout(activity).apply {
            setBackgroundColor(Color.WHITE)
        }
        activity.setContentView(container)
        // Force a concrete size on the decorView — Robolectric's default
        // window layout pass doesn't reliably give a non-zero size without
        // an explicit measure/layout, and capturePreviewFrame's acquisition
        // reads decorView.width/height directly.
        val decor = activity.window.decorView
        decor.measure(
            android.view.View.MeasureSpec.makeMeasureSpec(width, android.view.View.MeasureSpec.EXACTLY),
            android.view.View.MeasureSpec.makeMeasureSpec(height, android.view.View.MeasureSpec.EXACTLY),
        )
        decor.layout(0, 0, width, height)
        return activity
    }

    @Test
    fun `returns bytes that decode as JPEG`() {
        val activity = laidOutActivity()

        val result = runBlocking { ScreenshotCapture.capturePreviewFrame(activity) }

        assertNotNull("capturePreviewFrame must return a non-null PreviewCapture", result)
        assertEquals("image/jpeg", result!!.mime)
        assertTrue("bytes must be non-empty", result.bytes.isNotEmpty())

        // JPEG magic bytes: FF D8 FF.
        assertEquals(0xFF.toByte(), result.bytes[0])
        assertEquals(0xD8.toByte(), result.bytes[1])
        assertEquals(0xFF.toByte(), result.bytes[2])

        // The bytes must also actually decode as a bitmap of the announced size.
        val decoded = BitmapFactory.decodeByteArray(result.bytes, 0, result.bytes.size)
        assertNotNull("announced bytes must decode via BitmapFactory", decoded)
        assertEquals(result.width, decoded!!.width)
        assertEquals(result.height, decoded.height)
    }

    @Test
    fun `longest edge is downscaled to maxEdgePx`() {
        // 1200x2400 window, longest edge (2400) far exceeds the 854 default cap.
        val activity = laidOutActivity(width = 1200, height = 2400)

        val result = runBlocking { ScreenshotCapture.capturePreviewFrame(activity, maxEdgePx = 854) }

        assertNotNull(result)
        val longestEdge = maxOf(result!!.width, result.height)
        assertTrue(
            "longest edge ($longestEdge) must be <= maxEdgePx (854)",
            longestEdge <= 854,
        )
        // Aspect ratio preserved (roughly) — height was the long edge, so it
        // should land at (or just under) 854 after scaling.
        assertEquals(854, result.height)
    }

    @Test
    fun `window smaller than maxEdgePx is not upscaled`() {
        val activity = laidOutActivity(width = 200, height = 400)

        val result = runBlocking { ScreenshotCapture.capturePreviewFrame(activity, maxEdgePx = 854) }

        assertNotNull(result)
        assertEquals(200, result!!.width)
        assertEquals(400, result.height)
    }

    @Test
    fun `zero-size window yields null rather than throwing`() {
        // Robolectric's default `.setup()` activity already has a non-zero
        // decorView (real screen dimensions), so force it explicitly to 0x0
        // — mirrors the "null/zero-size window" DEFE-02 branch shared with
        // captureBeforeReporter (acquireBakedWindowBitmap's w<=0||h<=0 guard).
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val decor = activity.window.decorView
        decor.measure(
            android.view.View.MeasureSpec.makeMeasureSpec(0, android.view.View.MeasureSpec.EXACTLY),
            android.view.View.MeasureSpec.makeMeasureSpec(0, android.view.View.MeasureSpec.EXACTLY),
        )
        decor.layout(0, 0, 0, 0)

        val result = runBlocking { ScreenshotCapture.capturePreviewFrame(activity) }

        assertNull("zero-size window must degrade to null, not throw", result)
    }

    /**
     * JPEG is lossy, so "black" is a neighbourhood, not a value. Used for both
     * the positive assertion (the masked region IS black) and the negative
     * control (an unmasked region is NOT), which is what makes the pair able
     * to tell a real mask from an empty frame.
     */
    private fun isNearBlack(pixel: Int): Boolean =
        Color.red(pixel) < 20 && Color.green(pixel) < 20 && Color.blue(pixel) < 20

    private fun describe(pixel: Int): String =
        "r=${Color.red(pixel)} g=${Color.green(pixel)} b=${Color.blue(pixel)}"

    @Test
    fun `sensitive rects bake to black before JPEG encode`() {
        val activity = laidOutActivity(width = 400, height = 400)
        val rect = Rect(50, 50, 150, 150)

        val result = runBlocking {
            ScreenshotCapture.capturePreviewFrame(activity, sensitiveRects = listOf(rect))
        }

        assertNotNull(result)
        val decoded = BitmapFactory.decodeByteArray(result!!.bytes, 0, result.bytes.size)
        assertNotNull(decoded)
        val centerX = (rect.left + rect.right) / 2
        val centerY = (rect.top + rect.bottom) / 2
        // Task 11b review, finding 6: this assertion used to sit inside an
        // `if (centerX < width && centerY < height)`, so resizing the fixture
        // could silently reduce the whole test to zero assertions. The bound
        // is now asserted rather than used as a condition.
        assertTrue(
            "fixture must place the rect centre inside the frame ($centerX,$centerY in ${decoded!!.width}x${decoded.height})",
            centerX < decoded.width && centerY < decoded.height,
        )
        val masked = decoded.getPixel(centerX, centerY)
        assertTrue("rect centre must be near-black after bake+JPEG encode (${describe(masked)})", isNearBlack(masked))
    }

    @Test
    fun `masking blacks out the rect without blanking the rest of the frame`() {
        // Task 11b review, finding 5: without a negative control the test
        // above cannot tell "the mask was applied" from "the capture produced
        // an empty/black bitmap" — both make the sampled pixel black, and the
        // second would mean the privacy assertion is passing for the wrong
        // reason while the preview ships nothing at all.
        val activity = laidOutActivity(width = 400, height = 400)
        val rect = Rect(50, 50, 150, 150)

        val result = runBlocking {
            ScreenshotCapture.capturePreviewFrame(activity, sensitiveRects = listOf(rect))
        }

        val decoded = BitmapFactory.decodeByteArray(result!!.bytes, 0, result.bytes.size)!!
        val inside = decoded.getPixel((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2)
        val outside = decoded.getPixel(300, 300)

        assertTrue("inside the rect must be near-black (${describe(inside)})", isNearBlack(inside))
        assertFalse(
            "outside the rect must NOT be near-black (${describe(outside)}) — otherwise this suite " +
                "would pass just as happily on a frame that captured nothing",
            isNearBlack(outside),
        )
    }

    @Test
    fun `sensitive rects bake before the downscale, not after`() {
        // Task 11b review, finding 7: the privacy claim rests on bake-before-
        // scale ordering (rects are in window coordinates, so baking after a
        // resize would mask the WRONG pixels), and every masking test until
        // now used a fixture small enough that no downscale happened at all.
        // 1200x1200 against maxEdgePx=300 forces a real 0.25x scale.
        val activity = laidOutActivity(width = 1200, height = 1200)
        val rect = Rect(400, 400, 800, 800)

        val result = runBlocking {
            ScreenshotCapture.capturePreviewFrame(activity, sensitiveRects = listOf(rect), maxEdgePx = 300)
        }

        assertNotNull(result)
        assertEquals("the fixture must actually have been downscaled", 300, result!!.width)
        val decoded = BitmapFactory.decodeByteArray(result.bytes, 0, result.bytes.size)!!

        // Window coords scaled by 300/1200 = 0.25: the rect lands at 100..200,
        // so its centre is (150,150) and (30,30) is well outside it.
        val inside = decoded.getPixel(150, 150)
        val outside = decoded.getPixel(30, 30)

        assertTrue(
            "the masked region must still be black after the downscale (${describe(inside)}) — " +
                "baking after the scale would blacken a different region entirely",
            isNearBlack(inside),
        )
        assertFalse("outside the rect must survive the downscale (${describe(outside)})", isNearBlack(outside))
    }
}
