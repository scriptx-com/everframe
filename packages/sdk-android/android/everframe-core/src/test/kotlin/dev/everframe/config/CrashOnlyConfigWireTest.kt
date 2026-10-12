// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.config

import dev.everframe.config.ReplayConfigProvider.Companion.SDK_FEATURES_HEADER_VALUE
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

/** Crash-only sessions (spec 2026-10-12): the `crashOnlySamplingRate` field and its `crashonly` token. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CrashOnlyConfigWireTest {
    private val url = "https://everframe.dev/api/config"
    private fun response(body: String): Response = Response.Builder()
        .request(Request.Builder().url(url).build()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
        .body(body.toResponseBody("application/json".toMediaType())).build()
    private fun provider(body: String) =
        ReplayConfigProvider(configUrl = url, sdkKey = "k", fetcher = { response(body) }, now = { 0L })
    private val base = """"replayEnabled":true,"replayDurationSec":30,"samplingRate":0.5"""

    @Test
    fun `header declares the crashonly capability`() {
        // The server sends the field only to this token: an older SDK's strict decoder would reject it.
        assertTrue(SDK_FEATURES_HEADER_VALUE.split(",").map { it.trim() }.contains("crashonly"))
    }

    @Test
    fun `the crash-only rate decodes beside the report rate`() = runTest {
        val p = provider("""{$base,"crashOnlySamplingRate":0.05}""")
        assertTrue(p.refresh())
        assertEquals(0.05, p.current.crashOnlySamplingRate!!, 0.0)
        assertEquals(0.5, p.current.samplingRate, 0.0)
    }

    @Test
    fun `an older server that sends no crash-only rate leaves it null`() = runTest {
        val p = provider("""{$base}""")
        assertTrue(p.refresh())
        assertNull(p.current.crashOnlySamplingRate)
        assertTrue(p.current.replayEnabled)
    }

    @Test
    fun `an out-of-range or wrong-typed crash-only rate degrades that field alone`() = runTest {
        for (bad in listOf("1.5", "-0.1", "\"0.5\"", "true", "null")) {
            val p = provider("""{$base,"crashOnlySamplingRate":$bad}""")
            assertTrue("$bad must not fail the whole config", p.refresh())
            assertNull(bad, p.current.crashOnlySamplingRate)
            assertEquals(0.5, p.current.samplingRate, 0.0)
        }
    }

    @Test
    fun `the bounds themselves are valid rates`() = runTest {
        for (rate in listOf(0.0, 1.0)) {
            val p = provider("""{$base,"crashOnlySamplingRate":$rate}""")
            assertTrue(p.refresh())
            assertEquals(rate, p.current.crashOnlySamplingRate!!, 0.0)
        }
    }
}
