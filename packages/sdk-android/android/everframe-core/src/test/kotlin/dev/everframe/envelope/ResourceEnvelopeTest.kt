// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Report Resource Window (spec 2026-09-05), Task 13 — `payload.resources`
// envelope emission. Mirrors NetworkBodyEnvelopeTest's style: bare
// EnvelopeBuilder.buildEncoded() calls, parsed back via kotlinx.serialization
// (Json.parseToJsonElement) rather than org.json — this suite doesn't use
// org.json anywhere else, so `buildMinimalEnvelopeJson` below returns a
// kotlinx JsonObject instead of the brief's org.json JSONObject shape;
// assertions below are semantically identical to the brief's test cases.
package dev.everframe.envelope

import dev.everframe.capture.ResourceRingBuffer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class ResourceEnvelopeTest {

    private fun buildMinimalEnvelopeJson(resources: List<ResourceRingBuffer.Entry>): JsonObject {
        val encoded = EnvelopeBuilder().buildEncoded(
            sdkVersion = "t",
            resources = resources,
        )
        return Json.parseToJsonElement(encoded.bytes.decodeToString()).jsonObject
    }

    @Test fun `omits resources when empty`() {
        val json = buildMinimalEnvelopeJson(resources = emptyList())
        assertFalse(json["payload"]!!.jsonObject.containsKey("resources"))
    }

    @Test fun `includes resources when present`() {
        val json = buildMinimalEnvelopeJson(
            resources = listOf(ResourceRingBuffer.Entry(1, 0.5, 1024)),
        )
        val arr = json["payload"]!!.jsonObject["resources"]!!.jsonArray
        assertEquals(1, arr.size)
        assertEquals(1024.0, arr[0].jsonObject["mem"]!!.jsonPrimitive.double, 0.0)
    }

    // Omitted, not null — an explicit null fails schema validation and drops
    // the WHOLE report.
    @Test fun `omits the cpu key entirely when null`() {
        val json = buildMinimalEnvelopeJson(
            resources = listOf(ResourceRingBuffer.Entry(1, null, 8)),
        )
        val obj = json["payload"]!!.jsonObject["resources"]!!.jsonArray[0].jsonObject
        assertFalse(obj.containsKey("cpu"))
    }

    @Test fun `caps at MAX_SAMPLES keeping the newest`() {
        val entries = (0 until ResourceRingBuffer.MAX_SAMPLES + 10)
            .map { ResourceRingBuffer.Entry(it.toLong(), null, it.toLong()) }
        val arr = buildMinimalEnvelopeJson(resources = entries)
            .get("payload")!!.jsonObject["resources"]!!.jsonArray
        assertEquals(ResourceRingBuffer.MAX_SAMPLES, arr.size)
        assertEquals(
            (ResourceRingBuffer.MAX_SAMPLES + 9).toDouble(),
            arr[arr.size - 1].jsonObject["mem"]!!.jsonPrimitive.double,
            0.0,
        )
    }
}
