// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// `quickCapture` is written to the envelope only for a simulator quick capture.
// Every other envelope must have no `quickCapture` key at all (absent, not
// null or false), so normal reports stay byte-identical on the wire.
package dev.everframe.envelope

import dev.everframe.protocol.generated.ReportEnvelope
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class EnvelopeQuickCaptureTest {

    private fun root(quickCapture: Boolean?) = Json.parseToJsonElement(
        (if (quickCapture == null) EnvelopeBuilder().buildEncoded(sdkVersion = "1.0.0", formFactor = "phone")
        else EnvelopeBuilder().buildEncoded(sdkVersion = "1.0.0", formFactor = "phone", quickCapture = quickCapture))
            .bytes.decodeToString(),
    ).jsonObject

    @Test
    fun `quickCapture true is written to the envelope`() {
        val json = root(true)
        assertEquals("true", json["quickCapture"]?.jsonPrimitive?.content)
        val decoded = Json { ignoreUnknownKeys = true }.decodeFromString<ReportEnvelope>(
            EnvelopeBuilder().buildEncoded(sdkVersion = "1.0.0", formFactor = "phone", quickCapture = true).bytes.decodeToString(),
        )
        assertEquals(true, decoded.quickCapture)
    }

    @Test
    fun `quickCapture is omitted by default - the key is absent from the JSON`() {
        assertFalse(root(null).containsKey("quickCapture"))
    }

    @Test
    fun `quickCapture false is also omitted`() {
        assertFalse(root(false).containsKey("quickCapture"))
        assertTrue(root(false).containsKey("reportId"))
    }
}
