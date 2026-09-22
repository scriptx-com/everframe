// ImageTransformTest.kt
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package com.traceitx.ui.annotation

import org.junit.Test
import kotlin.math.abs

class ImageTransformTest {
    @Test fun letterboxedFitCentersAndScales() {
        // 200×100 image in a 400×400 view → scale 2, vertical letterbox 100pt.
        val t = ImageTransform(imageWidth = 200f, imageHeight = 100f, viewWidth = 400f, viewHeight = 400f)
        assert(t.scale == 2f) { "Expected scale 2, got ${t.scale}" }
        assert(t.offsetX == 0f) { "Expected offsetX 0, got ${t.offsetX}" }
        assert(t.offsetY == 100f) { "Expected offsetY 100, got ${t.offsetY}" }
        assert(t.toViewX(0f) == 0f) { "Expected toViewX(0) == 0, got ${t.toViewX(0f)}" }
        assert(t.toViewY(0f) == 100f) { "Expected toViewY(0) == 100, got ${t.toViewY(0f)}" }
        assert(t.toImageX(400f) == 200f) { "Expected toImageX(400) == 200, got ${t.toImageX(400f)}" }
        assert(t.toImageY(300f) == 100f) { "Expected toImageY(300) == 100, got ${t.toImageY(300f)}" }
    }

    @Test fun roundTripIsIdentity() {
        val t = ImageTransform(imageWidth = 333f, imageHeight = 777f, viewWidth = 390f, viewHeight = 644f)
        val px = 123.5f
        val py = 456.25f
        val backX = t.toImageX(t.toViewX(px))
        val backY = t.toImageY(t.toViewY(py))
        assert(abs(backX - px) < 0.001f) { "Expected X round-trip within 0.001, got diff ${abs(backX - px)}" }
        assert(abs(backY - py) < 0.001f) { "Expected Y round-trip within 0.001, got diff ${abs(backY - py)}" }
    }

    @Test fun upscaleCapsAtFour() {
        // 40×40 crop in a 400×400 view: uncapped fit would be ×10 — cap at ×4.
        val t = ImageTransform(imageWidth = 40f, imageHeight = 40f, viewWidth = 400f, viewHeight = 400f)
        assert(t.scale == 4f) { "Expected scale 4, got ${t.scale}" }
        // Centered: (400 − 160)/2 = 120.
        assert(t.offsetX == 120f) { "Expected offsetX 120, got ${t.offsetX}" }
        assert(t.offsetY == 120f) { "Expected offsetY 120, got ${t.offsetY}" }
    }

    @Test fun degenerateSizesYieldIdentity() {
        val t = ImageTransform(imageWidth = 0f, imageHeight = 0f, viewWidth = 100f, viewHeight = 100f)
        assert(t.scale == 1f) { "Expected scale 1, got ${t.scale}" }
        assert(t.offsetX == 0f) { "Expected offsetX 0, got ${t.offsetX}" }
        assert(t.offsetY == 0f) { "Expected offsetY 0, got ${t.offsetY}" }
    }

    @Test fun imageFrameInView() {
        val t = ImageTransform(imageWidth = 200f, imageHeight = 100f, viewWidth = 400f, viewHeight = 400f)
        val frame = t.imageFrameInView()
        assert(frame.x == 0f) { "Expected frame.x == 0, got ${frame.x}" }
        assert(frame.y == 100f) { "Expected frame.y == 100, got ${frame.y}" }
        assert(frame.width == 400f) { "Expected frame.width == 400, got ${frame.width}" }
        assert(frame.height == 200f) { "Expected frame.height == 200, got ${frame.height}" }
    }
}
