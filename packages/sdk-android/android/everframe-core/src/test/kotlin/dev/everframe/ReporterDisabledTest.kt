// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Crash-only sessions (spec 2026-10-12): `report.open()` in a session started with reporterEnabled = false
// fails with ReporterDisabledException instead of resolving as cancelled, because the host asked for
// something its own configuration turned off. A companion bond does not lift it.
package dev.everframe

import android.os.Looper
import dev.everframe.config.EverframeConfig
import dev.everframe.config.ReportResult
import dev.everframe.config.ReporterDisabledException
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ReporterDisabledTest {
    private val cancelled = ReportResult.Cancelled("user")
    private var opened = 0
    private var previousResolver: (suspend () -> ReportResult)? = null

    private fun config(reporterEnabled: Boolean) =
        EverframeConfig(appId = "a", sdkKey = "k", reporterEnabled = reporterEnabled)

    @Before fun setUp() {
        previousResolver = Everframe.report.__resolver
        Everframe.report.__wireResolverForTesting { opened++; cancelled }
        Everframe.captureGate = true
        Everframe.__setConfigForTesting(config(reporterEnabled = false))
    }

    @After fun tearDown() {
        Everframe.report.__resolver = previousResolver
        Everframe.kill()
    }

    private fun openFailure(): Throwable? = runBlocking { runCatching { Everframe.report.open() }.exceptionOrNull() }

    @Test fun openThrowsWithoutReachingTheReporter() {
        val failure = openFailure()
        assertTrue("got $failure", failure is ReporterDisabledException)
        assertTrue(failure is IllegalStateException)
        assertEquals("The reporter is turned off for this session (reporterEnabled = false).", failure!!.message)
        assertEquals(0, opened)
    }

    @Test fun aCompanionBondDoesNotTurnTheEntryPointsBackOn() {
        Everframe.__onCompanionMemberAttached()
        assertTrue(openFailure() is ReporterDisabledException)
        assertEquals(0, opened)
    }

    @Test fun openAsyncDeliversTheErrorToOnError() {
        var result: ReportResult? = null
        var failure: Throwable? = null
        Everframe.report.openAsync(object : Everframe.Callback<ReportResult> {
            override fun onResult(value: ReportResult) { result = value }
            override fun onError(error: Throwable) { failure = error }
        })
        shadowOf(Looper.getMainLooper()).idle()
        assertNull(result)
        assertTrue("got $failure", failure is ReporterDisabledException)
    }

    @Test fun aReportSessionStillOpensTheReporter() = runBlocking {
        Everframe.__setConfigForTesting(config(reporterEnabled = true))
        assertSame(cancelled, Everframe.report.open())
        assertEquals(1, opened)
    }
}
