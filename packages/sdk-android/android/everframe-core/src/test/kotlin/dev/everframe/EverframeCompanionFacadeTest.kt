// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// External review, finding N3 — before `Everframe.startCompanion()` /
// `stopCompanion()` existed, a plain Kotlin/Java or Jetpack-Compose host with
// no RN bridge had NO way to start companion at all: `EverframeModule` (the RN
// bridge, `:sdk-react-native`) was the ONLY caller that ever built a
// `RelayWSClient`, so `EverframeConfig.companionDeviceId` /
// `companionBadgeEnabled` / `companionBadgePosition` were dead config for
// that host shape.
//
// This drives `Everframe.startCompanionInternal(...)` (the test-injectable
// twin of the public no-arg `startCompanion()` — see that method's own doc)
// against a real `MockWebServer`, mirroring
// `RelayWSClientAnnounceTest.deviceProvider_resolvedDevice_reachesTheAnnounceRequestBody`
// but through the FACADE rather than a hand-built `RelayWSClient`, so a
// regression that drops the facade's wiring (not just `CompanionDeviceFacts`
// itself) fails here.
//
// *** DOES NOT RUN IN CI *** for the same reason
// `RelayWSClientAnnounceTest` doesn't — see that file's header.
package dev.everframe

import androidx.test.core.app.ApplicationProvider
import dev.everframe.companion.CompanionActivityTracker
import dev.everframe.companion.CompanionBadgePosition
import dev.everframe.companion.CompanionDeviceId
import dev.everframe.config.CaptureConfig
import dev.everframe.config.Environment
import dev.everframe.config.EverframeConfig
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class EverframeCompanionFacadeTest {

    private val context get() = ApplicationProvider.getApplicationContext<android.content.Context>()

    private lateinit var server: MockWebServer
    private lateinit var announceBodies: CopyOnWriteArrayList<String>
    private lateinit var socketPaths: LinkedBlockingQueue<String>

    @Before
    fun setUp() {
        announceBodies = CopyOnWriteArrayList()
        socketPaths = LinkedBlockingQueue()
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty()
                if (path.startsWith("/api/companion/announce")) {
                    announceBodies.add(request.body.readUtf8())
                    return MockResponse().setResponseCode(200)
                        .setHeader("Content-Type", "application/json")
                        .setBody("""{"ticket":"tkt_1","code":"AAA-111","expiresInMs":60000}""")
                }
                socketPaths.put(path)
                return MockResponse().withWebSocketUpgrade(object : okhttp3.WebSocketListener() {})
            }
        }
        server.start()
        CompanionDeviceId.__resetForTests(context)
    }

    @After
    fun tearDown() {
        Everframe.stopCompanion()
        Everframe.__resetCompanionClientForTesting()
        CompanionActivityTracker.resetForTesting()
        dev.everframe.companion.CompanionBadge.__activityProvider = null
        Everframe.kill()
        server.shutdown()
    }

    private fun configWith(
        companionDeviceId: String? = "explicit-device-id",
        companionBadgeEnabled: Boolean = true,
        companionBadgePosition: String? = null,
    ) = EverframeConfig(
        appId = "test-app-id",
        sdkKey = "txx_live_test1234567890",
        environment = Environment.production,
        capture = CaptureConfig(logs = false),
        companionDeviceId = companionDeviceId,
        companionBadgeEnabled = companionBadgeEnabled,
        companionBadgePosition = companionBadgePosition,
    )

    private fun nextSocketPath(): String? = socketPaths.poll(5, TimeUnit.SECONDS)

    @Test
    fun startCompanionInternal_wiresTheConfiguredDeviceIdIntoTheAnnounceBody() {
        val client = Everframe.startCompanionInternal(
            context = context,
            config = configWith(companionDeviceId = "explicit-device-id"),
            okHttpClient = OkHttpClient(),
            baseUrl = server.url("/").toString(),
        )
        assertNotNull("facade must construct and return a live client", client)

        assertEquals("/relay/tv/tkt_1", nextSocketPath())
        val body = Json.parseToJsonElement(announceBodies.single()) as JsonObject
        val device = body["device"] as JsonObject
        // CompanionDeviceId.resolve hashes the explicit id to a stable UUID —
        // asserting it round-trips through the facade proves the config field
        // (`companionDeviceId`), not just `CompanionDeviceFacts` in isolation,
        // actually reached the constructed `RelayWSClient`.
        assertEquals(
            CompanionDeviceId.resolve(context, "explicit-device-id"),
            device["id"]!!.jsonPrimitive.content,
        )
    }

    @Test
    fun startCompanionInternal_wiresBadgeOptionsFromConfig() {
        val client = Everframe.startCompanionInternal(
            context = context,
            config = configWith(companionBadgeEnabled = true, companionBadgePosition = "top-left"),
            okHttpClient = OkHttpClient(),
            baseUrl = server.url("/").toString(),
        )

        assertNotNull(client)
        assertEquals(true, client!!.companionBadgeOptionsForTesting.enabled)
        assertEquals(CompanionBadgePosition.TOP_LEFT, client.companionBadgeOptionsForTesting.position)
    }

    @Test
    fun startCompanionInternal_badgeDisabledInConfig_flowsThrough() {
        val client = Everframe.startCompanionInternal(
            context = context,
            config = configWith(companionBadgeEnabled = false),
            okHttpClient = OkHttpClient(),
            baseUrl = server.url("/").toString(),
        )

        assertNotNull(client)
        assertEquals(false, client!!.companionBadgeOptionsForTesting.enabled)
    }

    @Test
    fun startCompanionInternal_installsTheActivityTrackerWithoutClobberingAnExistingProvider() {
        // An RN host's own provider must survive a native-facade start in the
        // same process (external review, finding N3's "never clobber an
        // RN-installed provider" requirement).
        val rnProvider: () -> android.app.Activity? = { null }
        dev.everframe.companion.CompanionBadge.__activityProvider = rnProvider

        Everframe.startCompanionInternal(
            context = context,
            config = configWith(),
            okHttpClient = OkHttpClient(),
            baseUrl = server.url("/").toString(),
        )

        assertSame(
            "an RN-installed provider must not be replaced by the native tracker",
            rnProvider,
            dev.everframe.companion.CompanionBadge.__activityProvider,
        )
    }

    @Test
    fun startCompanionInternal_calledTwice_returnsTheSameLiveClient() {
        val first = Everframe.startCompanionInternal(
            context = context,
            config = configWith(),
            okHttpClient = OkHttpClient(),
            baseUrl = server.url("/").toString(),
        )
        val second = Everframe.startCompanionInternal(
            context = context,
            config = configWith(),
            okHttpClient = OkHttpClient(),
            baseUrl = server.url("/").toString(),
        )

        assertSame("a second start while one is live must be a no-op", first, second)
    }
}
