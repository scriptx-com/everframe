// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// MAI meter Plan 2b-i — the config read carries the derived install
// identifier as a query parameter, and, the load-bearing case, a failure
// anywhere in producing it must never break the config read. That endpoint is
// this SDK's remote kill switch: an uncounted install is cosmetic, a config
// fetch that never fires is not.
//
// The supplier is evaluated PER FETCH rather than baked into the stored URL,
// which is what lets Plan 2b-ii add a daily gate behind it without touching
// this signature again.
//
// @RunWith(RobolectricTestRunner::class) is required here, not decorative:
// the "evaluated on every fetch" case below calls InstallIdentifier.derive,
// which goes through android.util.Base64 — a stub outside Robolectric that
// returns null and trips an NPE the production runCatching then swallows,
// silently collapsing both fetches to the unmodified URL. Same pattern as
// the neighbouring ReplayConfigProviderTest.kt:33-34 and
// InstallIdentifierTest.kt:37-38.
package dev.everframe.config

import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

private class RecordingFetcher : ConfigFetcher {
    val urls = mutableListOf<String>()
    override fun fetch(request: Request): Response {
        urls += request.url.toString()
        return Response.Builder()
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
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ConfigInstallIdTest {

    private val base = "https://ingest.example.test"
    private val vectorId = "iYgxBgJiRf1n_ekekB7M9g03ulCzNx2O4jfL8PWLegA"

    @Test
    fun `the request url carries the install id query parameter`() = runBlocking {
        val fetcher = RecordingFetcher()
        val provider = ReplayConfigProvider.make(
            baseUrl = base, apiKey = "k", fetcher = fetcher, installIdProvider = { vectorId },
        )
        provider.refresh()
        assertEquals(1, fetcher.urls.size)
        assertTrue(fetcher.urls[0].startsWith("$base/api/config?"))
        assertTrue(fetcher.urls[0].contains("installId=$vectorId"))
    }

    @Test
    fun `a null supplier result leaves the url untouched`() = runBlocking {
        val fetcher = RecordingFetcher()
        ReplayConfigProvider.make(
            baseUrl = base, apiKey = "k", fetcher = fetcher, installIdProvider = { null },
        ).refresh()
        assertEquals("$base/api/config", fetcher.urls[0])
    }

    @Test
    fun `an empty supplier result leaves the url untouched`() = runBlocking {
        val fetcher = RecordingFetcher()
        ReplayConfigProvider.make(
            baseUrl = base, apiKey = "k", fetcher = fetcher, installIdProvider = { "" },
        ).refresh()
        assertEquals("$base/api/config", fetcher.urls[0])
    }

    @Test
    fun `the default supplier sends nothing so existing call sites are unchanged`() = runBlocking {
        val fetcher = RecordingFetcher()
        ReplayConfigProvider.make(baseUrl = base, apiKey = "k", fetcher = fetcher).refresh()
        assertFalse(fetcher.urls[0].contains("installId"))
    }

    @Test
    fun `the supplier is evaluated on every fetch, not once`() = runBlocking {
        // Plan 2b-ii puts a per-UTC-day gate behind this supplier. If the
        // value were resolved once and stored, that gate could never take
        // effect — which is exactly how the web SDK shipped in 2a.
        val fetcher = RecordingFetcher()
        var n = 0
        val provider = ReplayConfigProvider(
            configUrl = "$base/api/config",
            apiKey = "k",
            fetcher = fetcher,
            ttlMs = 0L,
            installIdProvider = { InstallIdentifier.derive(ByteArray(1) { (++n).toByte() }) },
        )
        provider.refresh()
        provider.refresh(force = true)
        assertEquals(2, fetcher.urls.size)
        assertNotEquals(fetcher.urls[0], fetcher.urls[1])
    }

    @Test
    fun `a throwing supplier never breaks the config read`() = runBlocking {
        // The kill-switch invariant: refresh() must still reach the network
        // and report success.
        val fetcher = RecordingFetcher()
        val ok = ReplayConfigProvider.make(
            baseUrl = base, apiKey = "k", fetcher = fetcher,
            installIdProvider = { throw IllegalStateException("boom") },
        ).refresh()
        assertTrue(ok)
        assertEquals("$base/api/config", fetcher.urls[0])
    }
}
