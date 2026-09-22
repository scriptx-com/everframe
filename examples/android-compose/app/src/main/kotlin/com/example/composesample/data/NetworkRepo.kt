// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// NetworkRepo — demonstrates the customer pattern for opting in to TraceItX
// network capture: build an OkHttpClient with `.addTraceItXInterceptor()` and
// route HTTP traffic through it. The interceptor records request/response
// metadata to NetworkRingBuffer (Plan 05-04); when the user opens the reporter
// the captured rows are baked into the envelope.
package com.example.composesample.data

import com.traceitx.okhttp.addTraceItXInterceptor
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request

object NetworkRepo {

    private val client: OkHttpClient =
        OkHttpClient.Builder()
            .addTraceItXInterceptor()
            .build()

    suspend fun demoFetch(): Result<String> = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder()
                .url("https://httpbin.org/get?source=traceitx-sample")
                .build()
            client.newCall(request).execute().use { resp ->
                resp.body?.string()?.take(120) ?: "<empty>"
            }
        }
    }
}
