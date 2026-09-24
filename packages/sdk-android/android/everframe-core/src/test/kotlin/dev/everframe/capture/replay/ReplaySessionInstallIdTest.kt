// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// MAI meter Plan 2b-i — guards the WIRING, not the derivation: a correct
// InstallIdentifier and a correct ReplayConfigProvider still count nothing if
// ReplaySession drops the supplier on the floor between them.
//
// Fix round 1 (controller-flagged gap): the FIRST test below supplies its own
// `provider` argument, which bypasses `ReplaySession`'s DEFAULT `provider`
// expression entirely — and forwarding `installIdProvider` into that default
// expression is the actual production change this task made to
// ReplaySession.kt. That test proves the constructor CAN carry the value when
// handed a pre-built provider; it does not prove the default expression
// itself forwards it. The SECOND test below closes that gap: it omits
// `provider` altogether (pointing `baseUrl` at a real MockWebServer instead),
// so the default expression is what actually builds the provider that makes
// the request.
package dev.everframe.capture.replay

import dev.everframe.config.ConfigFetcher
import dev.everframe.testing.takeRequestOrFail
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// `refreshConfigNow()` ends with `withContext(Dispatchers.Main) {
// startBufferingIfEligible() }` unconditionally (see ReplaySessionRefreshLoopTest's
// setUp for the same note) — Robolectric supplies the main Looper the
// dispatcher needs, and UnconfinedTestDispatcher runs that hop inline so
// `runBlocking { session.refreshConfigNow() }` completes without a separate
// drain thread.
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ReplaySessionInstallIdTest {

    private val vectorId = "iYgxBgJiRf1n_ekekB7M9g03ulCzNx2O4jfL8PWLegA"

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun `the session's default provider carries the supplied install id`() = runBlocking {
        val urls = mutableListOf<String>()
        val fetcher = ConfigFetcher { request ->
            urls += request.url.toString()
            Response.Builder()
                .request(request)
                .protocol(Protocol.HTTP_1_1)
                .code(200)
                .message("OK")
                .body(
                    """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1}"""
                        .toResponseBody("application/json".toMediaType()),
                )
                .build()
        }
        val session = ReplaySession(
            baseUrl = "https://ingest.example.test",
            apiKey = "k",
            installIdProvider = { vectorId },
            provider = dev.everframe.config.ReplayConfigProvider.make(
                baseUrl = "https://ingest.example.test",
                apiKey = "k",
                fetcher = fetcher,
                installIdProvider = { vectorId },
            ),
        )
        session.refreshConfigNow()
        assertTrue(urls.isNotEmpty())
        assertTrue(urls[0].contains("installId=$vectorId"))
    }

    /**
     * Deliberately omits `provider` — that is the entire point. `ReplaySession`'s
     * default `provider` expression (`ReplayConfigProvider.make(baseUrl, apiKey,
     * defaultFetcher, installIdProvider = installIdProvider)`) is the ONLY
     * production line this task added the forwarding to; the test above never
     * lets it run because it supplies its own provider. A real MockWebServer
     * stands in for the network so `defaultFetcher`'s real OkHttpClient (see
     * `ReplaySession`'s companion object) has somewhere to land — no fake
     * fetcher is injectable here, since injecting one would just reintroduce
     * the same bypass this test exists to avoid.
     */
    @Test
    fun `omitting provider still threads the install id through the default provider expression`() = runBlocking {
        val server = MockWebServer()
        server.start()
        try {
            server.enqueue(
                MockResponse().setResponseCode(200).setBody(
                    """{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1}""",
                ),
            )
            val session = ReplaySession(
                baseUrl = server.url("/").toString(),
                apiKey = "k",
                locallyDisabled = false,
                installIdProvider = { vectorId },
            )
            session.refreshConfigNow()

            val recorded = server.takeRequestOrFail()
            assertTrue(
                "expected the default provider's request path to carry installId=$vectorId, got ${recorded.path}",
                recorded.path?.contains("installId=$vectorId") == true,
            )
        } finally {
            server.shutdown()
        }
    }
}
