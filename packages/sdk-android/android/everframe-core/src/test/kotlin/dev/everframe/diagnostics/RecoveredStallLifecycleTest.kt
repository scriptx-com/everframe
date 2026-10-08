// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.diagnostics

import android.os.Handler
import android.os.Looper
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
@LooperMode(LooperMode.Mode.PAUSED)
class RecoveredStallLifecycleTest {
    private class Owner : LifecycleOwner {
        val registry = LifecycleRegistry(this)
        override val lifecycle: Lifecycle get() = registry
    }
    private class Ticker : StallTicker {
        var tick: (() -> Unit)? = null
        var starts = 0
        var closed = false
        override fun start(action: () -> Unit) { tick = action; starts++ }
        override fun stop() { tick = null }
        override fun close() { closed = true; stop() }
    }
    private class Fixture(foreground: Boolean = true) {
        val owner = Owner().also {
            it.registry.handleLifecycleEvent(Lifecycle.Event.ON_CREATE)
            if (foreground) it.registry.handleLifecycleEvent(Lifecycle.Event.ON_START)
        }
        val ticker = Ticker()
        var allowed = true
        var eligible = true
        var now = 0L
        val admitted = mutableListOf<RecoveredStallObservation>()
        val session = AndroidRecoveredStallSession(
            main = Handler(Looper.getMainLooper()), owner = { owner }, ticker = ticker,
            clock = { StallClockSample(now, now, 1_700_000_000_000 + now) },
            allowed = { allowed }, platformEligible = { eligible }, budget = RecoveredStallBudget(),
            admit = { admitted.add(it); true },
        )
        fun idle() { shadowOf(Looper.getMainLooper()).idle() }
        fun tick(at: Long) { now = at; ticker.tick?.invoke() }
    }

    @Test fun closeBeforePostedInstallLeavesNoLifecycleOrTicker() {
        val f = Fixture()
        f.session.start(); f.session.close(); f.idle()
        assertFalse(f.session.ready)
        assertEquals(0, f.owner.registry.observerCount)
        assertEquals(0, f.ticker.starts)
        assertTrue(f.ticker.closed)
    }

    @Test fun gateLossBeforePostedInstallLeavesNoLifecycleOrTicker() {
        val f = Fixture()
        f.session.start(); f.allowed = false; f.idle()
        assertFalse(f.session.ready)
        assertEquals(0, f.owner.registry.observerCount)
        assertEquals(0, f.ticker.starts)
    }

    @Test fun backgroundInstallHasNoTimerAndTransitionsRemovePendingProbe() {
        val f = Fixture(false)
        f.session.start(); f.idle()
        assertTrue(f.session.ready)
        assertNull(f.ticker.tick)
        f.owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_START)
        f.tick(0)
        f.owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
        assertNull(f.ticker.tick)
        f.now = 6_000; f.idle()
        f.owner.registry.handleLifecycleEvent(Lifecycle.Event.ON_START)
        f.tick(6_000); f.idle(); f.tick(7_000)
        assertTrue(f.admitted.isEmpty())
        f.session.close(); f.idle()
        assertEquals(0, f.owner.registry.observerCount)
        assertTrue(f.ticker.closed)
    }

    @Test fun recoveredMainCallbackOnlyAcknowledgesAndWorkerAdmits() {
        val f = Fixture()
        f.session.start(); f.idle()
        for (i in 0..6) f.tick(i * 1_000L)
        f.idle()
        assertTrue(f.admitted.isEmpty())
        f.tick(7_000)
        assertEquals(listOf(6_000L), f.admitted.map { it.probeDelayMs })
        f.session.close(); f.idle()
    }

    @Test fun finalPlatformVetoDiscardsRecoveredCallback() {
        val f = Fixture()
        f.session.start(); f.idle()
        for (i in 0..6) f.tick(i * 1_000L)
        f.idle(); f.eligible = false; f.tick(7_000)
        assertTrue(f.admitted.isEmpty())
        f.session.close(); f.idle()
    }
}
