// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.diagnostics

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.everframe.Everframe
import dev.everframe.config.CaptureConfig
import dev.everframe.config.EverframeConfig
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class RecoveredStallFacadeTest {
    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private fun start() = Everframe.start(context, EverframeConfig(appId = "test-app-id",
        sdkKey = "txx_live_test1234567890", capture = CaptureConfig(logs = false)))
    private class Session : RecoveredStallSession {
        var closed = false
        override val ready get() = !closed
        override fun start() = Unit
        override fun close() { closed = true }
    }
    // Observe the actual process owner without adding a production test injection API.
    private fun install(): Session {
        val field = RecoveredStallRuntime::class.java.getDeclaredField("owner").apply { isAccessible = true }
        val owner = field.get(RecoveredStallRuntime) as RecoveredStallOwner
        val epoch = Everframe.currentStartEpochVolatile()
        val token = owner.request(epoch, true)
        return Session().also { session -> assertTrue(owner.enable(token, epoch, { true }) { session }) }
    }
    @After fun cleanup() { Everframe.kill(); RecoveredStallRuntime.boundary() }

    @Test fun defaultOffAndExplicitDisableSynchronouslyCloseCurrentOwner() {
        start(); assertFalse(Everframe.isRecoveredStallObserverReady())
        val active = install(); assertTrue(Everframe.isRecoveredStallObserverReady())
        Everframe.setRecoveredStallObserverEnabled(false)
        assertTrue(active.closed); assertFalse(Everframe.isRecoveredStallObserverReady())
    }
    @Test @Config(sdk = [24, 25]) fun unsupportedPlatformCannotKeepAnObserverEnabled() {
        start(); val active = install()
        Everframe.setRecoveredStallObserverEnabled(true)
        assertTrue(active.closed)
        assertFalse(Everframe.isRecoveredStallObserverReady())
    }
    @Test @Config(sdk = [26]) fun supportedPlatformCanKeepItsExplicitOptIn() {
        start(); val active = install()
        Everframe.setRecoveredStallObserverEnabled(true)
        assertFalse(active.closed)
        assertTrue(Everframe.isRecoveredStallObserverReady())
    }
    @Test fun replacementStartRequiresAnotherExplicitOptIn() {
        start(); val active = install(); start()
        assertTrue(active.closed); assertFalse(Everframe.isRecoveredStallObserverReady())
    }
    @Test fun killSynchronouslyClosesEvenBeforeAsyncWorkCanFinish() {
        start(); val active = install(); Everframe.kill()
        assertTrue(active.closed); assertFalse(Everframe.isRecoveredStallObserverReady())
    }
}
