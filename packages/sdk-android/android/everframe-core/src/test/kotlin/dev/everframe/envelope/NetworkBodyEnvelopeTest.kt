// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Task 15 — `payload.networkBodies` envelope emission + protocol fixture
// parity. Mirrors EnvelopeBuilderTest's breadcrumb-integration tests
// (lines 210-299) in style: bare `NetworkBody` construction, round-trip via
// the generated `ReportEnvelope` serializer, and captureControl.included
// marker assertions.
package dev.everframe.envelope

import androidx.test.core.app.ApplicationProvider
import dev.everframe.Everframe
import dev.everframe.protocol.generated.Breadcrumb
import dev.everframe.protocol.generated.BreadcrumbKind
import dev.everframe.protocol.generated.Level
import dev.everframe.protocol.generated.NetworkBody
import dev.everframe.shared.SharedData
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class NetworkBodyEnvelopeTest {

    @Before
    fun setUp() {
        SharedData.init(ApplicationProvider.getApplicationContext())
    }

    private fun entry(ref: Int): NetworkBody = NetworkBody(
        ref = ref.toDouble(),
        t = ref.toDouble(),
        reqBody = "req-$ref",
        resBody = "res-$ref",
    )

    /**
     * A shipped `network` crumb carrying `data.reqId` — the encode-boundary
     * linkage filter (F14) only lets a body through when one of these exists
     * for its `ref` in the FINAL trimmed breadcrumb chain.
     */
    private fun networkCrumb(reqId: Int, seq: Int, t: Double = 1_700_000_000_000.0): Breadcrumb = Breadcrumb(
        data = JsonObject(mapOf("reqId" to JsonPrimitive(reqId))),
        kind = BreadcrumbKind.Network,
        level = Level.Info,
        message = "GET https://example.com $reqId",
        seq = seq.toLong(),
        t = t,
    )

    @Test
    fun `envelope emits bodies and included marker`() {
        val builder = EnvelopeBuilder()
        val crumbs = listOf(networkCrumb(reqId = 1, seq = 0), networkCrumb(reqId = 2, seq = 1))
        val encoded = builder.buildEncoded(
            sdkVersion = "t", networkBodies = listOf(entry(1), entry(2)), breadcrumbs = crumbs,
        )
        val json = Json.parseToJsonElement(encoded.bytes.decodeToString()).jsonObject
        assertEquals(2, json["payload"]!!.jsonObject["networkBodies"]!!.jsonArray.size)
        assertTrue(
            json["captureControl"]!!.jsonObject["included"]!!.jsonArray
                .map { it.jsonPrimitive.content }.contains("networkBodies")
        )
    }

    @Test
    fun `no bodies - channel and marker absent`() {
        val builder = EnvelopeBuilder()

        val encodedNull = builder.buildEncoded(sdkVersion = "t", networkBodies = null)
        val jsonNull = Json.parseToJsonElement(encodedNull.bytes.decodeToString()).jsonObject
        assertNull("payload.networkBodies must be absent when null", jsonNull["payload"]!!.jsonObject["networkBodies"])
        assertTrue(
            "captureControl.included must not list networkBodies",
            !jsonNull["captureControl"]!!.jsonObject["included"]!!.jsonArray
                .map { it.jsonPrimitive.content }.contains("networkBodies")
        )

        val encodedEmpty = builder.buildEncoded(sdkVersion = "t", networkBodies = emptyList())
        val jsonEmpty = Json.parseToJsonElement(encodedEmpty.bytes.decodeToString()).jsonObject
        assertNull("payload.networkBodies must be absent when empty", jsonEmpty["payload"]!!.jsonObject["networkBodies"])
        assertTrue(
            "captureControl.included must not list networkBodies",
            !jsonEmpty["captureControl"]!!.jsonObject["included"]!!.jsonArray
                .map { it.jsonPrimitive.content }.contains("networkBodies")
        )
    }

    // ==================== F14: crumb↔body linkage (spec §11 test 8) ====================

    @Test
    fun `no breadcrumbs - bodies present - networkBodies absent and no marker`() {
        val builder = EnvelopeBuilder()
        val encoded = builder.buildEncoded(
            sdkVersion = "t", networkBodies = listOf(entry(1), entry(2)), breadcrumbs = null,
        )
        val json = Json.parseToJsonElement(encoded.bytes.decodeToString()).jsonObject
        assertNull("payload.networkBodies must be absent with no breadcrumbs", json["payload"]!!.jsonObject["networkBodies"])
        assertTrue(
            "captureControl.included must not list networkBodies",
            !json["captureControl"]!!.jsonObject["included"]!!.jsonArray
                .map { it.jsonPrimitive.content }.contains("networkBodies")
        )
    }

    @Test
    fun `breadcrumbs without network kind - bodies present - networkBodies absent`() {
        val builder = EnvelopeBuilder()
        val nonNetworkCrumb = Breadcrumb(
            data = null, kind = BreadcrumbKind.Console, level = Level.Info,
            message = "log line", seq = 0L, t = 1.0,
        )
        val encoded = builder.buildEncoded(
            sdkVersion = "t", networkBodies = listOf(entry(1)), breadcrumbs = listOf(nonNetworkCrumb),
        )
        val json = Json.parseToJsonElement(encoded.bytes.decodeToString()).jsonObject
        assertNull("payload.networkBodies must be absent - no network crumb", json["payload"]!!.jsonObject["networkBodies"])
        assertTrue(
            "captureControl.included must not list networkBodies",
            !json["captureControl"]!!.jsonObject["included"]!!.jsonArray
                .map { it.jsonPrimitive.content }.contains("networkBodies")
        )
    }

    @Test
    fun `partial crumb match - only matching bodies encode - orphan dropped`() {
        val builder = EnvelopeBuilder()
        val entries = listOf(entry(1), entry(2), entry(3))
        val crumbs = listOf(networkCrumb(reqId = 1, seq = 0), networkCrumb(reqId = 2, seq = 1))
        val encoded = builder.buildEncoded(sdkVersion = "t", networkBodies = entries, breadcrumbs = crumbs)
        val json = Json.parseToJsonElement(encoded.bytes.decodeToString()).jsonObject
        val shippedBodies = json["payload"]!!.jsonObject["networkBodies"]!!.jsonArray
        assertEquals(2, shippedBodies.size)
        val shippedRefs = shippedBodies.map { it.jsonObject["ref"]!!.jsonPrimitive.double }.toSet()
        assertEquals(setOf(1.0, 2.0), shippedRefs)
        assertTrue(
            json["captureControl"]!!.jsonObject["included"]!!.jsonArray
                .map { it.jsonPrimitive.content }.contains("networkBodies")
        )
    }

    @Test
    fun `every body matched - all encode and invariant holds`() {
        val builder = EnvelopeBuilder()
        val entries = listOf(entry(10), entry(20), entry(30))
        val crumbs = listOf(
            networkCrumb(reqId = 10, seq = 0), networkCrumb(reqId = 20, seq = 1), networkCrumb(reqId = 30, seq = 2),
        )
        val encoded = builder.buildEncoded(sdkVersion = "t", networkBodies = entries, breadcrumbs = crumbs)
        val shippedBodies = encoded.envelope.payload.networkBodies
        assertEquals(3, shippedBodies?.size)
        assertTrue(encoded.envelope.captureControl.included.contains("networkBodies"))

        // Invariant: every shipped ref matches EXACTLY ONE shipped network
        // crumb's data.reqId.
        val shippedNetworkReqIds = encoded.envelope.payload.breadcrumbs
            ?.filter { it.kind == BreadcrumbKind.Network }
            ?.mapNotNull { (it.data?.get("reqId") as? JsonPrimitive)?.content?.toDoubleOrNull() }
            .orEmpty()
        shippedBodies?.forEach { body ->
            val matches = shippedNetworkReqIds.filter { it == body.ref }
            assertEquals("ref ${body.ref} must match exactly one shipped network crumb reqId", 1, matches.size)
        }
    }

    // ==================== Task 6: interceptor-producer linkage (spec §13 items 9/10) ====================

    /**
     * Spec §13 item 9. The interceptor mints a `reqId` and correlates a
     * `NetworkBody.ref` to it only through the SHIPPED crumb chain — a body
     * whose `ref` never matches any shipped crumb's `data.reqId` (e.g. the
     * crumb itself was trimmed for byte budget, or capture raced a config
     * change) must never reach the wire. This is the interceptor's own
     * failure mode: `EnvelopeBuilder.kt:342`'s filter is what makes that
     * safe.
     */
    @Test
    fun `body without a shipped crumb is dropped`() {
        val builder = EnvelopeBuilder()
        val crumbs = listOf(networkCrumb(reqId = 1, seq = 0))
        val encoded = builder.buildEncoded(
            sdkVersion = "t",
            networkBodies = listOf(entry(1), entry(404)),
            breadcrumbs = crumbs,
        )
        val json = Json.parseToJsonElement(encoded.bytes.decodeToString()).jsonObject
        val shippedBodies = json["payload"]!!.jsonObject["networkBodies"]!!.jsonArray
        assertEquals(1, shippedBodies.size)
        assertEquals(1.0, shippedBodies[0].jsonObject["ref"]!!.jsonPrimitive.double, 0.0)
    }

    /**
     * Spec §6 — Android-specific: a crumb's `reqId` means "a body entry MAY
     * exist for this request", not "one does". The interceptor mints the
     * reqId and writes the crumb the instant `proceed()` returns, well
     * before the app has finished reading (or possibly ever reads) the teed
     * body, so a crumb can legitimately ship with no corresponding body ever
     * arriving. That must encode without error and the crumb must survive
     * intact — the filter at `EnvelopeBuilder.kt:342` only ever drops
     * bodies lacking a crumb, never the reverse.
     */
    @Test
    fun `dangling crumb reqId with no matching body encodes without error`() {
        val builder = EnvelopeBuilder()
        val crumbs = listOf(networkCrumb(reqId = 99, seq = 0))
        val encoded = builder.buildEncoded(sdkVersion = "t", networkBodies = null, breadcrumbs = crumbs)
        val json = Json.parseToJsonElement(encoded.bytes.decodeToString()).jsonObject
        assertNull("payload.networkBodies must be absent — no bodies were shipped", json["payload"]!!.jsonObject["networkBodies"])

        val shippedCrumbs = encoded.envelope.payload.breadcrumbs
        assertEquals(1, shippedCrumbs?.size)
        val crumb = shippedCrumbs!!.single()
        assertEquals(BreadcrumbKind.Network, crumb.kind)
        assertEquals(99.0, (crumb.data?.get("reqId") as JsonPrimitive).content.toDouble(), 0.0)
    }

    @Test
    fun `parity fixture decodes and round-trips through the generated type`() {
        val raw = javaClass.getResourceAsStream("/network-bodies.v1.json")!!
            .bufferedReader().use { it.readText() }
        val entries = Json { ignoreUnknownKeys = false }
            .decodeFromString(ListSerializer(NetworkBody.serializer()), raw)
        assertTrue(entries.size >= 4)
        val reencoded = Json.encodeToString(ListSerializer(NetworkBody.serializer()), entries)

        // `ref`/`t` are generated as Double (Task 1 codegen — out of scope to
        // change here); the fixture writes them as plain integer literals
        // ("1", "1721304000000"), but Kotlin's default Double formatting
        // re-encodes large values in scientific notation ("1.721304E12").
        // canonicalize() normalizes numeric JsonPrimitives to their Double
        // value on BOTH sides before comparing, so formatting differences
        // wash out and only semantic content is asserted — mirrors
        // VTreeParityTest.kt's `canonicalize` (same Double-vs-int-literal
        // issue, same fix).
        assertEquals(canonicalize(Json.parseToJsonElement(raw)), canonicalize(Json.parseToJsonElement(reencoded)))
    }

    private fun canonicalize(value: JsonElement): JsonElement = when (value) {
        is JsonObject -> buildJsonObject {
            for (k in value.keys.sorted()) {
                put(k, canonicalize(value.getValue(k)))
            }
        }
        is JsonArray -> JsonArray(value.map { canonicalize(it) })
        is JsonPrimitive -> {
            val asDouble = if (value.isString) null else value.content.toDoubleOrNull()
            if (asDouble != null) JsonPrimitive(asDouble) else value
        }
        else -> value
    }
}
