// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The gate that keeps a project with no signing secret from ever presenting an
// identity header. Note the capability negotiation: the server only SENDS the
// identity block when the caller declares `identity` in X-TX-SDK-Features
// (the server configuration contract:131). Miss that and `enabled` is always
// false and the whole feature silently never activates — which is why the
// header token is pinned by a test here rather than left to review.
//
// Kotlin twin of packages/sdk-ios/Tests/TraceItXTests/IdentityConfigGateTests.swift.
// Decode strategy note: unlike iOS's `IdentityConfigWire` (strict decode),
// this file's [IdentityConfigWire] follows the SAME scoped-leniency
// surrogate pattern as [RepliesConfigWire]/[BreadcrumbsConfigWire]/
// [NetworkBodiesConfigWire] in ReplayConfigProvider.kt — consistency with the
// neighbouring Kotlin blocks matters more than cross-platform symmetry of
// decode strategy (see that file's doc comment on IdentityConfigWire).
package com.traceitx.config

import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class IdentityConfigGateTest {

    private val url = "https://traceitx.com/api/config"

    private fun response(body: String): Response {
        val req = Request.Builder().url(url).build()
        return Response.Builder()
            .request(req)
            .protocol(Protocol.HTTP_1_1)
            .code(200)
            .message("OK")
            .body(body.toResponseBody("application/json".toMediaType()))
            .build()
    }

    private suspend fun decode(json: String): ReplayConfig {
        val p = ReplayConfigProvider(
            configUrl = url,
            apiKey = "tx_test_key",
            fetcher = { response(json) },
        )
        p.refresh()
        return p.current
    }

    @Test
    fun `identity enabled true decodes`() = runTest {
        val cfg = decode(
            """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,"identity":{"enabled":true}}""",
        )
        assertTrue(isIdentityEnabled(cfg))
    }

    @Test
    fun `identity enabled false decodes`() = runTest {
        val cfg = decode(
            """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,"identity":{"enabled":false}}""",
        )
        assertFalse(isIdentityEnabled(cfg))
    }

    @Test
    fun `absent identity block is disabled`() = runTest {
        // The ordinary shape for every project without a signing secret, and
        // for every server that predates the block.
        val cfg = decode(
            """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0}""",
        )
        assertFalse(isIdentityEnabled(cfg))
    }

    @Test
    fun `unknown keys inside the identity block do not break decoding`() = runTest {
        val cfg = decode(
            """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                "identity":{"enabled":true,"futureField":"x"}}""",
        )
        assertTrue(isIdentityEnabled(cfg))
    }

    @Test
    fun `the config request declares the identity capability`() = runTest {
        // the server configuration contract:131 gates the identity block on
        // this token. Without it the block never arrives and isIdentityEnabled
        // is false forever — a silent, total no-op.
        var seen: Request? = null
        val p = ReplayConfigProvider(
            configUrl = url,
            apiKey = "tx_test_key",
            fetcher = { req ->
                seen = req
                response("""{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0}""")
            },
        )
        p.refresh()
        val header = seen?.header("X-TX-SDK-Features")
        assertTrue(header?.contains("identity") == true)
        assertTrue(
            "the pre-existing capability must not be dropped",
            header?.contains("networkbodies") == true,
        )
        assertEquals(ReplayConfigProvider.SDK_FEATURES_HEADER_VALUE, header)
    }
}
