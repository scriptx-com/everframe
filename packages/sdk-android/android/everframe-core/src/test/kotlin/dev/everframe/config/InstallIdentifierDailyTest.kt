// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// MAI meter Plan 2b-ii, D3 + opt-out parity. Two contracts:
//
//   1. The identifier rides at most one config read per UTC day. Dedupe is an
//      OPTIMISATION — the server's unique constraint makes repeat sends free
//      and it deduplicates per calendar MONTH, so a lost day costs nothing.
//      Nothing here may retry or queue.
//   2. Opt-out is a CLIENT VETO: when off, nothing is derived, nothing is
//      stored, and nothing is sent.
//
// The clock is injected in every case — no sleeps.
//
// Run locally:
//   cd packages/sdk-android/android && \
//     ./gradlew :everframe-core:testDebugUnitTest --tests 'dev.everframe.config.InstallIdentifierDaily*'
package dev.everframe.config

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class InstallIdentifierDailyTest {

    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private val dayMs = 86_400_000L

    private fun prefs() =
        context.getSharedPreferences(InstallIdentifier.PREFS_NAME, Context.MODE_PRIVATE)

    @Test
    fun `yields the identifier on the first call of a day`() {
        val supplier = InstallIdentifier.makeSupplier(context, enabled = true, now = { 10 * dayMs })
        assertNotNull(supplier())
    }

    @Test
    fun `yields nothing on a second call the same day`() {
        val supplier = InstallIdentifier.makeSupplier(context, enabled = true, now = { 10 * dayMs })
        assertNotNull(supplier())
        assertNull(supplier())
        assertNull(supplier())
    }

    @Test
    fun `yields again once the UTC day rolls over`() {
        var nowMs = 10 * dayMs
        val supplier = InstallIdentifier.makeSupplier(context, enabled = true, now = { nowMs })
        assertNotNull(supplier())
        nowMs = 11 * dayMs - 1   // last millisecond of the same UTC day
        assertNull(supplier())
        nowMs = 11 * dayMs       // first millisecond of the next UTC day
        assertNotNull(supplier())
    }

    @Test
    fun `the marker is recorded at hand-over, not on a successful response`() {
        InstallIdentifier.makeSupplier(context, enabled = true, now = { 10 * dayMs })()
        assertEquals("10", prefs().getString(InstallIdentifier.DAY_KEY, null))
    }

    @Test
    fun `a malformed marker is treated as not sent today`() {
        // Over-sending is free — the server's unique constraint absorbs it.
        // Trusting garbage could suppress an install for a whole month.
        prefs().edit().putString(InstallIdentifier.DAY_KEY, "not-a-number").commit()
        assertNotNull(InstallIdentifier.makeSupplier(context, enabled = true, now = { 10 * dayMs })())
    }

    @Test
    fun `disabled yields nothing and writes nothing at all`() {
        val supplier = InstallIdentifier.makeSupplier(context, enabled = false, now = { 10 * dayMs })
        assertNull(supplier())
        assertNull(prefs().getString(InstallIdentifier.SEED_KEY, null))
        assertNull(prefs().getString(InstallIdentifier.DAY_KEY, null))
    }

    @Test
    fun `the config flag defaults to enabled and can be turned off`() {
        val key = "txx_live_" + "x".repeat(32)
        assertTrue(EverframeConfig(appId = "app", sdkKey = key).installIdentifierEnabled)
        assertFalse(
            EverframeConfig(appId = "app", sdkKey = key, installIdentifierEnabled = false)
                .installIdentifierEnabled,
        )
    }
}
