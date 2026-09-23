// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// External review (naming-native branch), finding NN3 — before this fix,
// `CompanionActivityTracker` (dev.everframe.companion.CompanionBadge.kt) was
// only ever registered from `Everframe.startCompanionInternal()`, an
// `Application.ActivityLifecycleCallbacks` tracker that starts with
// `current = null` and only learns the foreground Activity from FUTURE
// callbacks. A plain-native host that calls `Everframe.start()` from
// `Application.onCreate` (the canonical integration — see `start()`'s own
// doc comment) and only calls `Everframe.startCompanion()` later, once its
// first Activity is already resumed, left the tracker hostless until the
// NEXT pause/resume cycle: `CompanionBadge.__activityProvider` resolved to
// `current?.get()`, which was still null.
//
// The fix moves registration into `start()` itself — see that method's own
// "External review, finding NN3" comment for the full ordering argument.
// This test drives the exact regression scenario end-to-end: start() (which
// now registers the tracker) -> an Activity resumes -> ONLY THEN does
// startCompanion() run and a companion client attach — no intervening
// pause/resume cycle anywhere.
package dev.everframe

import android.app.Activity
import android.view.WindowManager
import androidx.test.core.app.ApplicationProvider
import dev.everframe.companion.CompanionActivityTracker
import dev.everframe.companion.CompanionBadge
import dev.everframe.config.CaptureConfig
import dev.everframe.config.Environment
import dev.everframe.config.EverframeConfig
import dev.everframe.shared.SharedData
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowWindowManagerImpl

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class CompanionActivityTrackerStartupOrderingTest {

    private val mainDispatcher = StandardTestDispatcher()
    private lateinit var server: MockWebServer
    private val context get() = ApplicationProvider.getApplicationContext<android.content.Context>()

    @Before
    fun setUp() {
        // CompanionBadge's StateFlow collector defaults to `Dispatchers.Main`
        // (see RelayWSClient's `badge` field) — pointing `Dispatchers.Main`
        // at a `StandardTestDispatcher` this test controls is what makes
        // `advanceUntilIdle()` below actually drive it. Mirrors
        // `CompanionBadgeTest`'s documented pattern.
        Dispatchers.setMain(mainDispatcher)
        SharedData.init(context)
        CompanionActivityTracker.resetForTesting()
        CompanionBadge.__activityProvider = null
        resetCompanionState()
        server = MockWebServer().apply { start() }
    }

    @After
    fun tearDown() {
        Everframe.stopCompanion()
        server.shutdown()
        Everframe.kill()
        CompanionActivityTracker.resetForTesting()
        CompanionBadge.__activityProvider = null
        resetCompanionState()
        Dispatchers.resetMain()
        // Force-clean the tracked-view registry — see CompanionBadgeTest's
        // own tearDown comment for why this is unconditional.
        ShadowWindowManagerImpl.reset()
    }

    private fun resetCompanionState() {
        dev.everframe.companion.Companion.__setAttachedUserName(null)
        dev.everframe.companion.Companion.__setResolvedName(null)
        dev.everframe.companion.Companion.__setCode(null)
    }

    private fun validConfig(): EverframeConfig = EverframeConfig(
        appId = "test-app-id",
        sdkKey = "txx_live_test1234567890",
        environment = Environment.production,
        capture = CaptureConfig(logs = false),
    )

    private fun badgeViewsOn(activity: Activity): List<android.view.View> =
        Shadow.extract<ShadowWindowManagerImpl>(activity.windowManager).views.filter {
            (it.layoutParams as? WindowManager.LayoutParams)?.type == WindowManager.LayoutParams.TYPE_APPLICATION_PANEL
        }

    @Test
    fun activityResumedBeforeStartCompanion_stillGetsTheBadgeOnFirstAttach() = runTest(mainDispatcher) {
        // 1. start() — now registers CompanionActivityTracker synchronously,
        //    mirroring an Application.onCreate integration.
        Everframe.start(context, validConfig())

        // 2. An Activity resumes — well BEFORE any companion client exists.
        //    Under the pre-fix behavior this callback would have landed on
        //    nobody, since the tracker wasn't registered yet.
        val controller = Robolectric.buildActivity(Activity::class.java).setup()
        val activity = controller.get()

        // 3. ONLY NOW does companion start — no intervening pause/resume.
        // Finish a successful announce before simulating attachment. A closed
        // port races the synthetic code assignment: announce failure clears
        // the code asynchronously and leaves the badge with an empty label.
        val socketOpened = CountDownLatch(1)
        server.enqueue(MockResponse().setHeader("Content-Type", "application/json")
            .setBody("""{"ticket":"test-ticket","code":"LMN-421"}"""))
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                socketOpened.countDown()
            }
        }))
        Everframe.startCompanionInternal(
            context = context,
            config = Everframe.currentConfig,
            okHttpClient = OkHttpClient(),
            baseUrl = server.url("/").toString(),
        )
        assertTrue("announce must finish before the first attach", socketOpened.await(5, TimeUnit.SECONDS))
        org.junit.Assert.assertEquals("LMN-421", dev.everframe.companion.Companion.code.value)

        dev.everframe.companion.Companion.__setAttachedUserName("Aurimas")
        advanceUntilIdle()

        assertTrue(
            "the badge must attach to the Activity that resumed BEFORE " +
                "startCompanion() was ever called — no extra pause/resume " +
                "cycle should be required",
            badgeViewsOn(activity).isNotEmpty(),
        )
        Everframe.stopCompanion()
        controller.pause().stop().destroy()
    }
}
