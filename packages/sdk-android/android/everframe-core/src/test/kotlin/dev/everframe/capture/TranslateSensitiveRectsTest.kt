// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// TranslateSensitiveRectsTest — Task 8 (area capture). Covers
// ScreenshotCapture.translateSensitiveRects, the pure WINDOW-coord →
// region-local coordinate translation that captureRegion runs sensitive
// rects through before baking (PRIV-03), and (review finding 1, fix round 1)
// ScreenshotCapture.clampRegionToWindow, the pure caller-rect → window-bounds
// clamp captureRegion now runs FIRST, before either allocation or the
// PixelCopy request itself. Robolectric is used purely because
// android.graphics.Rect's real intersect()/offset() logic requires it —
// under the plain android.jar stub jar (isReturnDefaultValues = true)
// Rect's methods no-op / return defaults instead of doing real math. Same
// convention as SensitiveRectRegistryTest, which also
// exercise android.graphics.Rect under RobolectricTestRunner.
package dev.everframe.capture

import android.graphics.Rect
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class TranslateSensitiveRectsTest {

    @Test
    fun `fully-inside rect is offset only, size unchanged`() {
        val region = Rect(100, 100, 300, 300) // 200x200
        val sensitive = Rect(150, 150, 180, 170) // fully inside, 30x20

        val out = ScreenshotCapture.translateSensitiveRects(listOf(sensitive), region)

        assertEquals(1, out.size)
        // Offset by -region.left, -region.top: (150-100, 150-100, 180-100, 170-100).
        assertEquals(Rect(50, 50, 80, 70), out[0])
    }

    @Test
    fun `partial-overlap rect is clipped to the region before offsetting`() {
        val region = Rect(0, 0, 100, 100)
        // Straddles the region's right/bottom edge: intersection is (80,80,100,100).
        val sensitive = Rect(80, 80, 140, 160)

        val out = ScreenshotCapture.translateSensitiveRects(listOf(sensitive), region)

        assertEquals(1, out.size)
        assertEquals(Rect(80, 80, 100, 100), out[0])
    }

    @Test
    fun `non-intersecting rect outside the region is dropped`() {
        val region = Rect(0, 0, 100, 100)
        val sensitive = Rect(200, 200, 250, 250)

        val out = ScreenshotCapture.translateSensitiveRects(listOf(sensitive), region)

        assertTrue(out.isEmpty())
    }

    @Test
    fun `rect that only touches the region boundary is dropped (zero-area overlap)`() {
        val region = Rect(0, 0, 100, 100)
        // Shares the region's right edge (region.right == sensitive.left) but has
        // no overlapping area — android.graphics.Rect#intersect treats a shared
        // edge with zero area as non-intersecting.
        val sensitive = Rect(100, 0, 150, 100)

        val out = ScreenshotCapture.translateSensitiveRects(listOf(sensitive), region)

        assertTrue(out.isEmpty())
    }

    @Test
    fun `rect exactly matching the region is preserved at region-local origin`() {
        val region = Rect(50, 50, 150, 150)
        val sensitive = Rect(50, 50, 150, 150)

        val out = ScreenshotCapture.translateSensitiveRects(listOf(sensitive), region)

        assertEquals(1, out.size)
        assertEquals(Rect(0, 0, 100, 100), out[0])
    }

    @Test
    fun `multiple rects are each translated independently, drops and clips mixed`() {
        val region = Rect(0, 0, 100, 100)
        val inside = Rect(10, 10, 20, 20)
        val outside = Rect(500, 500, 600, 600)
        val straddling = Rect(-10, -10, 10, 10) // intersection: (0,0,10,10)

        val out = ScreenshotCapture.translateSensitiveRects(
            listOf(inside, outside, straddling),
            region,
        )

        assertEquals(2, out.size)
        assertEquals(Rect(10, 10, 20, 20), out[0])
        assertEquals(Rect(0, 0, 10, 10), out[1])
    }

    @Test
    fun `original sensitive rect list is not mutated`() {
        val region = Rect(0, 0, 100, 100)
        val sensitive = Rect(10, 10, 20, 20)
        val original = Rect(sensitive)

        ScreenshotCapture.translateSensitiveRects(listOf(sensitive), region)

        assertEquals(original, sensitive)
    }

    // ---- clampRegionToWindow (review finding 1, fix round 1) --------------

    @Test
    fun `region fully inside window bounds is returned unchanged`() {
        val region = Rect(10, 10, 50, 50)

        val out = ScreenshotCapture.clampRegionToWindow(region, windowWidth = 100, windowHeight = 100)

        assertEquals(Rect(10, 10, 50, 50), out)
    }

    @Test
    fun `region overhanging the right and bottom edges is clipped to window bounds`() {
        val region = Rect(80, 80, 150, 150)

        val out = ScreenshotCapture.clampRegionToWindow(region, windowWidth = 100, windowHeight = 100)

        assertEquals(Rect(80, 80, 100, 100), out)
    }

    @Test
    fun `region entirely outside window bounds clamps to null`() {
        val region = Rect(200, 200, 250, 250)

        val out = ScreenshotCapture.clampRegionToWindow(region, windowWidth = 100, windowHeight = 100)

        assertNull(out)
    }

    @Test
    fun `region with negative origin is clipped to zero`() {
        val region = Rect(-20, -20, 50, 50)

        val out = ScreenshotCapture.clampRegionToWindow(region, windowWidth = 100, windowHeight = 100)

        assertEquals(Rect(0, 0, 50, 50), out)
    }

    @Test
    fun `region exactly matching window bounds is returned unchanged`() {
        val region = Rect(0, 0, 100, 100)

        val out = ScreenshotCapture.clampRegionToWindow(region, windowWidth = 100, windowHeight = 100)

        assertEquals(Rect(0, 0, 100, 100), out)
    }

    @Test
    fun `region only touching the window boundary clamps to null (zero-area overlap)`() {
        // Shares the window's right edge (windowWidth == region.left) but has
        // no overlapping area — same zero-area-overlap semantics as
        // translateSensitiveRects above.
        val region = Rect(100, 0, 150, 100)

        val out = ScreenshotCapture.clampRegionToWindow(region, windowWidth = 100, windowHeight = 100)

        assertNull(out)
    }

    @Test
    fun `original region rect passed to clampRegionToWindow is not mutated`() {
        val region = Rect(80, 80, 150, 150)
        val original = Rect(region)

        ScreenshotCapture.clampRegionToWindow(region, windowWidth = 100, windowHeight = 100)

        assertEquals(original, region)
    }
}
