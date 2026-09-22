// AnnotationGeometryTest.kt — plain JUnit, NO Robolectric (the model must stay pure).
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Kotlin port of packages/sdk-ios/Tests/TraceItXReporterUITests/
// AnnotationModelTests.swift `AnnotationGeometryTests` — same 12 cases, same
// assertion values, adapted to the Box/HandleKind/Handle shapes from the
// Android Task-2 brief (fromX/fromY/toX/toY instead of CGPoint).
package com.traceitx.ui.annotation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AnnotationGeometryTest {
    @Test fun normalizeFlipsNegativeBox() {
        val a = Annotation.rect(x = 10f, y = 10f, width = -6f, height = -4f, color = 0, thickness = 2f)
        val b = normalizedBox(a)
        assertEquals(Box(4f, 6f, 6f, 4f), b)
    }

    @Test fun translateEveryKind() {
        val pen = Annotation.pen(points = listOf(0f, 0f, 10f, 10f), color = 0, thickness = 2f)
        assertEquals(listOf(5f, 3f, 15f, 13f), translateAnnotation(pen, dx = 5f, dy = 3f).points)

        val arrow = Annotation.arrow(fromX = 1f, fromY = 1f, toX = 9f, toY = 9f, color = 0, thickness = 2f)
        val movedArrow = translateAnnotation(arrow, dx = 1f, dy = 2f)
        assertEquals(2f, movedArrow.fromX); assertEquals(3f, movedArrow.fromY)
        assertEquals(10f, movedArrow.toX); assertEquals(11f, movedArrow.toY)

        val box = Annotation.text(x = 5f, y = 5f, text = "t", color = 0, fontSize = 16f)
        val movedBox = translateAnnotation(box, dx = -2f, dy = 4f)
        assertEquals(3f, movedBox.x); assertEquals(9f, movedBox.y)
    }

    @Test fun hitTestInteriorOfUnfilledRect() {
        // Web QA bug #1 — the CENTER of an outline-only rect must hit.
        val r = Annotation.rect(x = 10f, y = 10f, width = 100f, height = 100f, color = 0, thickness = 2f)
        assertEquals(r.id, hitTest(listOf(r), px = 60f, py = 60f, tolerance = 8f))
        assertNull(hitTest(listOf(r), px = 200f, py = 200f, tolerance = 8f))
    }

    @Test fun hitTestTopmostWins() {
        val bottom = Annotation.rect(x = 0f, y = 0f, width = 50f, height = 50f, color = 0, thickness = 2f)
        val top = Annotation.ellipse(x = 20f, y = 20f, width = 50f, height = 50f, color = 0, thickness = 2f)
        // Overlap region — later array entry (top) must win.
        assertEquals(top.id, hitTest(listOf(bottom, top), px = 30f, py = 30f, tolerance = 8f))
    }

    @Test fun hitTestPenByDistanceToPolyline() {
        val pen = Annotation.pen(points = listOf(0f, 0f, 100f, 0f), color = 0, thickness = 4f)
        assertEquals(pen.id, hitTest(listOf(pen), px = 50f, py = 5f, tolerance = 8f))   // 5px off the line
        assertNull(hitTest(listOf(pen), px = 50f, py = 40f, tolerance = 8f))
    }

    @Test fun handlesPerKind() {
        val rect = Annotation.rect(x = 0f, y = 0f, width = 10f, height = 10f, color = 0, thickness = 2f)
        assertEquals(4, handles(rect).size)

        val arrow = Annotation.arrow(fromX = 0f, fromY = 0f, toX = 10f, toY = 0f, color = 0, thickness = 2f)
        val ah = handles(arrow)
        assertEquals(listOf(HandleKind.ARROW_FROM, HandleKind.ARROW_TO), ah.map { it.kind })

        val pen = Annotation.pen(points = listOf(0f, 0f, 1f, 1f), color = 0, thickness = 2f)
        assertTrue(handles(pen).isEmpty())   // strokes are move-only
    }

    @Test fun resizeClampsToMinBoxEdge() {
        val r = Annotation.rect(x = 0f, y = 0f, width = 20f, height = 20f, color = 0, thickness = 2f)
        // Drag bottom-right past the top-left corner — box must not invert below 3px.
        val shrunk = applyResize(r, handle = HandleKind.BOTTOM_RIGHT, px = 1f, py = 1f)
        val b = normalizedBox(shrunk)
        assertTrue(b.width >= AnnotationConstants.MIN_BOX_EDGE && b.height >= AnnotationConstants.MIN_BOX_EDGE)
    }

    @Test fun resizeTextScalesFontSizeWithFloor() {
        val t = Annotation.text(x = 0f, y = 0f, text = "hi", color = 0, fontSize = 24f)
            .copy(width = 100f, height = 30f)   // editor stamps measured bounds before handles show
        val bigger = applyResize(t, handle = HandleKind.BOTTOM_RIGHT, px = 200f, py = 60f)
        assertEquals(48f, bigger.fontSize)   // 2x width ratio
        val tiny = applyResize(t, handle = HandleKind.BOTTOM_RIGHT, px = 4f, py = 2f)
        assertEquals(AnnotationConstants.MIN_TEXT_FONT_SIZE, tiny.fontSize)
    }

    @Test fun resizeArrowMovesEndpoint() {
        val a = Annotation.arrow(fromX = 0f, fromY = 0f, toX = 10f, toY = 10f, color = 0, thickness = 2f)
        val r = applyResize(a, handle = HandleKind.ARROW_TO, px = 50f, py = 5f)
        assertEquals(50f, r.toX); assertEquals(5f, r.toY)
        assertEquals(0f, r.fromX); assertEquals(0f, r.fromY)
    }

    @Test fun resizeTextKeepsAnchorPinned() {
        // TOP_LEFT drag: bottom-right corner is the anchor and must not move.
        val t = Annotation.text(x = 0f, y = 0f, text = "hi", color = 0, fontSize = 24f)
            .copy(width = 100f, height = 30f)
        val resized = applyResize(t, handle = HandleKind.TOP_LEFT, px = -50f, py = -50f)
        val b = normalizedBox(resized)
        assertEquals(100f, b.maxX); assertEquals(30f, b.maxY)   // anchor pinned
        assertEquals(-50f, b.minX); assertEquals(-50f, b.minY)  // dragged corner follows
    }

    @Test fun commitThresholdRejectsDegenerateBoxes() {
        val sliver = Annotation.blur(x = 0f, y = 0f, width = 10f, height = 1f)
        assertEquals(false, meetsCommitThreshold(sliver))   // would bake as ~nothing
        val ok = Annotation.blur(x = 0f, y = 0f, width = 5f, height = 5f)
        assertEquals(true, meetsCommitThreshold(ok))
    }

    @Test fun commitThresholdStrokesUseDragExtent() {
        val shortPen = Annotation.pen(points = listOf(0f, 0f, 2f, 2f), color = 0, thickness = 2f)
        assertEquals(false, meetsCommitThreshold(shortPen))
        val axisArrow = Annotation.arrow(fromX = 0f, fromY = 0f, toX = 6f, toY = 0f, color = 0, thickness = 2f)
        assertEquals(true, meetsCommitThreshold(axisArrow))   // axis-aligned drags are fine for lines
    }

    @Test fun resizeTextRoundsTiesAwayFromZeroLikeIOS() {
        // fontSize 73, scale 0.5 -> product 36.5 exactly (tie case).
        // With ties-to-even (kotlin.math.round), this would round to 36.
        // With ties-away-from-zero (Swift .rounded()), this rounds to 37 — required for iOS parity.
        // Shape at x=0, y=0, width=100. BOTTOM_RIGHT anchor = (0, 0). Drag to px=50 -> scale 0.5.
        val t = Annotation.text(x = 0f, y = 0f, text = "hi", color = 0, fontSize = 73f)
            .copy(width = 100f, height = 30f)
        val resized = applyResize(t, HandleKind.BOTTOM_RIGHT, px = 50f, py = 15f)
        assertEquals(37f, resized.fontSize)   // ties away from zero (iOS parity); ties-to-even would give 36
    }
}
