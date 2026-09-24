// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import dev.everframe.Everframe
import dev.everframe.capture.replay.ReplaySession
import dev.everframe.config.NativeVideoSettings
import dev.everframe.config.ReplayConfigProvider
import dev.everframe.config.ConfigFetcher
import kotlinx.coroutines.runBlocking
import okhttp3.Response
import okhttp3.Protocol
import okhttp3.ResponseBody.Companion.toResponseBody
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], manifest = Config.NONE)
class VideoDiagnosticLifecycleTest {
    private fun snapshot(): JsonObject {
        val output = Json.parseToJsonElement(requireNotNull(Everframe.__nativeVideoDiagnostics())).jsonObject
        fun numeric(value: JsonElement): Boolean = when (value) {
            is JsonObject -> value.values.all { numeric(it) }
            is JsonArray -> value.size <= 256 && value.all { numeric(it) }
            is JsonPrimitive -> !value.isString && value.content.toLongOrNull() != null
        }
        assertTrue("Only bounded numeric values cross the host boundary", numeric(output))
        return output
    }
    private fun set(session: ReplaySession, name: String, value: Any) {
        ReplaySession::class.java.getDeclaredField(name).apply { isAccessible = true }.set(session, value)
    }
    @Test fun hostSnapshotRetainsOnlyLastReleasedNumericSamplesAndTeardownClearsThem() = verifyLifecycle(false)
    @Test fun privacyRevocationClearsPreviousAndLateReleaseCannotRestoreIt() = verifyLifecycle(true)

    private fun verifyLifecycle(privacyRevoke: Boolean) = runBlocking {
        dev.everframe.shared.SharedData.init(androidx.test.core.app.ApplicationProvider.getApplicationContext())
        val priorGate = Everframe.captureGate
        Everframe.captureGate = true
        val provider = ReplayConfigProvider.make("https://example.invalid", "never-export-this-sdk-key", ConfigFetcher {
            Response.Builder().request(it).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                .body("""{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,"nativeVideo":{"framesPerSecond":5}}""".toResponseBody()).build()
        })
        val session = ReplaySession(apiKey = "never-export-this-sdk-key", provider = provider)
        val prior = Everframe._replaySession
        Everframe._replaySession = session
        val scheduler = object : VideoCaptureScheduler {
            override fun main(block: () -> Unit) = Unit
            override fun worker(block: () -> Unit) = block()
            override fun later(delayMs: Long, block: () -> Unit): () -> Unit = {}
            override fun isWorkerThread() = false
            override fun nowNanos() = 0L
        }
        try {
            assertEquals("0", snapshot()["hasRecorder"].toString())
            session.enableIfConfigured()
            session.refreshConfigNow()
            repeat(2) { index ->
                val owner = ReplaySession::class.java.getDeclaredField("recordingOwner").apply { isAccessible = true }.get(session) as VideoOwner
                val recorder = NativeVideoRecorder(owner, scheduler, { it(); true }, { null }, { null },
                    { _, _, _ -> error("No codec in retention test") }, { _, _ -> null })
                recorder.start(NativeVideoSettings(5), 30)
                repeat(400) { recorder.finalizationNs.add((index + 1).toLong()) }
                set(session, "recorder", recorder)
                val captured = Everframe.__replayFreeze()
                captured.finishConsumption()
                val output = snapshot()
                assertFalse(output.containsKey("current"))
                val samples = output.getValue("previous").jsonObject.getValue("finalizationNs").jsonArray
                assertEquals(256, samples.size)
                assertTrue(samples.all { it.jsonPrimitive.long == (index + 1).toLong() })
                assertFalse(output.toString().contains(owner.sessionId))
                assertFalse(output.toString().contains(owner.captureId))
                assertFalse(output.toString().contains("never-export"))
                recorder.finalizationNs.add(999)
                assertEquals(samples, snapshot().getValue("previous").jsonObject["finalizationNs"])
            }
            if (privacyRevoke) {
                val lateOwner = ReplaySession::class.java.getDeclaredField("recordingOwner").apply { isAccessible = true }.get(session) as VideoOwner
                val lateRecorder = NativeVideoRecorder(lateOwner, scheduler, { it(); true }, { null }, { null },
                    { _, _, _ -> error("No codec in retention test") }, { _, _ -> null })
                lateRecorder.start(NativeVideoSettings(5), 30)
                lateRecorder.finalizationNs.add(77)
                set(session, "recorder", lateRecorder)
                val pending = Everframe.__replayFreeze()
                val sensitive = Everframe.__beginSensitiveRegistration()
                try {
                    assertFalse(snapshot().containsKey("previous"))
                    pending.finishConsumption()
                    assertFalse("Late release cannot restore revoked diagnostics", snapshot().containsKey("previous"))
                    assertEquals("1", snapshot()["privacyBlocked"].toString())
                } finally { sensitive.close(); pending.cancel() }
            }
            session.teardown()
            assertFalse(snapshot().containsKey("previous"))
            assertEquals("0", snapshot()["authorized"].toString())
        } finally { session.teardown(); Everframe._replaySession = prior; Everframe.captureGate = priorGate }
    }
}
