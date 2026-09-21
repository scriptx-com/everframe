// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// ScreenshotCapture instrumented test — exercises PixelCopy.request against a
// real Activity window and asserts (a) bytes are produced, (b) sensitive rects
// bake to BLACK pixels in the bake-before-encode path (PRIV-03).
//
// Runs only on a phone emulator/device via `./gradlew connectedAndroidTest`.
// In sandbox CI without an emulator this file is compile-checked via
// `:traceitx-core:assembleDebugAndroidTest`. Plan 08 release-APK gate
// exercises the actual pixel-bake assertion on a live emulator.
package com.traceitx.capture

import android.app.Activity
import android.graphics.Color
import android.graphics.Rect
import android.os.Bundle
import android.widget.FrameLayout
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert
import org.junit.Test

class ScreenshotCaptureInstrumentedTest {

    class TestActivity : Activity() {
        override fun onCreate(savedInstanceState: Bundle?) {
            super.onCreate(savedInstanceState)
            val container = FrameLayout(this).apply {
                setBackgroundColor(Color.WHITE)
            }
            setContentView(container)
        }
    }

    @Test
    fun captureBeforeReporter_returns_non_null_bytes() {
        ActivityScenario.launch(TestActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val result = runBlocking {
                    ScreenshotCapture.captureBeforeReporter(activity, emptyList())
                }
                Assert.assertNotNull("CaptureResult must be non-null", result)
                Assert.assertTrue("widthPx > 0", result!!.widthPx > 0)
                Assert.assertTrue("heightPx > 0", result.heightPx > 0)
                Assert.assertTrue("pngBytes non-empty", result.pngBytes.isNotEmpty())
            }
        }
    }

    @Test
    fun sensitive_rects_bake_to_black_pre_encode() {
        InstrumentationRegistry.getInstrumentation()   // ensure runtime present
        ActivityScenario.launch(TestActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val rect = Rect(50, 50, 200, 200)
                val result = runBlocking {
                    ScreenshotCapture.captureBeforeReporter(activity, listOf(rect))
                }
                Assert.assertNotNull(result)
                // Sample the bitmap at the rect center — must be BLACK (0xFF000000).
                // Note: the bitmap is downscaled if window > 2048px, but in a test
                // Activity the window is well under that, so coords map 1:1.
                val centerX = (rect.left + rect.right) / 2
                val centerY = (rect.top + rect.bottom) / 2
                if (centerX < result!!.bitmap.width && centerY < result.bitmap.height) {
                    val pixel = result.bitmap.getPixel(centerX, centerY)
                    Assert.assertEquals(
                        "rect center pixel must be opaque black (PRIV-03)",
                        Color.BLACK,
                        pixel,
                    )
                }
            }
        }
    }
}
