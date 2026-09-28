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
        override fun addBreadcrumb(message: String, kind: String?, level: String?) { calls += "breadcrumb:$message" }
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
        assertEquals(listOf("start:app:key", "user:user:user@example.test", "screen:Home", "breadcrumb:tap", "open", "kill"), driver.calls)
    }

    @Test fun rejectsLiveConfigurationAndPostKillReporter() {
        val client = EverframeKmp(FakeDriver())
        assertFalse(client.start(EverframeKmpConfig("app", "key", "production")))
        assertFalse(client.start(EverframeKmpConfig("", "key")))
        assertTrue(client.start(EverframeKmpConfig("app", "key")))
        client.kill()
        assertFailsWith<IllegalStateException> { client.openReporter {} }
    }
}
