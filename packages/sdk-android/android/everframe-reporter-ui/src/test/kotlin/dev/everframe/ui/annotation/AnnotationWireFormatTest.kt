// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Pure serializer tests — plain JUnit, no Robolectric (AnnotationWireFormat
// avoids android.* imports). Ports iOS Task 10's AnnotationWireFormatTests.swift
// (5 cases): hex6 color + kind + partName + points on a pen; blur mirrored
// into redactions with `type:"blur"` and box fields; arrow from/to as [x,y]
// arrays + text text/fontSize fields; blur omits color/thickness; non-blur
// shapes don't mirror into redactions.
package dev.everframe.ui.annotation

import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AnnotationWireFormatTest {
    @Test fun colorSerializesAsHex6() {
        val pen = Annotation.pen(points = listOf(1f, 2f, 3f, 4f), color = 0xFFFF3B30, thickness = 4f)
        val wire = AnnotationWireFormat.serialize(listOf(pen), partName = "screenshot")
        val o = wire.annotations[0]
        assertEquals("#FF3B30", o["color"]!!.jsonPrimitive.content)
        assertEquals("pen", o["kind"]!!.jsonPrimitive.content)
        assertEquals("screenshot", o["partName"]!!.jsonPrimitive.content)
        assertEquals(listOf(1.0, 2.0, 3.0, 4.0), o["points"]!!.jsonArray.map { it.jsonPrimitive.double })
    }

    @Test fun blurMirrorsIntoRedactions() {
        val wire = AnnotationWireFormat.serialize(
            listOf(Annotation.blur(5f, 6f, 20f, 10f)), partName = "annotated-screenshot-2")
        assertEquals(1, wire.annotations.size)
        val r = wire.redactions.single()
        assertEquals("blur", r["type"]!!.jsonPrimitive.content)
        assertEquals("annotated-screenshot-2", r["partName"]!!.jsonPrimitive.content)
        assertEquals(5.0, r["x"]!!.jsonPrimitive.double, 0.0)
    }

    @Test fun arrowAndTextFieldShapes() {
        val arrow = Annotation.arrow(fromX = 1f, fromY = 2f, toX = 3f, toY = 4f, color = 0xFF000000, thickness = 2f)
        val text = Annotation.text(x = 9f, y = 9f, text = "hi", color = 0xFFFFFFFF, fontSize = 24f)
        val wire = AnnotationWireFormat.serialize(listOf(arrow, text), partName = "screenshot")
        val a = wire.annotations[0]
        assertEquals(listOf(1.0, 2.0), a["from"]!!.jsonArray.map { it.jsonPrimitive.double })
        assertEquals(listOf(3.0, 4.0), a["to"]!!.jsonArray.map { it.jsonPrimitive.double })
        val t = wire.annotations[1]
        assertEquals("hi", t["text"]!!.jsonPrimitive.content)
        assertEquals(24.0, t["fontSize"]!!.jsonPrimitive.double, 0.0)
    }

    @Test fun blurAnnotationEntryOmitsColorAndThickness() {
        val wire = AnnotationWireFormat.serialize(listOf(Annotation.blur(1f, 2f, 3f, 4f)), partName = "screenshot")
        val o = wire.annotations[0]
        assertNull(o["color"])
        assertNull(o["thickness"])
    }

    @Test fun nonBlurShapesDoNotMirrorIntoRedactions() {
        val rect = Annotation.rect(x = 0f, y = 0f, width = 10f, height = 10f, color = 0xFFFF3B30, thickness = 2f)
        val wire = AnnotationWireFormat.serialize(listOf(rect), partName = "screenshot")
        assertEquals(1, wire.annotations.size)
        assertTrue(wire.redactions.isEmpty())
    }
}
