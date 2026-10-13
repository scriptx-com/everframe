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
            EverframeBrowserDriver(js("(config) => ({})"), js("({})"), "1.0.0", "2.0.0")
        }
    }

    @Test fun requiresARealHostAppVersion() {
        val capture = js("({ captureScreenshot: async () => null })")
        for (invalid in listOf("", "   ")) {
            assertFailsWith<IllegalArgumentException> {
                EverframeBrowserDriver(js("(config) => ({})"), capture, "1.0.0", invalid)
            }
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
        assertEquals("key", config.sdkKey as String)
        assertEquals("2.0.0", config.appVersion as String)
        assertEquals(true, config.releaseHealth?.enabled as? Boolean)
        assertEquals(capture, config.visualCapture)
        client.kill()
    }

    @Test fun passesTheDebugBuildOverrideToWebSdkOnlyWhenSet() {
        val configs = mutableListOf<dynamic>()
        val init: dynamic = { received: dynamic ->
            configs.add(received)
            js("({ destroy() {} })")
        }
        val capture = js("({ captureScreenshot: async () => null })")
        val unset = EverframeKmp(EverframeBrowserDriver(init, capture, "0.10.2", "2.0.0"))
        assertTrue(unset.start(EverframeKmpConfig("app", "key")))
        assertEquals("undefined", jsTypeOf(configs[0].debugBuild))
        val set = EverframeKmp(EverframeBrowserDriver(init, capture, "0.10.2", "2.0.0"))
        assertTrue(set.start(EverframeKmpConfig("app", "key", debugBuild = true)))
        assertEquals(true, configs[1].debugBuild as Boolean)
    }

    @Test fun identicalStartsReuseTheBrowserCollectorButOptOutRestartsIt() {
        val enabled = mutableListOf<Boolean>()
        var destroyed = 0
        val init: dynamic = { config: dynamic ->
            enabled += config.releaseHealth.enabled as Boolean
            val handle = js("({})")
            handle.destroy = { destroyed += 1 }
            handle
        }
        val capture = js("({ captureScreenshot: async () => null })")
        val client = EverframeKmp(EverframeBrowserDriver(init, capture, "1.2.1", "2.0.0"))
        assertTrue(client.start(EverframeKmpConfig("app", "key")))
        assertTrue(client.start(EverframeKmpConfig("app", "key")))
        assertEquals(listOf(true), enabled)
        assertEquals(0, destroyed)
        assertTrue(client.start(EverframeKmpConfig("app", "key", releaseHealth = false)))
        assertEquals(listOf(true, false), enabled)
        assertEquals(1, destroyed)
        assertTrue(client.start(EverframeKmpConfig("app", "key", releaseHealth = false)))
        assertEquals(listOf(true, false), enabled)
        client.kill()
        assertEquals(2, destroyed)
    }

    @Test fun changedBuildAndCredentialsRestartTheBrowserCollector() {
        val starts = mutableListOf<String>()
        var destroyed = 0
        val init: dynamic = { config: dynamic ->
            starts += "${config.sdkKey}:${config.debugBuild}"
            val handle = js("({})")
            handle.destroy = { destroyed += 1 }
            handle
        }
        val capture = js("({ captureScreenshot: async () => null })")
        val client = EverframeKmp(EverframeBrowserDriver(init, capture, "1.2.1", "2.0.0"))
        assertTrue(client.start(EverframeKmpConfig("app", "first")))
        assertTrue(client.start(EverframeKmpConfig("app", "first", debugBuild = true)))
        assertTrue(client.start(EverframeKmpConfig("other", "second", debugBuild = true)))
        assertEquals(listOf("first:undefined", "first:true", "second:true"), starts)
        assertEquals(2, destroyed)
        client.kill()
    }

    @Test fun replacementDriverAppliesItsSettingsToThePageSingleton() {
        val configs = mutableListOf<dynamic>()
        var singleton: dynamic = null
        var destroyed = 0
        val init: dynamic = { config: dynamic ->
            if (singleton == null) {
                configs.add(config)
                val created = js("({})")
                created.destroy = { destroyed += 1; singleton = null }
                singleton = created
            }
            singleton
        }
        val capture = js("({ captureScreenshot: async () => null })")
        val first = EverframeKmp(EverframeBrowserDriver(init, capture, "1.2.1", "2.0.0"))
        val replacement = EverframeKmp(EverframeBrowserDriver(init, capture, "1.2.1", "3.0.0"))
        assertTrue(first.start(EverframeKmpConfig("app", "key")))
        assertTrue(replacement.start(EverframeKmpConfig("app", "key", debugBuild = true, releaseHealth = false)))
        assertEquals(2, configs.size)
        assertEquals(false, configs.last().releaseHealth.enabled as Boolean)
        assertEquals(true, configs.last().debugBuild as Boolean)
        assertEquals("3.0.0", configs.last().appVersion as String)
        assertEquals(1, destroyed)
        // A superseded driver must reinitialize, even when its own requested config is unchanged.
        assertTrue(first.start(EverframeKmpConfig("app", "key")))
        assertEquals(3, configs.size)
        assertEquals(true, configs.last().releaseHealth.enabled as Boolean)
        assertEquals("2.0.0", configs.last().appVersion as String)
        assertEquals(2, destroyed)
        replacement.kill()
        assertEquals(2, destroyed)
        assertTrue(singleton != null)
        first.kill()
        assertEquals(3, destroyed)
    }

    @Test fun healthOptOutPreservesHandledErrorsAndDestroy() {
        var config: dynamic = null
        var handledMessage: String? = null
        var destroyed = 0
        val handle = js("({})")
        handle.captureException = { error: dynamic -> handledMessage = error.message as String }
        handle.destroy = { destroyed += 1 }
        val init: dynamic = { received: dynamic -> config = received; handle }
        val capture = js("({ captureScreenshot: async () => null })")
        val client = EverframeKmp(EverframeBrowserDriver(init, capture, "1.2.1", "0.0.0"))
        assertTrue(client.start(EverframeKmpConfig("app", "key", releaseHealth = false)))
        assertEquals(false, config.releaseHealth.enabled as Boolean)
        assertEquals("0.0.0", config.appVersion as String)
        client.captureException(IllegalStateException("handled failure"))
        assertEquals("handled failure", handledMessage)
        client.kill()
        client.kill()
        assertEquals(1, destroyed)
        assertFailsWith<IllegalStateException> { client.captureException(IllegalStateException("after kill")) }
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
        val client = EverframeKmp(EverframeBrowserDriver(init, capture, "0.10.2", "2.0.0"))
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
        val client = EverframeKmp(EverframeBrowserDriver(init, capture, "0.10.2", "2.0.0"))
        kotlin.test.assertFalse(client.start(EverframeKmpConfig("app", "key", "staging")))
        kotlin.test.assertFalse(initialized)
    }
}
