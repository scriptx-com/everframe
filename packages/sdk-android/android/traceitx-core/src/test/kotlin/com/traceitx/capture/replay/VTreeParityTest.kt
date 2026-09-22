// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// VTREE-04 golden-fixture parity (Kotlin half).
//
// The single `vtree.v1-fixture.json` is the cross-SDK source of truth (TS,
// Swift, Kotlin, the Phase-25 player). Decode its `timeline` into the generated
// Kotlin `VTreeTimeline`, re-encode, and assert canonical (deep sorted-key) JSON
// equals the canonical fixture timeline — proving the Kotlin types accept the
// masked-bearing golden artifact and round-trip byte-equal. Mirrors
// VTreeProducerParityTests.swift.
package com.traceitx.capture.replay

import com.traceitx.protocol.generated.VOpAdd
import com.traceitx.protocol.generated.VTreeTimeline
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class VTreeParityTest {

    private val lenient = Json { ignoreUnknownKeys = true }
    private val strict = Json { ignoreUnknownKeys = false }

    /**
     * Deep-sort object keys so re-serialization is deterministic regardless of
     * insertion order. Arrays preserve order (children[] order is meaningful).
     * Mirrors the `canonicalize` helper in vtree.spec.ts / the Swift parity test.
     *
     * Numbers are normalized to their Double value so the fixture's integer
     * literals (`1`, `800`) compare equal to the Kotlin re-encode of the same
     * value through the generated `Double` fields (`1.0`, `800.0`). The Swift
     * parity test gets this for free via Foundation's NSNumber equality; on the
     * Kotlin half the type is always `Double`, so we canonicalize the literal
     * here. The semantic content is identical — this is purely numeric formatting.
     */
    private fun canonicalize(value: JsonElement): JsonElement = when (value) {
        is JsonObject -> buildJsonObject {
            for (k in value.keys.sorted()) {
                put(k, canonicalize(value.getValue(k)))
            }
        }
        is JsonArray -> JsonArray(value.map { canonicalize(it) })
        is JsonPrimitive -> {
            // Normalize numeric primitives to their Double string so 1 == 1.0.
            val asDouble = if (value.isString) null else value.content.toDoubleOrNull()
            if (asDouble != null) JsonPrimitive(asDouble) else value
        }
        else -> value
    }

    /** Load the bundled fixture's `timeline` object as a JsonElement. */
    private fun loadFixtureTimeline(): JsonElement {
        val raw = javaClass.getResourceAsStream("/vtree.v1-fixture.json")
            ?.bufferedReader()?.use { it.readText() }
            ?: error("vtree.v1-fixture.json must be bundled as a test resource")
        val obj = lenient.parseToJsonElement(raw) as JsonObject
        return obj.getValue("timeline")
    }

    @Test
    fun `golden timeline decodes into VTreeTimeline`() {
        val timelineJson = loadFixtureTimeline()
        val timeline = strict.decodeFromJsonElement(VTreeTimeline.serializer(), timelineJson)

        assertEquals("traceitx-vtree-v1", timeline.version)
        assertTrue(timeline.frames.isNotEmpty())
        // frame 0 must be a single add at the root sentinel.
        val firstOp = timeline.frames[0].ops[0]
        assertTrue("frame-0 op must be an add", firstOp is VOpAdd)
        assertEquals("", (firstOp as VOpAdd).parent)
    }

    @Test
    fun `golden timeline round-trips canonical-equal`() {
        val timelineJson = loadFixtureTimeline()
        val timeline = strict.decodeFromJsonElement(VTreeTimeline.serializer(), timelineJson)
        val reencoded = strict.encodeToJsonElement(VTreeTimeline.serializer(), timeline)

        assertEquals(
            "Kotlin decode→encode of the golden timeline must be canonical-equal to the fixture",
            canonicalize(timelineJson),
            canonicalize(reencoded),
        )
    }

    @Test
    fun `golden timeline carries the masked node with no text`() {
        val timelineJson = loadFixtureTimeline()
        val timeline = strict.decodeFromJsonElement(VTreeTimeline.serializer(), timelineJson)

        val rootAdd = timeline.frames[0].ops[0] as VOpAdd
        val masked = findMasked(rootAdd.node)
            ?: error("fixture must carry a masked node")
        assertEquals(true, masked.masked)
        assertNull("masked node must carry no text (PII invariant)", masked.text)
    }

    private fun findMasked(node: com.traceitx.protocol.generated.VNode): com.traceitx.protocol.generated.VNode? {
        if (node.masked == true) return node
        for (c in node.children) findMasked(c)?.let { return it }
        return null
    }
}
