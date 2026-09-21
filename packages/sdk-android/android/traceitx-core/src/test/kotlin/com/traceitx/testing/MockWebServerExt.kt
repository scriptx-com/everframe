// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// MockWebServer.takeRequest() blocks INDEFINITELY when no request arrives.
// That turned a routing bug into three CI runs stuck for 4.5+ hours on the
// "JVM unit tests" step, with no output to say what was wrong. A bounded wait
// converts the same bug into a named failure in seconds.
//
// `CompanionAttributionFlowTest` already used `takeRequest(5, TimeUnit.SECONDS)`
// directly; this extension is that pattern, shared, with a message.
package com.traceitx.testing

import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import java.util.concurrent.TimeUnit

/**
 * Take the next recorded request, failing the test if none arrives in time.
 *
 * NEVER replace a call to this with `takeRequest()`: an unbounded wait cannot
 * fail, it can only hang the job. And never soften the throw to a `?.` chain —
 * that turns "no request arrived" into a silent pass, which is worse than the
 * hang because it looks green.
 */
internal fun MockWebServer.takeRequestOrFail(seconds: Long = 5): RecordedRequest =
    takeRequest(seconds, TimeUnit.SECONDS)
        ?: throw AssertionError(
            "expected a request within ${seconds}s on $hostName:$port, but none arrived",
        )
