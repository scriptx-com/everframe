// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.kmp

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class EverframeKmpTest {
    private class FakeDriver : EverframeNativeDriver {
        val calls = mutableListOf<String>()
        override fun start(appId: String, sdkKey: String): Boolean { calls += "start:$appId:$sdkKey"; return true }
        override fun setUser(id: String?, email: String?, displayName: String?) { calls += "user:$id:$email" }
        override fun recordScreen(name: String) { calls += "screen:$name" }
        override fun addBreadcrumb(message: String, kind: String?, level: String?) { calls += "breadcrumb:$kind:$level:$message" }
        override fun captureHandledError(code: String) { calls += "error:$code" }
        override fun captureException(error: Throwable) { calls += "exception:${error.message}" }
        override fun openReporter(completion: (EverframeReportOutcome) -> Unit) {
            calls += "open"
            completion(EverframeReportOutcome("cancelled"))
        }
        override fun kill() { calls += "kill" }
    }

    @Test fun routesContextAndReporterThroughTheNativeDriver() {
        val driver = FakeDriver()
        val client = EverframeKmp(driver)
        assertTrue(client.start(EverframeKmpConfig("app", "key")))
        client.setUser("user", "user@example.test")
        client.recordScreen("Home")
        client.addBreadcrumb("tap")
        var outcome: EverframeReportOutcome? = null
        client.openReporter { outcome = it }
        client.kill()
        assertEquals("cancelled", outcome?.status)
        assertEquals(listOf("start:app:key", "user:user:user@example.test", "screen:Home", "breadcrumb:null:null:tap", "open", "kill"), driver.calls)
    }

    @Test fun rejectsLiveConfigurationAndPostKillReporter() {
        val client = EverframeKmp(FakeDriver())
        assertFalse(client.start(EverframeKmpConfig("app", "key", "production")))
        assertFalse(client.start(EverframeKmpConfig("", "key")))
        assertTrue(client.start(EverframeKmpConfig("app", "key")))
        client.kill()
        assertFailsWith<IllegalStateException> { client.openReporter {} }
        assertFailsWith<IllegalStateException> { client.captureHandledError("catalog_load_failed") }
        assertFailsWith<IllegalStateException> { client.recordNetworkOperation("catalog_fetch", "GET", 200, 1) }
    }

    @Test fun forwardsSafeHandledErrorsAndNetworkOperations() {
        val driver = FakeDriver()
        val client = EverframeKmp(driver)
        assertTrue(client.start(EverframeKmpConfig("app", "key")))
        client.captureHandledError("catalog_load_failed")
        client.recordNetworkOperation("catalog_fetch", "GET", 503, 42)
        assertEquals("error:catalog_load_failed", driver.calls[1])
        assertEquals("breadcrumb:network:error:GET catalog_fetch 503 42ms", driver.calls[2])
    }

    @Test fun rejectsUrlsAndUnboundedNetworkOrErrorDetails() {
        val client = EverframeKmp(FakeDriver())
        assertTrue(client.start(EverframeKmpConfig("app", "key")))
        assertFailsWith<IllegalArgumentException> { client.captureHandledError("https://host/private?token=secret") }
        assertFailsWith<IllegalArgumentException> { client.recordNetworkOperation("/users/123", "GET", 200, 2) }
        assertFailsWith<IllegalArgumentException> { client.recordNetworkOperation("catalog_fetch", "TRACE", 200, 2) }
        assertFailsWith<IllegalArgumentException> { client.recordNetworkOperation("catalog_fetch", "GET", 700, 2) }
        assertFailsWith<IllegalArgumentException> { client.recordNetworkOperation("catalog_fetch", "GET", 200, -1) }
    }

    @Test fun forwardsOriginalHandledThrowable() {
        val driver = FakeDriver()
        val client = EverframeKmp(driver)
        assertTrue(client.start(EverframeKmpConfig("app", "key")))
        client.captureException(IllegalStateException("safe probe failure"))
        assertEquals("exception:safe probe failure", driver.calls[1])
    }
}
