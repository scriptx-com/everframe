// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.vitals.wire

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

class VitalsFixtureParityTest {
    private val fixture: JsonObject = Json.parseToJsonElement(
        javaClass.getResourceAsStream("/vitals-android.v1.json")!!.bufferedReader().use { it.readText() },
    ).jsonObject

    private fun canonical(el: JsonElement): JsonElement = when (el) {
        is JsonObject -> buildJsonObject { for (k in el.keys.sorted()) put(k, canonical(el.getValue(k))) }
        is JsonArray -> buildJsonArray { el.forEach { add(canonical(it)) } }
        is JsonPrimitive -> el
    }

    private fun obj(vararg pairs: Pair<String, Any?>): JsonObject = buildJsonObject {
        for ((k, v) in pairs) put(
            k,
            when (v) {
                null -> JsonPrimitive(null as String?)
                is String -> JsonPrimitive(v)
                is Boolean -> JsonPrimitive(v)
                is Number -> JsonPrimitive(v)
                is JsonElement -> v
                else -> error("unsupported $v")
            },
        )
    }

    private val sid = "0f0e5b2a-6a1e-4c8b-9d3f-2b7c1a9e4d10"

    private fun player(t: Long, type: String, data: JsonObject? = null) =
        VitalsPlayerEvent(t = t, type = type, playerId = "p1", data = data)

    private val chunk = VitalsChunk(
        sessionId = sid, seq = 3,
        entries = listOf(
            VitalsSample(t = 1757000000000, cpu = 0.42, mem = 183500800, extras = mapOf("javaHeap" to 41943040.0, "nativeHeap" to 20971520.0)),
            VitalsSample(t = 1757000020000, mem = 190000000),
            player(1757000001000, "player_attach", obj("name" to "main", "tag" to "video", "library" to "media3", "libraryVersion" to "1.8.0")),
            player(1757000001100, "source_change", obj("src" to "https://cdn.example.com/live/master.m3u8", "protocol" to "hls", "mime" to "application/x-mpegURL", "live" to true)),
            player(1757000002400, "startup", obj("ttffMs" to 1300, "manifestMs" to 210, "firstFragmentMs" to 640)),
            player(1757000002400, "drm", obj("keySystem" to "widevine", "licenseMs" to 180)),
            player(1757000002500, "play"),
            player(1757000005000, "bitrate_change", obj("bitrate" to 2800000, "width" to 1280, "height" to 720, "reason" to "abr")),
            player(1757000009000, "buffer_start"),
            player(1757000009800, "buffer_end", obj("durationMs" to 800)),
            player(1757000012000, "seek", obj("fromMs" to 9800, "toMs" to 60000)),
            player(1757000013000, "rate_change", obj("rate" to 1.5)),
            player(1757000014000, "quality_change", obj("width" to 1920, "height" to 1080)),
            player(1757000020000, "stats", obj("bufferAheadMs" to 12400, "bandwidthEstimate" to 5200000, "bitrate" to 2800000, "width" to 1280, "height" to 720, "droppedFrames" to 2)),
            player(1757000021000, "error", obj("message" to "Source error", "code" to "ERROR_CODE_IO_NETWORK_CONNECTION_FAILED", "fatal" to false, "detail" to "cdn.example.com/live/seg-42.ts")),
            player(1757000022000, "pause"),
            player(1757000023000, "player_detach"),
            VitalsCustomEntry(t = 1757000015000, name = "ad_break", data = obj("position" to "midroll", "adCount" to 2), playerId = "p1"),
            VitalsCustomEntry(t = 1757000016000, name = "cdn_switch", data = obj("truncated" to true, "preview" to "{\"from\":\"cdn-a\""), truncated = true),
        ),
    )

    private val summary = SessionSummary(
        sessionId = sid, final = false, seq = 1, startedAt = 1757000000000, durationMs = 23000, playtimeMs = 19500,
        startupTimeMs = 1300, rebufferCount = 1, rebufferDurationMs = 800, bitrateMean = 2800000, errorCount = 1,
        memPeak = 190000000, memAvg = 186750400, playerCount = 1, playerCountSaturated = false,
        dims = SessionSummaryDims("android", "1.4.2", "0.8.0", "Pixel 8", "15"),
    )

    private val summaryNulls = SessionSummary(
        sessionId = "5a2d9c11-0b6e-4f7a-8c3d-1e2f3a4b5c6d", final = true, seq = 0, startedAt = 1757000000000,
        durationMs = 0, playtimeMs = 0, startupTimeMs = null, rebufferCount = 0, rebufferDurationMs = 0,
        bitrateMean = null, errorCount = 0, memPeak = 0, memAvg = 0, playerCount = 0, playerCountSaturated = false,
        dims = SessionSummaryDims("androidtv", "1.4.2", "0.8.0"),
    )

    @Test
    fun `chunk encodes to the canonical fixture`() =
        assertEquals(canonical(fixture.getValue("chunk")), canonical(VitalsWireCodec.encodePayload(chunk)))

    @Test
    fun `summary encodes to the canonical fixture`() =
        assertEquals(canonical(fixture.getValue("summary")), canonical(VitalsWireCodec.encodePayload(summary)))

    @Test
    fun `summary with nulls encodes to the canonical fixture`() =
        assertEquals(canonical(fixture.getValue("summaryNulls")), canonical(VitalsWireCodec.encodePayload(summaryNulls)))

    @Test
    fun `fixture decodes and re-encodes idempotently`() {
        for (key in listOf("chunk", "summary", "summaryNulls")) {
            val raw = fixture.getValue(key)
            val decoded = VitalsWireCodec.decodePayload(raw.toString())
            assertEquals(key, canonical(raw), canonical(VitalsWireCodec.encodePayload(decoded)))
        }
    }
}
