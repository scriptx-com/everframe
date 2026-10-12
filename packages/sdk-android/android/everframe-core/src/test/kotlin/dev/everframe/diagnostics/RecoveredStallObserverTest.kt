// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.diagnostics

import org.junit.Assert.*
import org.junit.Test

class RecoveredStallObserverTest {
    private fun clock(ms: Long, sleep: Long = 0, wallDrift: Long = 0) =
        StallClockSample(ms, ms + sleep, 1_700_000_000_000 + ms + wallDrift)
    private class Fixture(budget: RecoveredStallBudget = RecoveredStallBudget()) {
        val posted = mutableListOf<Long>()
        val removed = mutableListOf<Long>()
        val observations = mutableListOf<RecoveredStallObservation>()
        var postAllowed = true
        var accepted = true
        val observer = RecoveredStallObserver(budget,
            postProbe = { posted.add(it); postAllowed }, removeProbe = { removed.add(it) },
            onRecovered = { observations.add(it); accepted })
    }
    private fun recover(f: Fixture, duration: Long, start: Long = 0) {
        f.observer.tick(clock(start), true)
        val id = f.posted.lastOrNull() ?: return
        var t = start + 1000
        while (t < start + duration) { f.observer.tick(clock(t), true); t += 1000 }
        f.observer.acknowledge(id, clock(start + duration))
        f.observer.tick(clock(start + duration), true)
    }
    @Test fun `only executed threshold-qualified probes yield one recovered observation`() {
        for ((duration, expected) in listOf(4999L to 0, 5000L to 1, 60000L to 1, 60001L to 0)) {
            val f = Fixture(); recover(f, duration)
            assertEquals("duration=$duration", expected, f.observations.size)
            if (expected == 1) {
                assertEquals(duration, f.observations.single().probeDelayMs)
                assertEquals(1_700_000_000_000, f.observations.single().queuedAtMs)
                f.observer.acknowledge(f.posted.first(), clock(duration + 1))
                f.observer.tick(clock(duration + 1000), true)
                assertEquals(1, f.observations.size)
            }
        }
    }
    @Test fun `unrecovered stall never emits and never accumulates pending probes`() {
        val f = Fixture(); f.observer.tick(clock(0), true)
        for (t in 1L..59L) f.observer.tick(clock(t * 1000), true)
        assertEquals(1, f.posted.size); assertTrue(f.observations.isEmpty())
        f.observer.invalidate(); assertEquals(f.posted, f.removed)
        f.observer.acknowledge(f.posted.single(), clock(60000))
        f.observer.tick(clock(60000), false); assertTrue(f.observations.isEmpty())
    }
    @Test fun `quick acknowledgements permit one new probe per sample without reports`() {
        val f = Fixture(); f.observer.tick(clock(0), true)
        f.observer.acknowledge(f.posted.last(), clock(10)); f.observer.tick(clock(1000), true)
        assertEquals(2, f.posted.size); assertTrue(f.observations.isEmpty())
    }
    @Test fun `eligibility loss discards the old interval even if foreground returns before recovery`() {
        val f = Fixture(); f.observer.tick(clock(0), true); val old = f.posted.single()
        f.observer.tick(clock(1000), false); f.observer.tick(clock(2000), true)
        for (t in 3L..6L) f.observer.tick(clock(t * 1000), true)
        f.observer.acknowledge(old, clock(7000)); f.observer.tick(clock(7000), true)
        assertTrue(f.observations.isEmpty()); assertTrue(f.removed.contains(old))
    }
    @Test fun `watchdog starvation and late recovery callbacks cannot imply main thread stall`() {
        val f = Fixture(); f.observer.tick(clock(0), true); val old = f.posted.single()
        f.observer.acknowledge(old, clock(6000)); f.observer.tick(clock(6000), true)
        assertTrue(f.observations.isEmpty()); assertTrue(f.removed.contains(old))
        val g = Fixture(); g.observer.tick(clock(0), true)
        for (t in 1L..4L) g.observer.tick(clock(t * 1000), true)
        g.observer.acknowledge(g.posted.single(), clock(7000)); g.observer.tick(clock(7000), true)
        assertTrue(g.observations.isEmpty())
    }
    @Test fun `sleep and wall clock discontinuities invalidate observation`() {
        for (sleep in listOf(true, false)) {
            val f = Fixture(); f.observer.tick(clock(0), true); val old = f.posted.single()
            for (t in 1L..4L) f.observer.tick(clock(t * 1000), true)
            val changed = clock(5000, if (sleep) 2000 else 0, if (sleep) 0 else 2000)
            f.observer.acknowledge(old, changed); f.observer.tick(changed, true)
            assertTrue(f.observations.isEmpty()); assertTrue(f.removed.contains(old))
        }
    }
    @Test fun `rejected post and invalidated callbacks produce no observation`() {
        val f = Fixture(); f.postAllowed = false; f.observer.tick(clock(0), true)
        f.observer.acknowledge(f.posted.first(), clock(5000)); f.observer.tick(clock(5000), true)
        assertTrue(f.observations.isEmpty())
    }
    @Test fun `process budget survives new observers and caps accepted observations at four`() {
        val budget = RecoveredStallBudget(); val counts = mutableListOf<Int>()
        for (i in 0L..4L) { val f = Fixture(budget); recover(f, 5000, i * 65000); counts.add(f.observations.size); f.observer.invalidate() }
        assertEquals(listOf(1, 1, 1, 1, 0), counts)
    }
    @Test fun `cooldown prevents repeated bursts but failed admission does not consume accepted budget`() {
        val budget = RecoveredStallBudget(); val f = Fixture(budget); recover(f, 5000)
        val during = Fixture(budget); recover(during, 5000, 10000); assertTrue(during.observations.isEmpty())
        val failed = Fixture(budget); failed.accepted = false; recover(failed, 5000, 65000)
        val retry = Fixture(budget); recover(retry, 5000, 71000); assertEquals(1, retry.observations.size)
    }
}
