// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// DEBUG-ONLY unit test source set: assigns `EndpointOverride.current`.
//
// Real-device quick capture wiring: `start()` loads the stored device link
// before the first config fetch, so that fetch already carries the token, and
// `kill()` tears the link state down. Tokens are compared, never printed.
package dev.everframe

import android.content.Context
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import dev.everframe.config.CaptureConfig
import dev.everframe.config.EndpointOverride
import dev.everframe.config.EverframeConfig
import dev.everframe.devicelink.DeviceLink
import dev.everframe.devicelink.DeviceLinkOwner
import dev.everframe.devicelink.DeviceLinkScope
import dev.everframe.devicelink.DeviceLinkStore
import dev.everframe.devicelink.JceTestDeviceLinkKeyProvider
import dev.everframe.devicelink.LinkBanner
import dev.everframe.devicelink.LinkNonce
import dev.everframe.devicelink.StoredDeviceLink
import dev.everframe.shared.SharedData
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
class EverframeDeviceLinkWiringTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private lateinit var server: MockWebServer
    private val configTokens = CopyOnWriteArrayList<String>()
    private val token = "evf_dev_" + "W1re".repeat(8)
    private val sdkKey = "txx_live_test1234567890"
    private lateinit var store: DeviceLinkStore

    @Before
    fun setUp() {
        SharedData.init(context)
        server = MockWebServer().apply {
            dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse = when {
                    request.path!!.startsWith("/api/config") -> {
                        configTokens += request.getHeader("X-Everframe-Capture-Token") ?: "<none>"
                        MockResponse().setResponseCode(200).setBody(
                            """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,"deviceLinking":{"enabled":true}}""",
                        )
                    }
                    request.path!!.contains("/api/device-link/attempts/") ->
                        MockResponse().setResponseCode(200).setBody("""{"status":"pending"}""")
                    else -> MockResponse().setResponseCode(503).setBody("{}")
                }
            }
            start()
        }
        EndpointOverride.current = server.url("/").toString().trimEnd('/')
        store = DeviceLinkStore(File(tmp.newFolder("dev.everframe"), "device-link-v1.bin"), JceTestDeviceLinkKeyProvider())
        Everframe.__deviceLinkStoreFactoryForTesting = { store }
    }

    @After
    fun tearDown() {
        Everframe.kill()
        Everframe.__deviceLinkStoreFactoryForTesting = null
        DeviceLink.__resetForTesting()
        LinkBanner.__resetForTesting()
        EndpointOverride.current = null
        server.shutdown()
    }

    private fun config() = EverframeConfig(appId = "test-app-id", sdkKey = sdkKey, capture = CaptureConfig(logs = false))

    private fun idleUntil(message: String, done: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (!done() && System.nanoTime() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(5)
        }
        assertTrue(message, done())
    }

    @Test
    fun firstConfigFetchCarriesTheStoredDeviceToken() {
        val scope = DeviceLinkScope.of(EndpointOverride.current!!, sdkKey)!!
        assertTrue(store.save(StoredDeviceLink(token, DeviceLinkOwner.User("Aurimas"), scope)))
        Everframe.start(context, config())
        idleUntil("no config fetch") { configTokens.isNotEmpty() }
        assertTrue("the first config fetch carries the stored token", configTokens.first() == token)
        assertTrue(DeviceLink.current?.token == token)
        idleUntil("linking switch applied") { DeviceLink.linkingEnabled }
    }

    @Test
    fun aTokenForAnotherScopeIsNeverSent() {
        val other = DeviceLinkScope.of("https://staging.example", sdkKey)!!
        assertTrue(store.save(StoredDeviceLink(token, DeviceLinkOwner.Team, other)))
        Everframe.start(context, config())
        idleUntil("no config fetch") { configTokens.isNotEmpty() }
        assertTrue(configTokens.first() == "<none>")
        assertNull(DeviceLink.current)
    }

    @Test
    fun killCancelsAPendingAttempt() {
        Everframe.start(context, config())
        idleUntil("link state never loaded") { DeviceLink.isLoaded }
        DeviceLink.beginAttempt("6c1e2f6a-1b7e-4b43-9a55-0e0c2b8f3e10", 47, LinkNonce.generate())
        idleUntil("banner never shown") { LinkBanner.visibleNumber == 47 }
        assertTrue(DeviceLink.attemptInFlight)
        Everframe.kill()
        shadowOf(Looper.getMainLooper()).idle()
        assertFalse(DeviceLink.attemptInFlight)
        assertFalse(DeviceLink.isLoaded)
        assertNull(LinkBanner.visibleNumber)
    }
}
