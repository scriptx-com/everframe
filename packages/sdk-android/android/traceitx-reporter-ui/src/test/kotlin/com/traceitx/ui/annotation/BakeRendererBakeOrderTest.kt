// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Model-driven bake-order fixture (RED then GREEN, Task 4).
// PRIV-03 order lock: BLUR (redactions) bakes first as opaque black,
// regardless of array position, then every other shape in array order.
package com.traceitx.ui.annotation

import android.graphics.Bitmap
import android.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [33])
class BakeRendererBakeOrderTest {
    private fun whiteBitmap() = Bitmap.createBitmap(100, 100, Bitmap.Config.ARGB_8888)
        .apply { eraseColor(Color.WHITE) }

    @Test fun redactionBakesOpaqueBlack() {
        val baked = BakeRenderer.bake(whiteBitmap(), listOf(Annotation.blur(10f, 10f, 30f, 30f)))
        assertEquals(Color.BLACK, baked.getPixel(25, 25))
        assertEquals(Color.WHITE, baked.getPixel(80, 80))
    }

    @Test fun redactionsBakeBeforeShapesRegardlessOfArrayOrder() {
        val pen = Annotation.pen(points = listOf(0f, 25f, 99f, 25f), color = 0xFFFF3B30, thickness = 6f)
        val redact = Annotation.blur(0f, 0f, 100f, 50f)
        val baked = BakeRenderer.bake(whiteBitmap(), listOf(pen, redact))
        val p = baked.getPixel(50, 25)
        assertTrue(Color.red(p) > 200 && Color.green(p) < 100)  // red stroke over black
    }

    @Test fun highlighterIsTranslucentWide() {
        val hl = Annotation.highlighter(points = listOf(0f, 50f, 99f, 50f), color = 0xFFFFCC00, thickness = 4f)
        val baked = BakeRenderer.bake(whiteBitmap(), listOf(hl))
        val b = Color.blue(baked.getPixel(50, 50))
        assertTrue(b in 101..219)  // 45% yellow over white — blue drops but not to 0
    }

    @Test fun textBakesPixels() {
        val t = Annotation.text(x = 10f, y = 40f, text = "BUG", color = 0xFF000000, fontSize = 24f)
        val baked = BakeRenderer.bake(whiteBitmap(), listOf(t))
        var found = false
        outer@ for (x in 10 until 80) for (y in 40 until 75) {
            if (Color.red(baked.getPixel(x, y)) < 200) { found = true; break@outer }
        }
        assertTrue(found)
    }
}
