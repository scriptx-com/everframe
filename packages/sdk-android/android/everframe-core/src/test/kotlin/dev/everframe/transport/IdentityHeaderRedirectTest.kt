// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Independent review, round 13, Serious — `MultipartUploader` attaches
// `X-TX-Identity-Token` (a real person's bearer credential) to the ingest
// POST, and the default OkHttpClient follows redirects. OkHttp strips
// `Authorization` on a cross-origin redirect but does NOT strip custom
// headers, so the identity header rode straight through to whatever host
// a redirect pointed at. `ReportSubmitter.buildIsolatedClient()` now wires
// `IdentityHeaderRedirectGuard`, a network interceptor that strips
// `X-TX-Identity-Token` on any hop whose scheme+host+port differs from the
// call's ORIGINAL request, while leaving same-origin redirects untouched.
//
// This suite drives that fix through the REAL production path — it
// deliberately does NOT reuse this file's sibling `ReportSubmitterTest`'s
// `makeSubmitter()` helper, because that helper constructs its
// `MultipartUploader` around a bare `OkHttpClient.Builder()` that never
// goes through `buildIsolatedClient()` and therefore never picks up the
// guard. Instead these tests build `ReportSubmitter` with `uploader` left
// at its default (`MultipartUploader(buildIsolatedClient())`) so the
// interceptor under test is actually on the request path — mirrors iOS's
// `IdentityHeaderRedirectTests`, which for the same reason drives
// `ReportSubmitter.makeIsolatedSession()` rather than a bespoke session.
package dev.everframe.transport

import dev.everframe.outbox.JceTestOutboxKeyProvider
import dev.everframe.outbox.JvmOutboxFileOps

import dev.everframe.Everframe
import dev.everframe.config.ReportResult
import dev.everframe.config.EverframeConfig
import dev.everframe.identity.IDENTITY_TOKEN_HEADER
import dev.everframe.outbox.JSONLOutbox
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.Base64

class IdentityHeaderRedirectTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var serverA: MockWebServer
    private lateinit var serverB: MockWebServer
    private lateinit var outbox: JSONLOutbox

    @Before
    fun setUp() {
        serverA = MockWebServer()
        serverA.start()
        serverB = MockWebServer()
        serverB.start()
        val outboxFile = File(tmp.newFolder("dev.everframe"), "outbox.jsonl")
        outbox = JSONLOutbox(outboxFile, keys = JceTestOutboxKeyProvider(), ops = JvmOutboxFileOps())
        Everframe.captureGate = true
    }

    @After
    fun tearDown() {
        serverA.shutdown()
        serverB.shutdown()
        Everframe.captureGate = false
    }

    private fun makeConfig(): EverframeConfig = EverframeConfig(
        appId = "app-id",
        sdkKey = "test-sdk-key",
    )

    /** Same helper as `ReportSubmitterTest.jwt` — kept local, this is a leaf test file. */
    private fun jwt(sub: String, expMs: Long): String {
        val payload = buildJsonObject {
            put("sub", sub)
            put("exp", expMs / 1000)
        }
        val header = """{"alg":"HS256","typ":"JWT"}"""
        fun b64(s: String) = Base64.getUrlEncoder().withoutPadding()
            .encodeToString(s.toByteArray(Charsets.UTF_8))
        return "${b64(header)}.${b64(payload.toString())}.not-a-real-signature"
    }

    /**
     * THE test: server A 302s cross-origin (a different MockWebServer, i.e.
     * a different port on 127.0.0.1 — a different origin by the same
     * scheme+host+port definition a browser uses) to server B. `submit`
     * must still report `Submitted` — identity is an enhancement, never a
     * blocker, the report itself must always go through — and server B,
     * the host the redirect actually pointed at, must never see the
     * identity header even though server A did. Mutation-verified:
     * removing `.addNetworkInterceptor(IdentityHeaderRedirectGuard)` from
     * `buildIsolatedClient()` makes this fail with server B's recorded
     * request carrying the real JWT.
     */
    @Test
    fun `a cross-origin redirect strips the identity header but the report still submits`() = runBlocking {
        val now = System.currentTimeMillis()
        val token = jwt(sub = "alice", expMs = now + 300_000)

        serverA.enqueue(
            MockResponse().setResponseCode(302)
                .setHeader("Location", serverB.url("/api/ingest").toString()),
        )
        serverB.enqueue(MockResponse().setResponseCode(200).setBody("{}"))

        val submitter = ReportSubmitter(
            config = makeConfig(),
            outbox = outbox,
            endpointOverride = serverA.url("/api/ingest").toString(),
        )

        val result = submitter.submit(
            envelopeBytes = "{}".toByteArray(),
            idempotencyKey = "idem-redirect-1",
            attachments = emptyList(),
            identitySubject = "alice",
            identityToken = token,
        )

        assertTrue("a cross-origin redirect must not prevent the report from submitting, got $result", result is ReportResult.Submitted)

        val aRequest = serverA.takeRequest()
        assertEquals(
            "fixture sanity: server A (the ORIGINAL destination) must have received the identity header",
            token,
            aRequest.getHeader(IDENTITY_TOKEN_HEADER),
        )
        val bRequest = serverB.takeRequest()
        assertNull(
            "the identity header must never reach a host the redirect carried the request to — it is a real person's bearer credential",
            bRequest.getHeader(IDENTITY_TOKEN_HEADER),
        )
    }

    /**
     * Sanity/non-regression companion: a SAME-origin redirect (same
     * scheme+host+port, only the path changes) must keep the header — this
     * fix must not over-withhold on the common case of an ordinary
     * same-host redirect. Mutation-verified: forcing the guard's
     * `sameOrigin` comparison to always be `false` makes this fail (the
     * header is withheld even though the origin never changed).
     */
    @Test
    fun `a same-origin redirect keeps the identity header`() = runBlocking {
        val now = System.currentTimeMillis()
        val token = jwt(sub = "alice", expMs = now + 300_000)

        serverA.enqueue(
            MockResponse().setResponseCode(302).setHeader("Location", "/api/ingest/"),
        )
        serverA.enqueue(MockResponse().setResponseCode(200).setBody("{}"))

        val submitter = ReportSubmitter(
            config = makeConfig(),
            outbox = outbox,
            endpointOverride = serverA.url("/api/ingest").toString(),
        )

        val result = submitter.submit(
            envelopeBytes = "{}".toByteArray(),
            idempotencyKey = "idem-redirect-2",
            attachments = emptyList(),
            identitySubject = "alice",
            identityToken = token,
        )

        assertTrue("a same-origin redirect must not prevent the report from submitting, got $result", result is ReportResult.Submitted)

        // First request: the original hop that gets redirected.
        val first = serverA.takeRequest()
        assertEquals(
            "fixture sanity: the original request must have carried the identity header",
            token,
            first.getHeader(IDENTITY_TOKEN_HEADER),
        )
        // Second request: the followed same-origin redirect.
        val second = serverA.takeRequest()
        assertEquals(
            "a same-origin redirect (same scheme+host+port, only the path changed) must keep the identity header",
            token,
            second.getHeader(IDENTITY_TOKEN_HEADER),
        )
    }
}
