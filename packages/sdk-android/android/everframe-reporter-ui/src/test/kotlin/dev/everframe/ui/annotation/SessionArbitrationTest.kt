// SessionArbitrationTest.kt — plain JUnit, NO Robolectric (arbitration must stay pure).
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Kotlin port of packages/sdk-ios/Tests/EverframeReporterUITests/
// AnnotationModelTests.swift `SessionArbitrationTests` — same intent,
// adapted to the flat Kotlin HandleKind (no nested Swift .corner() case).
package dev.everframe.ui.annotation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionArbitrationTest {
    // ---- resolveDrag ----

    @Test fun handlePlusSelectionResolvesToResize() {
        assertEquals(
            PendingResolution.Resize(HandleKind.TOP_LEFT),
            resolveDrag(AnnotationTool.POINTER, onHandle = HandleKind.TOP_LEFT, onShape = null, selectedId = "a1"),
        )
    }

    @Test fun dragOnSelectedShapeResolvesToMove() {
        assertEquals(
            PendingResolution.Move("a1"),
            resolveDrag(AnnotationTool.POINTER, onHandle = null, onShape = "a1", selectedId = "a1"),
        )
    }

    @Test fun pointerOnUnselectedShapeResolvesToMove() {
        assertEquals(
            PendingResolution.Move("a2"),
            resolveDrag(AnnotationTool.POINTER, onHandle = null, onShape = "a2", selectedId = "a1"),
        )
    }

    @Test fun penElsewhereResolvesToDraw() {
        assertEquals(
            PendingResolution.Draw,
            resolveDrag(AnnotationTool.PEN, onHandle = null, onShape = null, selectedId = null),
        )
    }

    @Test fun pointerOverEmptyResolvesToIgnore() {
        assertEquals(
            PendingResolution.Ignore,
            resolveDrag(AnnotationTool.POINTER, onHandle = null, onShape = null, selectedId = null),
        )
    }

    // ---- resolveTap ----

    @Test fun tapShapeWithPenToolSelects() {
        assertEquals(TapResolution.Select("a1"), resolveTap(AnnotationTool.PEN, onShape = "a1"))
    }

    @Test fun tapEmptyWithPenToolDeselects() {
        assertEquals(TapResolution.Deselect, resolveTap(AnnotationTool.PEN, onShape = null))
    }

    // ---- isDrawingTool ----

    @Test fun drawingToolsClassifiedCorrectly() {
        val drawing = listOf(
            AnnotationTool.PEN, AnnotationTool.HIGHLIGHTER, AnnotationTool.RECT,
            AnnotationTool.ELLIPSE, AnnotationTool.ARROW, AnnotationTool.REDACT,
        )
        for (t in drawing) assertTrue("$t should be a drawing tool", isDrawingTool(t))
        val nonDrawing = listOf(AnnotationTool.POINTER, AnnotationTool.TEXT)
        for (t in nonDrawing) assertTrue("$t should not be a drawing tool", !isDrawingTool(t))
    }
}
