// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Real-device quick capture: the device token on `GET /api/config` goes only
// to the ingest origin and SDK key that linked it. It is stripped from a
// cross-origin redirect, never attached by a session built for another scope,
// never sent by a torn-down session, and a link-change refresh dies with the
// link state. Tokens are compared, never printed.
package dev.everframe.capture.replay

import dev.everframe.Everframe
import dev.everframe.config.ConfigFetcher
import dev.everframe.config.DeviceLinkStatusWire
import dev.everframe.config.DeviceLinkingConfigWire
import dev.everframe.config.ReplayConfigProvider
import dev.everframe.devicelink.DeviceLink
import dev.everframe.devicelink.DeviceLinkOwner
import dev.everframe.devicelink.DeviceLinkScope
import dev.everframe.devicelink.DeviceLinkStore
import dev.everframe.devicelink.DeviceLinkTest
import dev.everframe.devicelink.HelloDevice
import dev.everframe.devicelink.JceTestDeviceLinkKeyProvider
import dev.everframe.devicelink.StoredDeviceLink
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestCoroutineScheduler
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ReplaySessionDeviceTokenTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val token = "evf_dev_" + "Sc0p".repeat(8)
    private val sdkKey = "txx_live_scope1234567890"
    private val okBody = """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0}"""
    private val device = HelloDevice(model = "Pixel 9", osVersion = "15", appVersion = "1.0.0", sdk = "android/x", formFactor = "phone")

    private lateinit var a: MockWebServer
    private lateinit var b: MockWebServer
    private val aTokens = CopyOnWriteArrayList<String>()
    private val bTokens = CopyOnWriteArrayList<String>()
    private var aRedirectsToB = false
    private lateinit var store: DeviceLinkStore

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        b = MockWebServer().apply {
            dispatcher = recording(bTokens) { MockResponse().setResponseCode(200).setBody(okBody) }
            start()
        }
        a = MockWebServer().apply {
            dispatcher = recording(aTokens) {
                if (aRedirectsToB) {
                    MockResponse().setResponseCode(302).setHeader("Location", b.url("/api/config").toString())
                } else {
                    MockResponse().setResponseCode(200).setBody(okBody)
                }
            }
            start()
        }
        store = DeviceLinkStore(File(tmp.newFolder("dev.everframe"), "device-link-v1.bin"), JceTestDeviceLinkKeyProvider())
        DeviceLink.refreshConfig = {}
        DeviceLink.toaster = {}
        DeviceLink.onLinkChanged = {}
        DeviceLink.showBanner = {}
        DeviceLink.hideBanner = {}
    }

    @After
    fun tearDown() {
        Everframe._replaySession = null
        DeviceLink.__resetForTesting()
        Dispatchers.resetMain()
        a.shutdown()
        b.shutdown()
    }

    private fun recording(into: MutableList<String>, answer: () -> MockResponse) = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            into += request.getHeader("X-Everframe-Capture-Token") ?: "<none>"
            return answer()
        }
    }

    private fun base(server: MockWebServer) = server.url("/").toString().trimEnd('/')

    /** Loads a link stored for [linkedTo]'s scope, as `start()` does for that endpoint. */
    private fun linkTo(linkedTo: MockWebServer) {
        val scope = DeviceLinkScope.of(base(linkedTo), sdkKey)!!
        assertTrue(store.save(StoredDeviceLink(token, DeviceLinkOwner.User("Ann"), scope)))
        DeviceLink.install(store, DeviceLinkTest.FakeClient(), scope, { device }, { true })
        assertTrue(DeviceLink.current?.token == token)
    }

    @Test
    fun sameOriginConfigFetchCarriesTheToken() = runBlocking {
        linkTo(a)
        ReplaySession(baseUrl = base(a), sdkKey = sdkKey).refreshConfigNow()
        assertEquals(1, aTokens.size)
        assertTrue("the linked origin gets the token", aTokens.single() == token)
    }

    @Test
    fun crossOriginRedirectDropsTheToken() = runBlocking {
        linkTo(a)
        aRedirectsToB = true
        ReplaySession(baseUrl = base(a), sdkKey = sdkKey).refreshConfigNow()
        assertEquals("the redirect was followed", 1, bTokens.size)
        assertTrue("a cross-origin redirect never carries the token", bTokens.single() == "<none>")
    }

    @Test
    fun aSessionForAnotherScopeNeverAttachesTheToken() = runBlocking {
        // The link state belongs to B's scope (a later start), the session to A's.
        linkTo(b)
        ReplaySession(baseUrl = base(a), sdkKey = sdkKey).refreshConfigNow()
        assertEquals(1, aTokens.size)
        assertTrue("A never gets B's token", aTokens.single() == "<none>")
        // Same origin, another SDK key: also a different scope.
        ReplaySession(baseUrl = base(b), sdkKey = "txx_live_otherkey000000").refreshConfigNow()
        assertTrue(bTokens.single() == "<none>")
    }

    @Test
    fun aTornDownSessionFetchesNothing() = runBlocking {
        linkTo(a)
        val session = ReplaySession(baseUrl = base(a), sdkKey = sdkKey)
        session.teardown()
        session.refreshConfigNow()
        assertTrue("a torn-down session sent ${aTokens.size} config requests", aTokens.isEmpty())
    }

    @Test
    fun linkStateTeardownCancelsAPendingLinkChangeRefresh() {
        // The production refresh seam, on a dispatcher this test drives.
        DeviceLink.__resetForTesting()
        val scheduler = TestCoroutineScheduler()
        DeviceLink.scopeProvider = { CoroutineScope(StandardTestDispatcher(scheduler)) }
        DeviceLink.toaster = {}
        DeviceLink.onLinkChanged = {}
        linkTo(a)
        val fetches = AtomicInteger()
        val provider = ReplayConfigProvider.make(baseUrl = base(a), sdkKey = sdkKey, fetcher = ConfigFetcher { request ->
            fetches.incrementAndGet()
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                .body(okBody.toResponseBody("application/json".toMediaType())).build()
        })
        Everframe._replaySession = ReplaySession(sdkKey = sdkKey, provider = provider)
        // An unlinked status for the token the latest request carried: forget() asks for a refresh.
        DeviceLink.tokenForRequest(DeviceLinkScope.of(base(a), sdkKey))
        DeviceLink.applyConfig(DeviceLinkingConfigWire(true, DeviceLinkStatusWire(linked = false, owner = null))) { true }
        DeviceLink.teardown()
        scheduler.advanceUntilIdle()
        Thread.sleep(300)
        assertEquals("the link-change refresh survived teardown", 0, fetches.get())
    }
}
