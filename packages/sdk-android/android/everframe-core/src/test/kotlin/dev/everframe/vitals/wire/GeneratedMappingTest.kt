// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.vitals.wire

import dev.everframe.protocol.generated.Type
import dev.everframe.protocol.generated.VitalKind
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class GeneratedMappingTest {
    @Test
    fun `maps all three kinds and drops an unknown player type`() {
        val out = listOf(
            VitalsSample(t = 1, cpu = 0.5, mem = 10, extras = mapOf("javaHeap" to 1.0)),
            VitalsPlayerEvent(t = 2, type = "error", playerId = "p1", data = buildJsonObject { put("message", JsonPrimitive("x")) }, truncated = true),
            VitalsPlayerEvent(t = 3, type = "not_a_type"),
            VitalsCustomEntry(t = 4, name = "n", data = JsonPrimitive(1), playerId = "p1"),
        ).toGeneratedVitals()
        assertEquals(3, out.size)
        assertEquals(VitalKind.Sample, out[0].kind); assertEquals(10.0, out[0].mem!!, 0.0); assertEquals(0.5, out[0].cpu!!, 0.0); assertNull(out[0].type)
        assertEquals(VitalKind.Player, out[1].kind); assertEquals(Type.Error, out[1].type); assertEquals("p1", out[1].playerID); assertEquals(true, out[1].truncated)
        assertEquals(VitalKind.Custom, out[2].kind); assertEquals("n", out[2].name); assertEquals(4.0, out[2].t, 0.0)
    }
}
