// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.health

import dev.everframe.outbox.OutboxEntry
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Uses the encrypted entry's original route. Redirects never move its bearer credential. */
internal class OkHttpHealthTransport : HealthTransport {
    private val client = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS).readTimeout(10, TimeUnit.SECONDS)
        .callTimeout(15, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).build()

    override fun prepare(entry: OutboxEntry): () -> Deferred<Int> {
        require(entry.identitySubject == null && entry.attachmentRefs.isEmpty() && entry.envelopeBytes.size <= 8192)
        val request = Request.Builder().url(entry.endpoint)
            .header("Authorization", "Bearer ${entry.sdkKey}")
            .header("X-Everframe-Idempotency-Key", entry.idempotencyKey)
            .post(entry.envelopeBytes.toRequestBody("application/json".toMediaType())).build()
        val call = client.newCall(request)
        val result = CompletableDeferred<Int>()
        result.invokeOnCompletion { if (result.isCancelled) call.cancel() }
        return {
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) { result.complete(0) }
                override fun onResponse(call: Call, response: Response) {
                    response.use { result.complete(it.code) }
                }
            })
            result
        }
    }
}
