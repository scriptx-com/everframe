// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// "Record on device": a linked device learns about a recording from its config, records key presses for
// 10 s while they still reach the app, and posts them with its device token. Virtual time, a fake client,
// and MockWebServer for the wire shape. Tokens are compared, never printed.
package dev.everframe.devicelink

import android.app.Activity
import android.app.Application
import android.os.SystemClock
import android.view.KeyEvent
import android.view.Window
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.test.core.app.ApplicationProvider
import dev.everframe.Everframe
import dev.everframe.capture.TXWindowCallbackWrapper
import dev.everframe.config.CaptureGestureConfigWire
import dev.everframe.config.CaptureHotkeyConfigWire
import dev.everframe.config.DeviceLinkStatusWire
import dev.everframe.config.DeviceLinkingConfigWire
import dev.everframe.config.RecordingRequestWire
import dev.everframe.quickcapture.CaptureGesture
import dev.everframe.quickcapture.QuickCapture
import dev.everframe.quickcapture.RecordedKey
import dev.everframe.quickcapture.TvGestureBinding
import dev.everframe.testing.takeRequestOrFail
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class GestureRecordingTest {
    private val app: Application = ApplicationProvider.getApplicationContext()
    private val token = "evf_dev_" + "Rc0r".repeat(8)
    private val id = "0b7f5a52-8f0e-4a3a-9d3e-6a1d2c4b5e6f"
    private val wallNow = 1_800_000_000_000L
    private val owner = DeviceLinkOwner.User("Aurimas")
    private val toasts = mutableListOf<String>()
    private val posts = mutableListOf<Triple<String, Boolean, List<RecordedKey>>>()
    private var refreshes = 0

    private val fakeApi = recordingClient(posts)

    private fun recordingClient(into: MutableList<Triple<String, Boolean, List<RecordedKey>>>) = object : GestureRecordingApi {
        override suspend fun postRecording(recordingId: String, token: String, events: List<RecordedKey>): Boolean {
            into += Triple(recordingId, token == this@GestureRecordingTest.token, events)
            return true
        }
    }

    /** The installed client: no link calls, and recordings go to [recordings]. */
    private class Client(private val recordings: GestureRecordingApi) : DeviceLinkApi, GestureRecordingApi by recordings {
        override suspend fun hello(nonce: String, device: HelloDevice): HelloResult = HelloResult.Stop
        override suspend fun check(attemptId: String, nonce: String): CheckResult = CheckResult.Stop
    }

    @Before
    fun setUp() {
        dev.everframe.shared.SharedData.init(app)
        DeviceLink.toaster = { toasts += it }
        DeviceLink.refreshConfig = { refreshes++ }
        DeviceLink.onLinkChanged = {}
    }

    @After
    fun tearDown() {
        GestureRecording.__resetForTesting()
        DeviceLink.__resetForTesting()
        QuickCapture.teardown()
        QuickCapture.__resetForTesting()
        CaptureGesture.__resetForTesting()
    }

    private fun TestScope.seams() {
        val dispatcher = StandardTestDispatcher(testScheduler)
        GestureRecording.scopeProvider = { CoroutineScope(dispatcher) }
        GestureRecording.now = { 50_000L + testScheduler.currentTime }
        GestureRecording.wallNow = { wallNow + testScheduler.currentTime }
        GestureRecording.toaster = { toasts += it }
    }

    @get:Rule
    val tmp = TemporaryFolder()

    private var store: DeviceLinkStore? = null

    /** A real install with a stored link for "scope", so config statuses apply to the token they describe. */
    private fun linked(recordings: GestureRecordingApi = fakeApi) {
        val s = store ?: DeviceLinkStore(File(tmp.newFolder(), "device-link-v1.bin"), JceTestDeviceLinkKeyProvider()).also {
            assertTrue(it.save(StoredDeviceLink(token, owner, "scope")))
            store = it
        }
        DeviceLink.install(s, Client(recordings), "scope", { tvDevice }, { true })
    }

    private val tvDevice = HelloDevice(model = "TV", osVersion = "12", appVersion = "1", sdk = "android/x", formFactor = "tv")


    private fun request(expiresIn: Long = 300_000, recordingId: String = id) = RecordingRequestWire(recordingId, wallNow + expiresIn)

    /** The config apply path: the request carried the stored token, and the answer names a pending recording. */
    private fun applyConfigWith(recording: RecordingRequestWire) {
        DeviceLink.tokenForRequest("scope")
        DeviceLink.applyConfig(DeviceLinkingConfigWire(true, DeviceLinkStatusWire(true, owner, recording))) { true }
    }

    @Test
    fun requestStartsTenSecondWindowThenPostsWithDeviceToken() = runTest {
        seams()
        linked()
        applyConfigWith(request())
        assertEquals(listOf("Recording remote keys for 10 seconds"), toasts)
        val recorder = GestureRecording.active
        assertNotNull(recorder)
        recorder!!.onKey(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.ACTION_DOWN, 0, 51_000)
        recorder.onKey(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.ACTION_DOWN, 1, 51_500)
        recorder.onKey(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.ACTION_UP, 0, 52_620)
        advanceTimeBy(9_999); runCurrent()
        assertTrue(posts.isEmpty())
        assertNotNull(GestureRecording.active)
        advanceTimeBy(1); runCurrent()
        assertEquals(1, posts.size)
        val (postedId, sameToken, events) = posts.single()
        assertEquals(id, postedId)
        assertTrue("posted with the stored device token", sameToken)
        assertEquals(listOf(RecordedKey("MEDIA_PLAY_PAUSE", 0, 1620)), events)
        assertNull(GestureRecording.active)
        assertEquals(listOf("Recording remote keys for 10 seconds", "Keys sent to Everframe"), toasts)
    }

    @Test
    fun sameRequestIdIsNeverRecordedTwice() = runTest {
        seams()
        linked()
        applyConfigWith(request())
        applyConfigWith(request())
        advanceTimeBy(10_000); runCurrent()
        applyConfigWith(request())
        advanceTimeBy(10_000); runCurrent()
        assertEquals(1, posts.size)
        // A new request is recorded.
        applyConfigWith(request(recordingId = "1c2d3e4f-0000-4000-8000-000000000001"))
        advanceTimeBy(10_000); runCurrent()
        assertEquals(2, posts.size)
    }

    @Test
    fun expiredRequestIgnored() = runTest {
        seams()
        linked()
        applyConfigWith(request(expiresIn = -1))
        assertNull(GestureRecording.active)
        advanceTimeBy(20_000); runCurrent()
        assertTrue(posts.isEmpty())
        assertTrue(toasts.isEmpty())
    }

    @Test
    fun unlinkedDeviceIgnoresRecordingRequests() = runTest {
        seams()
        DeviceLink.__setCurrentForTesting(null)
        applyConfigWith(request())
        assertNull(GestureRecording.active)
        GestureRecording.onRequest(request()) { true }
        assertNull("no token, no recording", GestureRecording.active)
        // A status for a token that was not the one requested never starts a recording either.
        linked()
        DeviceLink.applyConfig(DeviceLinkingConfigWire(true, DeviceLinkStatusWire(true, owner, request()))) { true }
        assertNull(GestureRecording.active)
        advanceTimeBy(20_000); runCurrent()
        assertTrue(posts.isEmpty())
    }

    @Test
    fun unlinkedBeforeTheWindowEndsPostsNothing() = runTest {
        seams()
        linked()
        applyConfigWith(request())
        DeviceLink.__setCurrentForTesting(null)
        advanceTimeBy(10_000); runCurrent()
        assertTrue(posts.isEmpty())
        assertNull(GestureRecording.active)
    }

    @Test
    fun aHungPostIsCancelledAtItsDeadline() = runTest {
        seams()
        var cancelled = false
        val hung = object : GestureRecordingApi {
            override suspend fun postRecording(recordingId: String, token: String, events: List<RecordedKey>): Boolean =
                try {
                    kotlinx.coroutines.awaitCancellation()
                } finally {
                    cancelled = true
                }
        }
        linked(hung)
        applyConfigWith(request())
        advanceTimeBy(10_000 + GestureRecording.POST_TIMEOUT_MS); runCurrent()
        assertTrue(cancelled)
        assertEquals(listOf("Recording remote keys for 10 seconds"), toasts)
    }

    @Test
    fun uploadUsesTheClientOfTheInstallationThatStartedTheRecording() = runTest {
        seams()
        linked(fakeApi)
        applyConfigWith(request())
        assertNotNull(GestureRecording.active)
        // A start() meanwhile installs a new client (another SDK key's) over the same stored link.
        val later = mutableListOf<Triple<String, Boolean, List<RecordedKey>>>()
        linked(recordingClient(later))
        advanceTimeBy(10_000); runCurrent()
        assertTrue("the new installation's client never carries the old recording", later.isEmpty())
        assertEquals(1, posts.size)
    }

    @Test
    fun aRedirectIsNotFollowed() {
        val server = MockWebServer()
        server.start()
        try {
            val client = DeviceLinkClient(server.url("/").toString(), "sdk-key", OkHttpClient())
            server.enqueue(MockResponse().setResponseCode(307).setHeader("Location", server.url("/elsewhere").toString()))
            server.enqueue(MockResponse().setResponseCode(204))
            assertFalse(runBlocking { client.postRecording(id, token, listOf(RecordedKey("DPAD_UP", 0, 80))) })
            assertEquals(1, server.requestCount)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun postBodyShape() {
        val server = MockWebServer()
        server.start()
        try {
            val client = DeviceLinkClient(server.url("/").toString(), "sdk-key", OkHttpClient())
            server.enqueue(MockResponse().setResponseCode(204))
            val events = listOf(RecordedKey("DPAD_UP", 0, 100), RecordedKey("MEDIA_PLAY_PAUSE", 300, 1920))
            assertTrue(runBlocking { client.postRecording(id, token, events) })
            val req = server.takeRequestOrFail()
            assertEquals("POST", req.method)
            assertEquals("/api/device-link/recordings/$id", req.path)
            assertEquals("Bearer sdk-key", req.getHeader("Authorization"))
            assertEquals(token, req.getHeader("X-Everframe-Capture-Token"))
            val body = Json.parseToJsonElement(req.body.readUtf8()).jsonObject
            assertEquals(setOf("events"), body.keys)
            val sent = body["events"]!!.jsonArray.map { e ->
                val o = e.jsonObject
                assertEquals(setOf("key", "downMs", "upMs"), o.keys)
                RecordedKey(o["key"]!!.jsonPrimitive.content, o["downMs"]!!.jsonPrimitive.long, o["upMs"]!!.jsonPrimitive.long)
            }
            assertEquals(events, sent)
            server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"recording_not_found"}"""))
            assertFalse(runBlocking { client.postRecording(id, token, events) })
            server.takeRequestOrFail()
            server.enqueue(MockResponse().setResponseCode(200))
            assertFalse("only 204 is success", runBlocking { client.postRecording(id, token, events) })
            server.takeRequestOrFail()
            // The id is one path segment, escaped.
            server.enqueue(MockResponse().setResponseCode(404))
            runBlocking { client.postRecording("a/b", token, events) }
            assertEquals("/api/device-link/recordings/a%2Fb", server.takeRequestOrFail().path)
        } finally {
            server.shutdown()
        }
    }

    /** The Activity's own callback, recording every key event that reaches it. */
    private class Recording(private val inner: Window.Callback) : Window.Callback by inner {
        val keys = mutableListOf<KeyEvent>()
        override fun dispatchKeyEvent(event: KeyEvent): Boolean {
            keys += event
            return false
        }
    }

    @Test
    @Config(qualifiers = "television")
    fun keysStillReachTheAppWhileRecording() = runTest {
        seams()
        val priorGate = Everframe.captureGate
        Everframe.captureGate = true
        try {
            var captures = 0
            CaptureGesture.captureTrigger = { captures++ }
            QuickCapture.isEmulator = { false }
            QuickCapture.install(app, localEnabled = true, debug = false)
            QuickCapture.publishRemote(CaptureHotkeyConfigWire(enabled = true))
            linked()
            QuickCapture.publishGesture(CaptureGestureConfigWire(TvGestureBinding.LongPress("MEDIA_PLAY_PAUSE", 1500)))
            assertNotNull(QuickCapture.armedTvBinding)
            GestureRecording.now = { SystemClock.uptimeMillis() }
            GestureRecording.onRequest(request()) { true }
            assertNotNull(GestureRecording.active)

            val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
            val delegate = Recording(activity)
            val wrapper = TXWindowCallbackWrapper(delegate, activity)
            val t = SystemClock.uptimeMillis()
            val events = listOf(KeyEvent(t, t, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, 0)) +
                (1..30).map { KeyEvent(t, t + 350 + it * 50L, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, it) } +
                KeyEvent(t, t + 2000, KeyEvent.ACTION_UP, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, 0)
            events.forEach { assertFalse(wrapper.dispatchKeyEvent(it)) }
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(2000))
            assertEquals(events.size, delegate.keys.size)
            events.indices.forEach { assertSame(events[it], delegate.keys[it]) }
            assertFalse(delegate.keys.last().isCanceled)
            assertEquals("gesture detection pauses while recording", 0, captures)
            advanceTimeBy(10_000); runCurrent()
            assertEquals(listOf(RecordedKey("MEDIA_PLAY_PAUSE", 0, 2000)), posts.single().third)
        } finally {
            Everframe.captureGate = priorGate
        }
    }

    @Test
    fun foregroundFetchesConfigOnlyWhenLinkedAndThrottled() {
        var clock = 100_000L
        DeviceLink.now = { clock }
        val lifecycleOwner = object : LifecycleOwner {
            override val lifecycle = LifecycleRegistry.createUnsafe(this)
        }
        linked()
        DeviceLink.foregroundObserver.onStart(lifecycleOwner)
        assertEquals("the launch's own ON_START: start() already fetches", 0, refreshes)
        clock += 10_000
        DeviceLink.foregroundObserver.onStart(lifecycleOwner)
        assertEquals(1, refreshes)
        clock += 9_999
        DeviceLink.foregroundObserver.onStart(lifecycleOwner)
        assertEquals("throttled to once per 10 s", 1, refreshes)
        clock += 1
        DeviceLink.foregroundObserver.onStart(lifecycleOwner)
        assertEquals(2, refreshes)
        clock += 60_000
        DeviceLink.__setCurrentForTesting(null)
        DeviceLink.foregroundObserver.onStart(lifecycleOwner)
        assertEquals("unlinked devices keep today's traffic", 2, refreshes)
    }
}
