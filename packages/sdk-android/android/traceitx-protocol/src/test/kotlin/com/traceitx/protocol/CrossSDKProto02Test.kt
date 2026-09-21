// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// PROTO-02 cross-SDK fixture parity — Kotlin side of the three-decoder gate
// (Plan 06-06 Task 3). Decodes the same `v1-cross-sdk-proto-02.json` via the
// regenerated quicktype `ReportEnvelope` (Plan 06-06 Task 2 added `reactTree`),
// re-encodes canonically (sorted keys via JsonElement traversal — kotlinx
// preserves insertion order by default), and asserts idempotent round-trip.
//
// Test framework: JUnit 4 (matches the version catalog `libs.versions.toml`
// and the existing :traceitx-* test modules).
package com.traceitx.protocol

import com.traceitx.protocol.generated.ReportEnvelope
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.long
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class CrossSDKProto02Test {

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    private fun fixtureBytes(): String {
        return javaClass.getResourceAsStream("/v1-cross-sdk-proto-02.json")!!
            .bufferedReader()
            .use { it.readText() }
    }

    /** Deep-sort JsonObject keys so encoding is deterministic. */
    private fun canonicalize(el: JsonElement): JsonElement = when (el) {
        is JsonObject -> buildJsonObject {
            for (k in el.keys.sorted()) {
                put(k, canonicalize(el.getValue(k)))
            }
        }
        is JsonArray -> buildJsonArray {
            el.forEach { add(canonicalize(it)) }
        }
        is JsonPrimitive -> el
    }

    @Test
    fun crossSDKFixture_decodesAndReencodesIdempotently() {
        val raw = fixtureBytes()

        // Decode via the regenerated kotlinx-serialization data class.
        val env: ReportEnvelope = json.decodeFromString(raw)

        // Re-encode and canonicalize.
        val firstEncoded = json.encodeToString(env)
        val firstCanonical = canonicalize(json.parseToJsonElement(firstEncoded))

        // Second pass — decode our own output and re-encode.
        val env2: ReportEnvelope = json.decodeFromString(firstEncoded)
        val secondEncoded = json.encodeToString(env2)
        val secondCanonical = canonicalize(json.parseToJsonElement(secondEncoded))

        assertEquals(
            "Round-trip canonicalized JSON must be byte-identical",
            firstCanonical.toString(),
            secondCanonical.toString()
        )
    }

    @Test
    fun crossSDKFixture_omitsRetiredPayloadFields() {
        val env: ReportEnvelope = json.decodeFromString(fixtureBytes())
        val payload = json.parseToJsonElement(json.encodeToString(env)).jsonObject.getValue("payload").jsonObject
        for (field in listOf("uiTree", "reactTree", "reportTarget")) {
            assertTrue("Retired payload field must not be re-encoded: $field", field !in payload)
        }
    }

    /**
     * The fixture's `payload.breadcrumbs` (Task 16 — cross-SDK breadcrumb
     * gate) MUST decode with exactly 2 entries, and the trim marker's
     * `data.droppedCount` MUST decode as a numeric [JsonPrimitive] (not a
     * string) — this is the exact cross-language type-fidelity risk the
     * gate exists to catch.
     */
    @Test
    fun crossSDKFixture_preservesBreadcrumbsWithNumericDroppedCount() {
        val env: ReportEnvelope = json.decodeFromString(fixtureBytes())
        assertEquals(true, env.captures.breadcrumbs)

        val crumbs = env.payload.breadcrumbs
        assertNotNull("payload.breadcrumbs must decode", crumbs)
        assertEquals(2, crumbs!!.size)

        val normal = crumbs[0]
        assertEquals(com.traceitx.protocol.generated.BreadcrumbKind.Tap, normal.kind)
        assertNull("non-marker crumb must not carry droppedCount", normal.data?.get("droppedCount"))

        val marker = crumbs[1]
        assertEquals(com.traceitx.protocol.generated.BreadcrumbKind.Tap, marker.kind)
        assertEquals(com.traceitx.protocol.generated.Level.Info, marker.level)
        assertEquals("+3 tap hidden", marker.message)
        val droppedCount = marker.data?.get("droppedCount") as? JsonPrimitive
        assertNotNull("marker.data.droppedCount must be a JsonPrimitive", droppedCount)
        assertFalse("droppedCount must decode as numeric, not string", droppedCount!!.isString)
        assertEquals(3L, droppedCount.long)
    }
}
