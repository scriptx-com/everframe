// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// RN vitals bridge parity (spec 2026-09-06 §5): drives RemotePlayerIntegration
// through the same call script as the Swift twin
// (RemotePlayerFixtureParityTests) via vitals-rn-bridge.v1.json.
//
// The fixture conventions, documented in the file's own `comment` field and
// implemented identically here and in Swift:
//   • `seedNow` is the clock injected into the integration, so the emissions it
//     ORIGINATES (attach/describe seeds, the spans detach() closes) carry a
//     deterministic `t` — codex round-1 C2 made those stamped rather than nil.
//     It is the STARTING value: a `clock` op moves it mid-scenario (codex
//     round-3 E1, which made a seed's instant a floor for later span
//     transitions, so one fixed clock could no longer say both "the seed came
//     before these forwarded events" and "the detach came after them").
//   • JSON cannot carry NaN, so the STRING "NaN" inside a `stats` object means
//     the double NaN and is translated when the stats map is built.
package dev.everframe.vitals

import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RemotePlayerFixtureParityTest {
    private class Ctx : PlayerIntegrationContext {
        val emitted = mutableListOf<JsonObject>()
        override fun emit(type: String, data: Map<String, Any?>?, t: Long?): Boolean {
            emitted += buildJsonObject {
                put("type", type)
                if (t != null) put("t", t)
                if (data != null) put("data", JsonCoerce.toJsonElement(data))
            }
            return true
        }
        override fun now() = 0L
    }

    private fun plain(e: JsonElement): Any? = when (e) {
        is JsonNull -> null
        is JsonPrimitive -> e.booleanOrNull ?: e.longOrNull?.let { it.toDouble() } ?: e.doubleOrNull ?: e.content
        is JsonObject -> e.mapValues { plain(it.value) }
        is JsonArray -> e.map { plain(it) }
    }

    /** The "NaN" string convention — see the header. */
    private fun statsMap(o: JsonObject): Map<String, Any?> =
        o.mapValues { (_, v) -> plain(v).let { if (it == "NaN") Double.NaN else it } }

    @Test fun `every fixture scenario emits exactly the expected calls`() {
        val root = Json.parseToJsonElement(javaClass.getResourceAsStream("/vitals-rn-bridge.v1.json")!!.bufferedReader().readText()).jsonObject
        val seedNow = root["seedNow"]!!.jsonPrimitive.long
        val scenarios = root["scenarios"]!!.jsonArray.map { it.jsonObject }
        assertTrue("fixture has no scenarios", scenarios.isNotEmpty())
        for (scenario in scenarios) {
            val name = scenario["name"]!!.jsonPrimitive.content
            val keep = scenario["keepQuery"]!!.jsonPrimitive.boolean
            var clock = seedNow
            val i = RemotePlayerIntegration("fixture", null, { keep }, { clock })
            val ctx = Ctx(); var snap: PlayerSnapshot? = null
            for (call in scenario["calls"]!!.jsonArray.map { it.jsonObject }) {
                val op = call["op"]!!.jsonPrimitive.content
                when (op) {
                    "clock" -> clock = call["t"]!!.jsonPrimitive.long
                    "attach" -> i.attach(ctx)
                    "describe" -> i.describe(ctx)
                    "detach" -> i.detach()
                    "record" -> i.record(call["type"]!!.jsonPrimitive.content, call["t"]!!.jsonPrimitive.long,
                        @Suppress("UNCHECKED_CAST") (call["data"]?.let { plain(it) } as Map<String, Any?>?))
                    "stats" -> i.updateStats(statsMap(call["stats"]!!.jsonObject))
                    "snapshot" -> i.snapshot { snap = it; true }
                    else -> error("unknown op '$op' in scenario '$name'")
                }
            }
            assertEquals(name, scenario["expect"]!!.jsonArray.map { plain(it) }, ctx.emitted.map { plain(it) })
            // `expectSnapshot: null` asserts there was NO snapshot this tick (an idle
            // integration, or one whose stats cache a source_change cleared); an object
            // asserts field by field, and an ABSENT expected field asserts a dropped one.
            scenario["expectSnapshot"]?.let { exp ->
                if (exp is JsonNull) { assertNull(name, snap); return@let }
                assertNotNull(name, snap)
                @Suppress("UNCHECKED_CAST") val e = plain(exp) as Map<String, Any?>
                assertEquals(name, (e["bufferAheadMs"] as Double?)?.toLong(), snap!!.bufferAheadMs)
                assertEquals(name, (e["bandwidthEstimate"] as Double?)?.toLong(), snap!!.bandwidthEstimate)
                assertEquals(name, (e["bitrate"] as Double?)?.toInt(), snap!!.bitrate)
                assertEquals(name, (e["width"] as Double?)?.toInt(), snap!!.width)
                assertEquals(name, (e["height"] as Double?)?.toInt(), snap!!.height)
                assertEquals(name, ((e["droppedFramesDelta"] as Double?) ?: 0.0).toInt(), snap!!.droppedFramesDelta)
            }
        }
    }
}
