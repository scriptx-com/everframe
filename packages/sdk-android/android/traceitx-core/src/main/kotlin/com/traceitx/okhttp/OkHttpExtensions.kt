// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Public Kotlin entry point for network capture. Per CONTEXT D-03 (locked) —
// this is the ONE and only customer-facing surface for attaching TraceItX to
// network calls; the SDK does not own, ship, or auto-discover any
// OkHttpClient. The customer calls
//
//     val client = OkHttpClient.Builder()
//         .addTraceItXInterceptor()
//         .addInterceptor(otherCustomerInterceptor)
//         .build()
//
// on a builder THEY own. Order in the chain is fully under customer control.
package com.traceitx.okhttp

import okhttp3.OkHttpClient

/**
 * Attach the TraceItX OkHttp Interceptor to this builder. Returns the same
 * builder so the call is chainable with `addInterceptor` / `connectTimeout` /
 * `build` as usual.
 *
 * The interceptor is constructed via the package-internal constructor on
 * TraceItXInterceptor — customers cannot subclass or instantiate the
 * interceptor directly, which keeps the public surface area minimal and
 * ensures every captured network call flows through the canonical entry point.
 */
public fun OkHttpClient.Builder.addTraceItXInterceptor(): OkHttpClient.Builder =
    this.addInterceptor(TraceItXInterceptor())
