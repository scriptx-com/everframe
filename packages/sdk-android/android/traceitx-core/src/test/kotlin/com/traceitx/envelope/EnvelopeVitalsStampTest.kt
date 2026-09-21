// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.envelope

import com.traceitx.vitals.VitalsStamp
import com.traceitx.vitals.wire.VitalsSample
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class EnvelopeVitalsStampTest {
    private fun envelopeJson(stamp: VitalsStamp?) =
        Json.parseToJsonElement(String(EnvelopeBuilder(vitalsStamp = { stamp }).buildEncoded(sdkVersion = "0.8.0").bytes, Charsets.UTF_8)).jsonObject

    @Test
    fun `stamps sessionId and payload vitals when a collector is running`() {
        val j = envelopeJson(VitalsStamp("sid-1", listOf(VitalsSample(t = 5, mem = 9))))
        assertEquals("sid-1", j["sessionId"]!!.jsonPrimitive.content)
        val v = j["payload"]!!.jsonObject["vitals"]!!.jsonArray
        assertEquals(1, v.size); assertEquals("sample", v[0].jsonObject["kind"]!!.jsonPrimitive.content)
        assertEquals("9", v[0].jsonObject["mem"]!!.jsonPrimitive.content.removeSuffix(".0"))
    }

    @Test
    fun `absent when no collector is running`() {
        val j = envelopeJson(null)
        assertFalse(j.containsKey("sessionId")); assertFalse(j["payload"]!!.jsonObject.containsKey("vitals"))
    }

    @Test
    fun `a throwing stamp provider degrades to no vitals, never a lost report`() {
        val j = Json.parseToJsonElement(String(EnvelopeBuilder(vitalsStamp = { error("x") }).buildEncoded(sdkVersion = "0.8.0").bytes, Charsets.UTF_8)).jsonObject
        assertFalse(j.containsKey("sessionId"))
    }

    @Test
    fun `caps at 400 entries, keeping the newest`() {
        val entries = (0 until 500).map { VitalsSample(t = it.toLong(), mem = it.toLong()) }
        val v = envelopeJson(VitalsStamp("s", entries))["payload"]!!.jsonObject["vitals"]!!.jsonArray
        assertEquals(400, v.size); assertEquals("499", v.last().jsonObject["t"]!!.jsonPrimitive.content.removeSuffix(".0"))
    }
}
