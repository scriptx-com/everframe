// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Plan 06.2-08 Task 1 — `v1-relay-fixture.json` round-trip parity against
// the codegen `RelayMessage` sealed class (Plan 06.2-03 output:
// `traceitx-protocol/.../generated/Relay.kt`).
//
// Why decode→re-encode→decode (and not "compare to fixture text"):
//   The fixture has integer JSON literals (`"strokeWidth": 4`,
//   `"points": [[10, 20], …]`). Codegen types these as `Double`. The
//   kotlinx-serialization encoder emits `4.0` / `10.0`, so a
//   JsonElement comparison against the fixture bytes would spuriously
//   fail on a value-preserving numeric round-trip. We instead assert
//   that the data class graph is stable: decode(fixture) ==
//   decode(encode(decode(fixture))). That's the property the SDK
//   actually relies on.
//
// Test framework: JUnit 4 — matches the existing `CrossSDKProto02Test`
// pattern in the same module.

package com.traceitx.protocol

import com.traceitx.protocol.generated.PairBonded
import com.traceitx.protocol.generated.PairCreated
import com.traceitx.protocol.generated.PairExpired
import com.traceitx.protocol.generated.RelayMessage
import com.traceitx.protocol.generated.ReportAssembled
import com.traceitx.protocol.generated.ReportCompleted
import com.traceitx.protocol.generated.ReportDraftUpdate
import com.traceitx.protocol.generated.ReportFailed
import com.traceitx.protocol.generated.ReportRejected
import com.traceitx.protocol.generated.ReportRequest
import com.traceitx.protocol.generated.ReportSubmit
import com.traceitx.protocol.generated.ReportSubmitAnnotationBlur
import com.traceitx.protocol.generated.ReportSubmitAnnotationStroke
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayMessageRoundtripTest {

    /**
     * `ignoreUnknownKeys = false` — the SDK must reject forward-incompatible
     * frames loudly; the relay/contract owns version negotiation, not
     * silent field drop. Note: `@JsonClassDiscriminator("type")` is set
     * on the sealed class itself, so `classDiscriminator` here is
     * redundant for `RelayMessage` but harmless.
     */
    private val json = Json {
        ignoreUnknownKeys = false
        encodeDefaults = false
        classDiscriminator = "type"
    }

    private fun fixtureRoot(): JsonObject {
        val raw = javaClass.getResourceAsStream("/v1-relay-fixture.json")!!
            .bufferedReader()
            .use { it.readText() }
        return json.parseToJsonElement(raw).jsonObject
    }

    @Test
    fun everyFixtureMessageRoundtripsViaCodegen() {
        val messages = fixtureRoot()["messages"]!!.jsonArray
        assertTrue("fixture must contain >=1 messages", messages.isNotEmpty())

        for ((i, element) in messages.withIndex()) {
            val original = element.toString()
            val decoded: RelayMessage = json.decodeFromString(RelayMessage.serializer(), original)
            val reencoded = json.encodeToString(RelayMessage.serializer(), decoded)
            val redecoded: RelayMessage = json.decodeFromString(RelayMessage.serializer(), reencoded)
            assertEquals(
                "message[$i] (${element.jsonObject["type"]}) must equal itself after one encode/decode cycle",
                decoded,
                redecoded,
            )
        }
    }

    @Test
    fun pairCreated_decodesPairToken() {
        val raw = """{"type":"pair.created","pair_id":"pair_abc","pair_token":"tok_xyz"}"""
        val msg = json.decodeFromString(RelayMessage.serializer(), raw)
        assertTrue("expected PairCreated, got=${msg::class.simpleName}", msg is PairCreated)
        msg as PairCreated
        assertEquals("pair_abc", msg.pairId)
        assertEquals("tok_xyz", msg.pairToken)
    }

    @Test
    fun pairBonded_decodesDeviceToken() {
        val raw = """{"type":"pair.bonded","pair_id":"pair_abc",
            |"device_token":"dev_xyz",
            |"device_token_expires_at":"2026-06-01T00:00:00.000Z"}""".trimMargin().replace("\n", "")
        val msg = json.decodeFromString(RelayMessage.serializer(), raw)
        assertTrue(msg is PairBonded)
        msg as PairBonded
        assertEquals("dev_xyz", msg.deviceToken)
    }

    @Test
    fun pairExpired_decodesReason() {
        val raw = """{"type":"pair.expired","pair_id":"pair_abc","reason":"inactivity"}"""
        val msg = json.decodeFromString(RelayMessage.serializer(), raw)
        assertTrue(msg is PairExpired)
        assertEquals("inactivity", (msg as PairExpired).reason)
    }

    @Test
    fun reportRequest_decodes() {
        val raw = """{"type":"report.request","correlation_id":"corr_001"}"""
        val msg = json.decodeFromString(RelayMessage.serializer(), raw)
        assertTrue(msg is ReportRequest)
        assertEquals("corr_001", (msg as ReportRequest).correlationId)
    }

    @Test
    fun reportAssembled_decodesCountsAndToggles() {
        val raw = """{"type":"report.assembled","correlation_id":"corr_001",
            |"mime":"image/png","size":123,
            |"toggles":{"logs":true,"network":true,"uiTree":true,"metadata":true,"screenshot":true},
            |"counts":{"logs":12,"network":5,"uiTreeNodes":87}}""".trimMargin().replace("\n", "")
        val msg = json.decodeFromString(RelayMessage.serializer(), raw)
        assertTrue(msg is ReportAssembled)
        msg as ReportAssembled
        assertEquals(12L, msg.counts.logs)
        assertEquals(87L, msg.counts.uiTreeNodes)
        assertTrue(msg.toggles.screenshot)
    }

    @Test
    fun reportSubmit_decodesAnnotationsByKindDiscriminator() {
        // `ReportSubmitAnnotation` has its own `@JsonClassDiscriminator("kind")`;
        // ensure the nested discriminator routes correctly.
        val raw = """{"type":"report.submit","correlation_id":"corr_001",
            |"title":"t","description":{"text":"d","redactions":[]},
            |"includes":{"logs":true,"network":true,"uiTree":false,"metadata":true,"screenshot":true},
            |"annotations":[
            |  {"kind":"stroke","points":[[1,2],[3,4]],"color":"#ff0000","strokeWidth":4},
            |  {"kind":"blur","rect":{"x":1,"y":2,"w":3,"h":4}}
            |]}""".trimMargin().replace("\n", "")
        val msg = json.decodeFromString(RelayMessage.serializer(), raw)
        assertTrue(msg is ReportSubmit)
        msg as ReportSubmit
        assertEquals(2, msg.annotations.size)
        assertTrue(msg.annotations[0] is ReportSubmitAnnotationStroke)
        assertTrue(msg.annotations[1] is ReportSubmitAnnotationBlur)
    }

    @Test
    fun reportDraftUpdate_decodesPartialDescription() {
        val raw = """{"type":"report.draft.update","correlation_id":"corr_001",
            |"title":"t","description_partial":{"text":"hello","redactions":[{"start":0,"end":3}]}}"""
            .trimMargin().replace("\n", "")
        val msg = json.decodeFromString(RelayMessage.serializer(), raw)
        assertTrue(msg is ReportDraftUpdate)
        msg as ReportDraftUpdate
        assertNotNull(msg.descriptionPartial)
        assertEquals(1, msg.descriptionPartial!!.redactions.size)
    }

    @Test
    fun reportCompleted_decodes() {
        val raw = """{"type":"report.completed","correlation_id":"corr_001","event_id":"evt_001"}"""
        val msg = json.decodeFromString(RelayMessage.serializer(), raw)
        assertTrue(msg is ReportCompleted)
        assertEquals("evt_001", (msg as ReportCompleted).eventId)
    }

    @Test
    fun reportFailed_decodes() {
        val raw = """{"type":"report.failed","correlation_id":"corr_001","reason":"upstream_5xx"}"""
        val msg = json.decodeFromString(RelayMessage.serializer(), raw)
        assertTrue(msg is ReportFailed)
        assertEquals("upstream_5xx", (msg as ReportFailed).reason)
    }

    @Test
    fun reportRejected_decodes() {
        val raw = """{"type":"report.rejected","reason":"in_flight"}"""
        val msg = json.decodeFromString(RelayMessage.serializer(), raw)
        assertTrue(msg is ReportRejected)
        assertEquals("in_flight", (msg as ReportRejected).reason)
    }
}
