// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Instrumented test for the TXScreen() navigation marker composable
// (spec 2026-07-14). Instrumented rather than JVM because LaunchedEffect
// requires a real composition + frame clock.
package dev.everframe

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.core.app.ApplicationProvider
import dev.everframe.capture.NavigationBreadcrumbAdapter
import dev.everframe.capture.sharedBreadcrumbBuffer
import dev.everframe.protocol.generated.BreadcrumbKind
import dev.everframe.shared.SharedData
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test

class TXScreenInstrumentedTest {

    @get:Rule
    val composeTestRule = createComposeRule()

    @Before
    fun setUp() {
        // RedactionEngine.redact() (invoked on every breadcrumb add) reads
        // SharedData's lazily-cached JSON — must be primed before the first
        // recordScreen() call, same as BreadcrumbTapNavAdaptersTest's
        // Robolectric setUp.
        SharedData.init(ApplicationProvider.getApplicationContext())
        sharedBreadcrumbBuffer.applyConfig(null)
        sharedBreadcrumbBuffer.clear()
        Everframe.captureGate = true
        NavigationBreadcrumbAdapter.__resetForTesting()
    }

    @After
    fun tearDown() {
        sharedBreadcrumbBuffer.applyConfig(null)
        sharedBreadcrumbBuffer.clear()
        Everframe.captureGate = false
        NavigationBreadcrumbAdapter.__resetForTesting()
    }

    private fun navMessages(): List<String> {
        sharedBreadcrumbBuffer.freeze()
        return (sharedBreadcrumbBuffer.takeFrozen() ?: emptyList())
            .filter { it.kind == BreadcrumbKind.Navigation }
            .map { it.message }
    }

    @Test
    fun switchingScreensEmitsOneTransitionCrumb() {
        var route by mutableStateOf("Home")
        composeTestRule.setContent {
            // State-based navigation — the exact pattern the SDK could
            // never auto-capture before screen markers.
            when (route) {
                "Home" -> TXScreen(name = "Home")
                "Detail" -> TXScreen(name = "Detail")
            }
        }
        composeTestRule.waitForIdle()
        composeTestRule.runOnUiThread { route = "Detail" }
        composeTestRule.waitForIdle()
        assertEquals(listOf("Home → Detail"), navMessages())
    }

    @Test
    fun inactiveMarkerEmitsOnlyOnActiveRisingEdge() {
        var active by mutableStateOf(false)
        composeTestRule.setContent {
            TXScreen(name = "Home")          // seeds previous = Home
            TXScreen(name = "Tab2", active = active)
        }
        composeTestRule.waitForIdle()
        assertTrue("inactive marker must not emit", navMessages().isEmpty())
        composeTestRule.runOnUiThread { active = true }
        composeTestRule.waitForIdle()
        assertEquals(listOf("Home → Tab2"), navMessages())
    }
}
