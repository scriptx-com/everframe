// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.config

import dev.everframe.Everframe
import dev.everframe.capture.replay.ReplaySession
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
class NativeVideoCapabilityTest {
    @Test @Config(sdk = [29]) fun api29AdvertisesAndActivatesVideo() = verify(true)
    @Test @Config(sdk = [28]) fun api28NeverAdvertisesOrActivatesVideo() = verify(false)

    private fun verify(supported: Boolean) = runBlocking {
        dev.everframe.shared.SharedData.init(androidx.test.core.app.ApplicationProvider.getApplicationContext())
        val server = MockWebServer()
        server.start()
        server.enqueue(MockResponse().setBody("""{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,"nativeVideo":{"framesPerSecond":5}}"""))
        val provider = ReplayConfigProvider.make(server.url("/").toString(), "key", ConfigFetcher {
            OkHttpClient().newCall(it).execute()
        })
        Everframe.captureGate = true
        val session = ReplaySession(apiKey = "key", provider = provider)
        try {
            session.refreshConfigNow()
            val request = server.takeRequest(3, java.util.concurrent.TimeUnit.SECONDS)!!
            val features = request.getHeader("X-TX-SDK-Features")!!.split(',').map { it.trim() }
            assertFalse(features.contains("vtree"))
            assertEquals(supported, features.contains("nativevideo"))
            assertFalse(request.requestUrl!!.queryParameterNames.contains("vtree"))
            val capture = session.freezeOwnedCapture()
            try { assertEquals(supported, capture.replayAllowed()) } finally { capture.cancel() }
        } finally { session.teardown(); Everframe.captureGate = false; server.shutdown() }
    }
}
