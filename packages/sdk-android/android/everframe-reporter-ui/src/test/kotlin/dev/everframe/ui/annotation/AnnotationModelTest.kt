// AnnotationModelTest.kt — plain JUnit, NO Robolectric (the model must stay pure).
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.ui.annotation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AnnotationModelTest {
    @Test fun idsAreUnique() {
        assertNotEquals(newAnnotationId(), newAnnotationId())
    }

    @Test fun constantsMatchWeb() {
        assertEquals(listOf(0xFFFF3B30, 0xFFFFCC00, 0xFF32ADE6, 0xFFFFFFFF, 0xFF000000), AnnotationConstants.PEN_COLORS)
        assertEquals(listOf(2f, 4f, 8f), AnnotationConstants.PEN_THICKNESSES)
        assertEquals(listOf(16f, 24f, 36f), AnnotationConstants.TEXT_FONT_SIZES)
        assertEquals(0.45f, AnnotationConstants.HIGHLIGHTER_OPACITY)
        assertEquals(3f, AnnotationConstants.HIGHLIGHTER_WIDTH_MULTIPLIER)
        assertEquals(50, AnnotationConstants.HISTORY_CAP)
    }

    @Test fun historyPushUndoRedo() {
        val s0 = emptyList<Annotation>()
        val s1 = listOf(Annotation.pen(points = listOf(0f, 0f, 10f, 10f), color = 0xFFFF3B30, thickness = 4f))
        var h = EditorHistory()
        h = h.push(s0)
        val undo = h.undo(current = s1)!!
        assertEquals(s0, undo.annotations)
        val redo = undo.history.redo(current = s0)!!
        assertEquals(s1, redo.annotations)
    }

    @Test fun pushClearsFuture() {
        val s0 = emptyList<Annotation>()
        val s1 = listOf(Annotation.rect(x = 1f, y = 1f, width = 5f, height = 5f, color = 0xFF000000, thickness = 2f))
        var h = EditorHistory().push(s0)
        h = h.undo(current = s1)!!.history
        h = h.push(s0)
        assertNull(h.redo(current = s0))
    }

    @Test fun historyCapsAtFifty() {
        var h = EditorHistory()
        repeat(60) { i ->
            h = h.push(listOf(Annotation.text(x = i.toFloat(), y = 0f, text = "$i", color = 0xFFFFFFFF, fontSize = 16f)))
        }
        var undos = 0
        var cur = emptyList<Annotation>()
        var walker: EditorHistory = h
        while (true) {
            val r = walker.undo(cur) ?: break
            walker = r.history; cur = r.annotations; undos++
        }
        assertEquals(50, undos)
    }

    @Test fun undoOnEmptyReturnsNull() {
        assertNull(EditorHistory().undo(emptyList()))
        assertNull(EditorHistory().redo(emptyList()))
    }
}
