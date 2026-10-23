// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Real-device quick capture: the `devicelinking` capability, the lenient
// `deviceLinking` block, and the device token on `GET /api/config`. Tokens are
// compared, never printed.
package dev.everframe.config

import dev.everframe.devicelink.DeviceLinkOwner
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
class DeviceLinkingConfigTest {
    private val url = "https://everframe.dev/api/config"
    private val deviceToken = "evf_dev_" + "Zq9x".repeat(8)

    private fun response(body: String): Response = Response.Builder()
        .request(Request.Builder().url(url).build())
        .protocol(Protocol.HTTP_1_1)
        .code(200)
        .message("OK")
        .body(body.toResponseBody("application/json".toMediaType()))
        .build()

    private fun body(block: String?, replayEnabled: Boolean = false) =
        """{"replayEnabled":$replayEnabled,"replayDurationSec":30,"samplingRate":1.0""" +
            (if (block != null) ""","deviceLinking":$block""" else "") + "}"

    private suspend fun decode(block: String?, replayEnabled: Boolean = false): ReplayConfig {
        val p = ReplayConfigProvider(configUrl = url, sdkKey = "k", fetcher = { response(body(block, replayEnabled)) })
        assertTrue(p.refresh())
        return p.current
    }

    @Test
    fun `devicelinking is declared`() {
        assertTrue(ReplayConfigProvider.SDK_FEATURES_HEADER_VALUE.split(", ").contains("devicelinking"))
    }

    @Test
    fun `block with linked user decodes`() = runTest {
        val c = decode("""{"enabled":true,"link":{"status":"linked","owner":{"kind":"user","name":"Aurimas"}}}""")
        assertEquals(
            DeviceLinkingConfigWire(true, DeviceLinkStatusWire(true, DeviceLinkOwner.User("Aurimas"))),
            c.deviceLinking,
        )
    }

    @Test
    fun `linked team and unlinked decode`() = runTest {
        assertEquals(
            DeviceLinkingConfigWire(true, DeviceLinkStatusWire(true, DeviceLinkOwner.Team)),
            decode("""{"enabled":true,"link":{"status":"linked","owner":{"kind":"team"}}}""").deviceLinking,
        )
        assertEquals(
            DeviceLinkingConfigWire(false, DeviceLinkStatusWire(false, null)),
            decode("""{"enabled":false,"link":{"status":"unlinked"}}""").deviceLinking,
        )
    }

    @Test
    fun `block without link decodes with null link`() = runTest {
        assertEquals(DeviceLinkingConfigWire(true, null), decode("""{"enabled":true}""").deviceLinking)
        assertNull(decode(null).deviceLinking)
        assertNull(ReplayConfig.OFF.deviceLinking)
    }

    @Test
    fun `unknown nested keys are ignored`() = runTest {
        val c = decode(
            """{"enabled":true,"future":1,"link":{"status":"linked","future":1,
              |"owner":{"kind":"user","name":"Aurimas","future":true},
              |"recording":{"id":"6c1e2f6a-1b7e-4b43-9a55-0e0c2b8f3e10","expiresAt":"2026-10-23T10:00:00Z"}}}""".trimMargin(),
        )
        assertEquals(
            DeviceLinkingConfigWire(true, DeviceLinkStatusWire(true, DeviceLinkOwner.User("Aurimas"))),
            c.deviceLinking,
        )
    }

    @Test
    fun `malformed block degrades to null and keeps the rest`() = runTest {
        listOf("\"yes\"", """{"enabled":"true"}""", """{}""", "[]", "7").forEach { bad ->
            val c = decode(bad, replayEnabled = true)
            assertNull(bad, c.deviceLinking)
            assertTrue(bad, c.replayEnabled)
        }
    }

    @Test
    fun `unknown status or owner kind reads as unlinked`() = runTest {
        assertEquals(
            DeviceLinkingConfigWire(true, DeviceLinkStatusWire(false, null)),
            decode("""{"enabled":true,"link":{"status":"weird","owner":{"kind":"team"}}}""").deviceLinking,
        )
        // Linked with an owner this SDK does not understand: fail closed to "no link info".
        assertEquals(
            DeviceLinkingConfigWire(true, null),
            decode("""{"enabled":true,"link":{"status":"linked","owner":{"kind":"robot"}}}""").deviceLinking,
        )
        assertEquals(
            DeviceLinkingConfigWire(true, null),
            decode("""{"enabled":true,"link":{"status":"linked"}}""").deviceLinking,
        )
        assertEquals(
            DeviceLinkingConfigWire(true, null),
            decode("""{"enabled":true,"link":"linked"}""").deviceLinking,
        )
    }

    private suspend fun tokenHeaderFor(tokenProvider: () -> String?): String? {
        var seen: Request? = null
        val p = ReplayConfigProvider(
            configUrl = url,
            sdkKey = "k",
            fetcher = { req ->
                seen = req
                response(body(null, replayEnabled = true))
            },
            captureTokenProvider = tokenProvider,
        )
        assertTrue(p.refresh())
        assertTrue(p.current.replayEnabled)
        return seen!!.header("X-Everframe-Capture-Token")
    }

    @Test
    fun `valid device token rides the config request`() = runTest {
        assertTrue(tokenHeaderFor { deviceToken } == deviceToken)
    }

    @Test
    fun `no header for null, invalid or capture tokens`() = runTest {
        assertNull(tokenHeaderFor { null })
        assertNull(tokenHeaderFor { "evf_cap_" + "a".repeat(32) })
        assertNull(tokenHeaderFor { "garbage" })
        assertNull(tokenHeaderFor { throw IllegalStateException("boom") })
    }

    @Test
    fun `make passes the token provider through`() = runTest {
        var seen: Request? = null
        val p = ReplayConfigProvider.make(
            baseUrl = "https://everframe.dev",
            sdkKey = "k",
            fetcher = { req ->
                seen = req
                response(body(null))
            },
            captureTokenProvider = { deviceToken },
        )
        p.refresh()
        assertTrue(seen!!.header("X-Everframe-Capture-Token") == deviceToken)
    }
}
