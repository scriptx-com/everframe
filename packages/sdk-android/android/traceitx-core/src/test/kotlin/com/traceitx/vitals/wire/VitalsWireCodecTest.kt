// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.vitals.wire

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VitalsWireCodecTest {
    private val dims = SessionSummaryDims(platform = "android", appVersion = "1.0", sdkVersion = "0.8.0")

    @Test
    fun `optional entry fields are absent, not null`() {
        val s = VitalsWireCodec.encodeChunk(VitalsChunk("s", 0, listOf(VitalsSample(t = 1, mem = 2))))
        assertEquals("""{"kind":"chunk","sessionId":"s","seq":0,"entries":[{"kind":"sample","t":1,"mem":2}]}""", s)
        val p = VitalsWireCodec.encodeChunk(VitalsChunk("s", 0, listOf(VitalsPlayerEvent(t = 1, type = "play"))))
        assertFalse(p.contains("playerId"))
        assertFalse(p.contains("null"))
    }

    @Test
    fun `summary nullable fields are present as null, seq always present`() {
        val summary = SessionSummary(
            sessionId = "s", final = true, seq = 0, startedAt = 0, durationMs = 0, playtimeMs = 0,
            startupTimeMs = null, rebufferCount = 0, rebufferDurationMs = 0, bitrateMean = null,
            errorCount = 0, memPeak = 0, memAvg = 0, playerCount = 0, playerCountSaturated = false, dims = dims,
        )
        val el = VitalsWireCodec.encodePayload(summary).jsonObject
        assertEquals(JsonPrimitive(null as String?), el["startupTimeMs"])
        assertEquals(JsonPrimitive(null as String?), el["bitrateMean"])
        assertEquals("0", el["seq"]!!.jsonPrimitive.content)
        assertEquals("false", el["playerCountSaturated"]!!.jsonPrimitive.content)
        assertFalse(el["dims"]!!.jsonObject.containsKey("deviceModel"))
    }

    @Test
    fun `request wrapper is payload only`() {
        val r = VitalsWireCodec.encodeRequest(VitalsChunk("s", 1, listOf(VitalsSample(t = 1, mem = 2))))
        assertTrue(r.startsWith("""{"payload":{"kind":"chunk""""))
        assertFalse(r.contains("apiKey"))
    }

    @Test
    fun `utf8Length counts bytes not code units`() {
        assertEquals(1, VitalsWireCodec.utf8Length("a"))
        assertEquals(2, VitalsWireCodec.utf8Length("é"))
        assertEquals(3, VitalsWireCodec.utf8Length("€"))
        assertEquals(4, VitalsWireCodec.utf8Length("😀"))
    }

    @Test
    fun `extras keeps large and fractional doubles exact, never scientific notation`() {
        val s = VitalsWireCodec.encodeChunk(
            VitalsChunk(
                "s", 0,
                listOf(
                    VitalsSample(
                        t = 1, mem = 2,
                        extras = mapOf("x" to 12345678.9, "y" to 0.0001, "z" to 41943040.0),
                    ),
                ),
            ),
        )
        assertTrue(s, s.contains(""""x":12345678.9"""))
        assertTrue(s, s.contains(""""y":0.0001"""))
        assertTrue(s, s.contains(""""z":41943040"""))
    }

    @Test
    fun `decodePayload round-trips a chunk with all three kinds`() {
        val chunk = VitalsChunk(
            "s", 2,
            listOf(
                VitalsSample(t = 1, cpu = 0.5, mem = 10, extras = mapOf("javaHeap" to 3.0)),
                VitalsPlayerEvent(t = 2, type = "error", playerId = "p1", data = buildJsonObject { put("message", JsonPrimitive("x")) }, truncated = true),
                VitalsCustomEntry(t = 3, name = "n", data = JsonPrimitive(7), playerId = "p1"),
            ),
        )
        val back = VitalsWireCodec.decodePayload(VitalsWireCodec.encodeRequestPayloadOnly(chunk))
        assertEquals(chunk, back)
    }
}
