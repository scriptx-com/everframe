// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

import dev.everframe.protocol.generated.BodySkipped
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Test

class NetworkBodyTeeDecideTest {

    private val allowlist = listOf("application/json", "text/*")

    private fun response(
        contentType: String? = "application/json",
        bodyText: String = "{\"a\":1}",
        headers: Map<String, String> = emptyMap(),
        withBody: Boolean = true,
    ): Response {
        val builder = Response.Builder()
            .request(Request.Builder().url("https://example.test/x").build())
            .protocol(Protocol.HTTP_1_1)
            .code(200)
            .message("OK")
        if (contentType != null) {
            builder.header("Content-Type", contentType)
        }
        headers.forEach { (k, v) -> builder.header(k, v) }
        builder.body(
            if (!withBody) "".toResponseBody(null)
            else bodyText.toResponseBody(contentType?.toMediaType()),
        )
        return builder.build()
    }

    @Test
    fun allowedJsonIsCaptured() {
        assertEquals(NetworkBodyTee.Decision.Capture, NetworkBodyTee.decide(response(), allowlist))
    }

    @Test
    fun emptyBodyIsNone() {
        // contentLength() == 0 — nothing to capture, no reqId, no entry.
        assertEquals(NetworkBodyTee.Decision.None, NetworkBodyTee.decide(response(bodyText = ""), allowlist))
    }

    @Test
    fun disallowedContentTypeSkips() {
        assertEquals(
            NetworkBodyTee.Decision.Skip(BodySkipped.ContentType),
            NetworkBodyTee.decide(response(contentType = "image/png"), allowlist),
        )
    }

    @Test
    fun missingContentTypeSkips() {
        assertEquals(
            NetworkBodyTee.Decision.Skip(BodySkipped.ContentType),
            NetworkBodyTee.decide(response(contentType = null), allowlist),
        )
    }

    @Test
    fun appAppliedContentEncodingIsUnsupported() {
        assertEquals(
            NetworkBodyTee.Decision.Skip(BodySkipped.Unsupported),
            NetworkBodyTee.decide(response(headers = mapOf("Content-Encoding" to "gzip")), allowlist),
        )
    }

    @Test
    fun identityContentEncodingIsStillCaptured() {
        assertEquals(
            NetworkBodyTee.Decision.Capture,
            NetworkBodyTee.decide(response(headers = mapOf("Content-Encoding" to "identity")), allowlist),
        )
    }

    // Content-Encoding is checked BEFORE content-type: a gzipped PNG reports
    // the encoding problem, which is the one a reader can act on.
    @Test
    fun contentEncodingOutranksContentType() {
        assertEquals(
            NetworkBodyTee.Decision.Skip(BodySkipped.Unsupported),
            NetworkBodyTee.decide(
                response(contentType = "image/png", headers = mapOf("Content-Encoding" to "gzip")),
                allowlist,
            ),
        )
    }
}
