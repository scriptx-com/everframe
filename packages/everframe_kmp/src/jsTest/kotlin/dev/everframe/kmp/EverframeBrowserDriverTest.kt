// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.kmp

import kotlin.test.Test
import kotlin.test.assertFailsWith
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class EverframeBrowserDriverTest {
    @Test fun requiresRendererOwnedCaptureBeforeCreatingBrowserDriver() {
        assertFailsWith<IllegalArgumentException> {
            EverframeBrowserDriver(js("(config) => ({})"), js("({})"), "1.0.0")
        }
    }

    @Test fun passesKmpIdentityAndCaptureProviderToWebSdk() {
        var config: dynamic = null
        val init: dynamic = { received: dynamic ->
            config = received
            js("({ destroy() {} })")
        }
        val capture = js("({ captureScreenshot: async () => null })")
        val driver = EverframeBrowserDriver(init, capture, "0.10.2", "2.0.0")
        val client = EverframeKmp(driver)
        assertTrue(client.start(EverframeKmpConfig("app", "key")))
        assertEquals("everframe-kmp", config.sdkName as String)
        assertEquals("0.10.2", config.sdkVersion as String)
        assertEquals("key", config.apiKey as String)
        assertEquals(capture, config.visualCapture)
        client.kill()
    }

    @Test fun routesSharedContextToBrowserHandle() {
        val calls = mutableListOf<String>()
        val handle = js("({})")
        handle.setUser = { user: dynamic -> calls += "user:${user.id}" }
        handle.recordScreen = { name: String -> calls += "screen:$name" }
        handle.addBreadcrumb = { breadcrumb: dynamic -> calls += "crumb:${breadcrumb.message}" }
        handle.destroy = { calls += "destroy" }
        val init: dynamic = { _: dynamic -> handle }
        val capture = js("({ captureScreenshot: async () => null })")
        val client = EverframeKmp(EverframeBrowserDriver(init, capture, "0.10.2"))
        assertTrue(client.start(EverframeKmpConfig("app", "key")))
        client.setUser("user-1")
        client.recordScreen("Home")
        client.addBreadcrumb("tap")
        client.kill()
        assertEquals(listOf("user:user-1", "screen:Home", "crumb:tap", "destroy"), calls)
    }

    @Test fun rejectsNonProductionEnvironmentWithoutStartingAProductionBrowserBundle() {
        var initialized = false
        val init: dynamic = { _: dynamic -> initialized = true; js("({})") }
        val capture = js("({ captureScreenshot: async () => null })")
        val client = EverframeKmp(EverframeBrowserDriver(init, capture, "0.10.2"))
        kotlin.test.assertFalse(client.start(EverframeKmpConfig("app", "key", "staging")))
        kotlin.test.assertFalse(initialized)
    }
}
