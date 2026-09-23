// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.replay

import dev.everframe.Everframe
import dev.everframe.capture.video.NativeVideoRecorder
import dev.everframe.config.ConfigFetcher
import dev.everframe.config.ReplayConfigProvider
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.Protocol
import okhttp3.Response
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Runtime replacement gates. Deprecated image config remains decodable; only native video can activate. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ReplaySessionImageGateTest {
    private fun session(native: Boolean): ReplaySession {
        val video = if (native) ",\"nativeVideo\":{\"framesPerSecond\":5}" else ""
        val body = """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0$video}"""
        return ReplaySession(apiKey = "k", provider = ReplayConfigProvider.make("https://a.test", "k", ConfigFetcher { request ->
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                .body(body.toResponseBody("application/json".toMediaType())).build()
        }))
    }
    @Test fun legacyReplayEnablementCannotActivateNativeOrFallbackCapture() = runBlocking {
        Everframe.captureGate = true
        val session = session(false)
        try {
            session.refreshConfigNow()
            assertEquals(NativeVideoRecorder.State.DISABLED, session.__lifecycleStateForTesting())
            val capture = session.freezeOwnedCapture(); assertFalse(capture.replayAllowed()); capture.cancel()
        } finally { session.teardown(); Everframe.captureGate = false }
    }
    @Test @Config(sdk = [28]) fun olderAndroidPreservesAncillaryHandleWithoutNativeRecording() = runBlocking {
        Everframe.captureGate = true
        val session = session(true)
        try {
            session.refreshConfigNow()
            assertEquals(NativeVideoRecorder.State.DISABLED, session.__lifecycleStateForTesting())
            val capture = session.freezeOwnedCapture()
            assertFalse(capture.replayAllowed()); assertNotNull(capture.takeBreadcrumbs()); capture.cancel()
        } finally { session.teardown(); Everframe.captureGate = false }
    }
}
