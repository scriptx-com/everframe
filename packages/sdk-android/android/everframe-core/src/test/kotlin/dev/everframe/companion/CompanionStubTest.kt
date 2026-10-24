// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Everframe Companion has been removed. Its documented API stays as
// deprecated no-op stubs: these tests pin that the stubs never connect, stay
// idle, warn once, and that the wire changes hold (no `companionbadge`
// feature token, a config carrying `companionBadge` still decodes).
@file:Suppress("DEPRECATION")

package dev.everframe.companion

import dev.everframe.Everframe
import dev.everframe.config.EverframeConfig
import dev.everframe.config.ReplayConfigProvider
import dev.everframe.config.ReporterTrigger
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CompanionStubTest {
    private val server = MockWebServer()

    @Before
    fun setUp() {
        CompanionDeprecation.emittedCount = 0
        server.start()
    }

    @After
    fun tearDown() {
        CompanionDeprecation.emittedCount = 0
        server.shutdown()
    }

    @Test
    fun startCompanionWarnsOnceAndStaysUnpaired() {
        Everframe.startCompanion()
        Everframe.startCompanion()
        Everframe.stopCompanion()

        assertEquals(1, CompanionDeprecation.emittedCount)
        assertEquals(CompanionState.Unpaired, Everframe.companion.state.value)
        assertNull(Everframe.companion.pairUrl.value)
        assertNull(Everframe.companion.code.value)
        assertNull(Everframe.companion.attachedUserName.value)
        assertNull(Everframe.companion.resolvedName.value)
        assertNull(Everframe.companion.attachChallenge.value)
        assertEquals("the stubs make no request", 0, server.requestCount)
    }

    @Test
    fun stopBeforeStartIsSafe() {
        Everframe.stopCompanion()
        Everframe.stopCompanion()
        assertEquals(0, CompanionDeprecation.emittedCount)
    }

    @Test
    fun configWithCompanionBadgeBlockStillDecodes() = runTest {
        val url = "https://everframe.dev/api/config"
        val body = """{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
            "companionBadge":{"enabled":true,"position":"top-left"},
            "captureHotkey":{"enabled":true,"binding":"Shift+B","replay":true}}"""
        val provider = ReplayConfigProvider(configUrl = url, sdkKey = "k", fetcher = {
            Response.Builder()
                .request(Request.Builder().url(url).build())
                .protocol(Protocol.HTTP_1_1)
                .code(200)
                .message("OK")
                .body(body.toResponseBody("application/json".toMediaType()))
                .build()
        }, now = { 0L })

        assertTrue(provider.refresh())
        assertTrue(provider.current.replayEnabled)
        assertEquals(true, provider.current.captureHotkey?.enabled)
        assertEquals("Shift+B", provider.current.captureHotkey?.binding)
    }

    @Test
    fun featuresHeaderOmitsCompanionBadge() {
        assertFalse(ReplayConfigProvider.SDK_FEATURES_HEADER_VALUE.contains("companionbadge"))
    }

    @Test
    fun reporterTriggerCompanionStillEncodes() {
        assertEquals("companion", ReporterTrigger.Companion.value)
        assertEquals(ReporterTrigger.Companion, ReporterTrigger.fromValue("companion"))
    }

    @Test
    fun configAcceptsDeprecatedCompanionParams() {
        val config = EverframeConfig(
            appId = "a",
            sdkKey = "k",
            companionDeviceId = "x",
            companionBadgeEnabled = false,
            companionBadgePosition = "top-left",
        )
        assertEquals("x", config.companionDeviceId)
        assertFalse(config.companionBadgeEnabled)
    }
}
