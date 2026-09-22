// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.config

import com.traceitx.config.ReplayConfigProvider.Companion.SDK_FEATURES_HEADER_VALUE
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class VitalsConfigWireTest {
    private val url = "https://traceitx.com/api/config"
    private fun response(code: Int, body: String): Response = Response.Builder()
        .request(Request.Builder().url(url).build()).protocol(Protocol.HTTP_1_1).code(code).message("OK")
        .body(body.toResponseBody("application/json".toMediaType())).build()
    private fun provider(fetcher: ConfigFetcher) = ReplayConfigProvider(configUrl = url, apiKey = "k", fetcher = fetcher, now = { 0L })
    private val base = """"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0"""

    @Test
    fun `header declares the vitals capability`() {
        assertTrue(SDK_FEATURES_HEADER_VALUE.split(",").map { it.trim() }.contains("vitals"))
    }

    @Test
    fun `vitals fields decode when present`() = runTest {
        val p = provider { response(200, """{$base,"vitalsEnabled":true,"vitalsSampleRate":0.5}""") }
        p.refresh()
        assertEquals(true, p.current.vitalsEnabled); assertEquals(0.5, p.current.vitalsSampleRate!!, 0.0)
    }

    @Test
    fun `vitals fields absent leaves them null and the rest of the config valid`() = runTest {
        val p = provider { response(200, """{$base}""") }
        assertTrue(p.refresh())
        assertNull(p.current.vitalsEnabled); assertNull(p.current.vitalsSampleRate)
    }

    @Test
    fun `a wrong-typed vitals field degrades that field alone`() = runTest {
        val p = provider { response(200, """{$base,"vitalsEnabled":"yes","vitalsSampleRate":"0.5"}""") }
        assertTrue(p.refresh())
        assertNull(p.current.vitalsEnabled); assertNull(p.current.vitalsSampleRate)
    }

    @Test
    fun `validator rejects an out-of-range local sample rate`() {
        val bad = TraceItXConfig(appId = "a", sdkKey = "k", vitals = VitalsConfig(sampleRate = 1.5))
        val err = runCatching { ConfigValidator.validate(bad) }.exceptionOrNull()
        assertTrue(err is TraceItXConfigError.InvalidVitalsSampleRate)
        ConfigValidator.validate(TraceItXConfig(appId = "a", sdkKey = "k", vitals = VitalsConfig(sampleRate = 0.0)))
    }
}
