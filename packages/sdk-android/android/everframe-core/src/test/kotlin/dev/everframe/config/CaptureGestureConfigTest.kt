// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Real-device quick capture on TVs: the `capturegesture` capability, the element-wise `captureGesture`
// block (fails closed to no binding), and the `deviceLinking.link.recording` request.
package dev.everframe.config

import dev.everframe.devicelink.DeviceLinkOwner
import dev.everframe.quickcapture.TvGestureBinding
import java.time.Instant
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
class CaptureGestureConfigTest {
    private val url = "https://everframe.dev/api/config"

    private fun response(body: String): Response = Response.Builder()
        .request(Request.Builder().url(url).build())
        .protocol(Protocol.HTTP_1_1)
        .code(200)
        .message("OK")
        .body(body.toResponseBody("application/json".toMediaType()))
        .build()

    private suspend fun decodeBody(extra: String, replayEnabled: Boolean = false): ReplayConfig {
        val body = """{"replayEnabled":$replayEnabled,"replayDurationSec":30,"samplingRate":1.0$extra}"""
        val p = ReplayConfigProvider(configUrl = url, sdkKey = "k", fetcher = { response(body) })
        assertTrue(p.refresh())
        return p.current
    }

    private suspend fun gesture(block: String, replayEnabled: Boolean = false): CaptureGestureConfigWire? =
        decodeBody(""","captureGesture":$block""", replayEnabled).captureGesture

    private suspend fun tv(binding: String): TvGestureBinding? = gesture("""{"tv":$binding}""")?.tv

    @Test
    fun `capturegesture is declared`() {
        val tokens = ReplayConfigProvider.SDK_FEATURES_HEADER_VALUE.split(", ")
        assertTrue(tokens.contains("capturegesture"))
        // Appended after the PR 1 token.
        assertEquals(tokens.indexOf("devicelinking") + 1, tokens.indexOf("capturegesture"))
    }

    @Test
    fun `longPress decodes`() = runTest {
        assertEquals(
            CaptureGestureConfigWire(TvGestureBinding.LongPress("MEDIA_PLAY_PAUSE", 1500)),
            gesture("""{"tv":{"kind":"longPress","keys":["MEDIA_PLAY_PAUSE"],"holdMs":1500}}"""),
        )
    }

    @Test
    fun `sequence and chord decode`() = runTest {
        assertEquals(
            TvGestureBinding.Sequence(listOf("DPAD_UP", "DPAD_UP", "DPAD_DOWN", "DPAD_DOWN"), 1000),
            tv("""{"kind":"sequence","keys":["DPAD_UP","DPAD_UP","DPAD_DOWN","DPAD_DOWN"],"windowMs":1000}"""),
        )
        assertEquals(TvGestureBinding.Chord(setOf("SHIFT", "B")), tv("""{"kind":"chord","keys":["SHIFT","B"]}"""))
    }

    @Test
    fun `invalid bindings fail closed to null tv`() = runTest {
        listOf(
            """{"kind":"longPress","keys":["HOME"],"holdMs":1500}""",
            """{"kind":"longPress","keys":["MEDIA_PLAY_PAUSE"],"holdMs":100}""",
            """{"kind":"longPress","keys":["MEDIA_PLAY_PAUSE"],"holdMs":60000}""",
            """{"kind":"longPress","keys":["MEDIA_PLAY_PAUSE","MENU"],"holdMs":1500}""",
            """{"kind":"longPress","keys":["MEDIA_PLAY_PAUSE"],"holdMs":"1500"}""",
            """{"kind":"longPress","keys":["MEDIA_PLAY_PAUSE"]}""",
            """{"kind":"sequence","keys":["DPAD_UP"],"windowMs":1000}""",
            """{"kind":"sequence","keys":["0","1","2","3","4","5","6","7","8"],"windowMs":1000}""",
            """{"kind":"sequence","keys":["DPAD_UP","DPAD_DOWN"],"windowMs":100}""",
            """{"kind":"sequence","keys":["DPAD_UP","DPAD_DOWN"],"windowMs":6000}""",
            """{"kind":"chord","keys":["SHIFT"]}""",
            """{"kind":"chord","keys":["SHIFT","SHIFT"]}""",
            """{"kind":"chord","keys":["A","B","C","D","E"]}""",
            """{"kind":"chord","keys":["SHIFT",7]}""",
            """{"kind":"swipe","keys":["DPAD_UP"]}""",
            """{"keys":["DPAD_UP"]}""",
            """"longPress"""",
        ).forEach { bad ->
            val wire = gesture("""{"tv":$bad}""")
            assertEquals(bad, CaptureGestureConfigWire(null), wire)
        }
    }

    @Test
    fun `malformed block is null and keeps the rest of the config`() = runTest {
        listOf("\"tv\"", "[]", "7", "true", "null").forEach { bad ->
            val c = decodeBody(""","captureGesture":$bad""", replayEnabled = true)
            assertNull(bad, c.captureGesture)
            assertTrue(bad, c.replayEnabled)
        }
        assertNull(decodeBody("").captureGesture)
        assertNull(ReplayConfig.OFF.captureGesture)
    }

    @Test
    fun `missing tv reads as no binding`() = runTest {
        assertEquals(CaptureGestureConfigWire(null), gesture("{}"))
        assertEquals(CaptureGestureConfigWire(null), gesture("""{"tv":null}"""))
        // Unknown siblings (a future phone binding) are ignored.
        assertEquals(
            CaptureGestureConfigWire(TvGestureBinding.Chord(setOf("PROG_RED", "PROG_BLUE"))),
            gesture("""{"phone":{"kind":"shake"},"tv":{"kind":"chord","keys":["PROG_RED","PROG_BLUE"],"x":1}}"""),
        )
    }

    @Test
    fun `recording request decodes`() = runTest {
        val id = "6c1e2f6a-1b7e-4b43-9a55-0e0c2b8f3e10"
        val ok = decodeBody(
            ""","deviceLinking":{"enabled":true,"link":{"status":"linked","owner":{"kind":"team"},""" +
                """"recording":{"id":"$id","expiresAt":"2026-10-23T10:00:00Z"}}}""",
        ).deviceLinking
        assertEquals(
            DeviceLinkingConfigWire(
                true,
                DeviceLinkStatusWire(
                    true,
                    DeviceLinkOwner.Team,
                    RecordingRequestWire(id, Instant.parse("2026-10-23T10:00:00Z").toEpochMilli()),
                ),
            ),
            ok,
        )
        listOf(
            """{"id":"$id","expiresAt":"tomorrow"}""",
            """{"id":"$id"}""",
            """{"id":7,"expiresAt":"2026-10-23T10:00:00Z"}""",
            """{"id":"","expiresAt":"2026-10-23T10:00:00Z"}""",
            """{"id":"a/b","expiresAt":"2026-10-23T10:00:00Z"}""",
            """"$id"""",
        ).forEach { bad ->
            val wire = decodeBody(
                ""","deviceLinking":{"enabled":true,"link":{"status":"linked","owner":{"kind":"user","name":"Aurimas"},""" +
                    """"recording":$bad}}""",
            ).deviceLinking
            // The link is kept; only the recording is dropped.
            assertEquals(bad, DeviceLinkingConfigWire(true, DeviceLinkStatusWire(true, DeviceLinkOwner.User("Aurimas"))), wire)
        }
    }
}
