// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.vitals

import com.traceitx.config.VitalsConfig
import com.traceitx.vitals.wire.SessionSummaryDims
import com.traceitx.vitals.wire.VitalsPlayerEvent
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class VitalsRuntimeTest {
    private class FakeScheduler : VitalsScheduler {
        override fun repeat(intervalMs: Long, tick: () -> Unit) = AutoCloseable { }
    }

    private open class FakeIntegration : PlayerIntegration {
        override val library = "fake"; override val version = "1"
        var attached = 0
        override fun attach(ctx: PlayerIntegrationContext): Boolean { attached++; onAttach(); return true }
        open fun onAttach() {}
        override fun snapshot(onResult: (PlayerSnapshot?) -> Boolean) { onResult(null) }
        override fun startupTimings(): StartupTimings? = null
        override fun describe(ctx: PlayerIntegrationContext) {}
        /**
         * Codex round-8, #1 — COUNTED, and never a failure. `detach()` is now
         * called on integrations that never attached (a revoked or cancelled
         * pending registration), so the fake has to tolerate that and let a
         * test see it happened. See `PlayerIntegration.detach`'s contract.
         */
        var detached = 0
        override fun detach() { detached++ }
    }

    private fun controller() = VitalsController(
        VitalsController.Deps(
            localConfig = VitalsConfig(),
            dims = SessionSummaryDims("android", "1", "0.8.0"),
            transport = { object : VitalsSink { override fun send(body: String) = Unit; override fun close() = Unit } },
            scheduler = FakeScheduler(),
            samplerFactory = { onSample, onTick ->
                object : ResourceSampler(handler = android.os.Handler(android.os.Looper.getMainLooper()), onSample = onSample, onTick = onTick) {}
            },
            lifecycle = { _, _ -> null },
            now = { 1_000_000L },
            random = { 0.0 },
            newSessionId = { "sid" },
            collectorOverrides = { it },
        ),
    )

    /**
     * Codex round-4, #2 — the revocation generation `kill()` bumps, driven
     * directly. It used to be a counter this object bumped when its own
     * teardown ran, which meant a delayed `kill()` tail classified everything
     * queued between its `stateLock` bump and its arrival here as pre-kill.
     * The tag now comes from `TraceItX._killGeneration`; these tests move it
     * the way `kill()` does — synchronously, BEFORE the teardown arrives.
     */
    private var killGen = 0L

    @Before
    fun setUp() {
        VitalsRuntime.resetForTesting()
        VitalsRuntime.__setKillGenerationForTesting { killGen }
        VitalsServerConfigSignal.resetForTesting()
    }

    @After
    fun tearDown() {
        VitalsRuntime.resetForTesting()
        VitalsServerConfigSignal.resetForTesting()
    }

    /**
     * `install()` subscribes the controller to [VitalsServerConfigSignal] on
     * a background dispatcher, so a test must not ALSO call
     * `applyServerConfig` directly: the subscription's own (conflated)
     * delivery of the signal's current value races it and can flip the gate
     * back. Setting the signal BEFORE `install()` makes the subscription's
     * only possible delivery the enabled one; this then waits for it.
     */
    private fun enableVitals() {
        VitalsServerConfigSignal.flow.value = VitalsServerConfig(true, 1.0)
    }

    private fun awaitRunning(c: VitalsController) {
        val deadline = System.currentTimeMillis() + 5_000
        while (!c.isRunning && System.currentTimeMillis() < deadline) Thread.sleep(2)
        assertTrue("the controller never started collecting", c.isRunning)
    }

    /**
     * `isRunning` goes true the instant `collector` is published, which is
     * BEFORE `startCollectorLocked`'s tail announces the live players — that
     * tail runs with the monitor dropped, by design, and here on the signal
     * subscription's own dispatcher. A test that asserts on announcements has
     * to wait for the announcements, not for the collector; waiting only for
     * `isRunning` made these assertions lose a race on a cold JIT.
     */
    private fun attachesIn(c: VitalsController, atLeast: Int): List<VitalsPlayerEvent> {
        val deadline = System.currentTimeMillis() + 5_000
        var found: List<VitalsPlayerEvent> = emptyList()
        while (System.currentTimeMillis() < deadline) {
            found = c.currentStamp()?.entries.orEmpty()
                .filterIsInstance<VitalsPlayerEvent>().filter { it.type == "player_attach" }
            if (found.size >= atLeast) break
            Thread.sleep(2)
        }
        assertTrue("expected at least $atLeast player_attach, saw ${found.size}", found.size >= atLeast)
        return found
    }

    @Test
    fun `a trackPlayer call before install is honoured once install runs`() {
        val fake = FakeIntegration()
        val handle = VitalsRuntime.trackPlayer(fake, "main")
        assertEquals("", handle.id)

        enableVitals()
        val c = controller()
        VitalsRuntime.install(c)

        // Drained synchronously by install(): the integration is attached
        // and the deferred handle now delegates to a real id.
        assertEquals(1, fake.attached)
        assertEquals("p1", handle.id)

        awaitRunning(c)
        val attach = attachesIn(c, 1)
        assertEquals(1, attach.size)
        assertEquals("p1", attach[0].playerId)
    }

    @Test
    fun `a deferred handle detached before install attaches nothing`() {
        val fake = FakeIntegration()
        val handle = VitalsRuntime.trackPlayer(fake, null)
        handle.detach()

        enableVitals()
        val c = controller()
        VitalsRuntime.install(c)

        assertEquals(0, fake.attached)
        assertEquals("", handle.id)

        awaitRunning(c)
        assertTrue(c.currentStamp()!!.entries.filterIsInstance<VitalsPlayerEvent>().none { it.type == "player_attach" })
    }

    @Test
    fun `trackPlayer delegates immediately once a controller is already installed`() {
        enableVitals()
        val c = controller()
        VitalsRuntime.install(c)
        awaitRunning(c)

        val fake = FakeIntegration()
        val handle = VitalsRuntime.trackPlayer(fake, null)
        assertEquals(1, fake.attached)
        assertEquals("p1", handle.id)
    }

    @Test
    fun `shutdown drops a still-queued registration instead of carrying it into the next session`() {
        // Codex round-1, Critical 3. A player queued during project A's
        // delayed start used to be attached — and described — under project
        // B's controller on the next start(), crossing the boundary kill()
        // drew. The queue is extracted and cleared atomically by shutdown(),
        // and the handles it dropped are marked detached.
        val fake = FakeIntegration()
        val handle = VitalsRuntime.trackPlayer(fake, null)
        killGen++                              // kill()'s stateLock bump
        VitalsRuntime.shutdown()               // ...and its teardown tail
        assertEquals(0, fake.attached)

        val c = controller()
        VitalsRuntime.install(c)
        assertEquals("a registration queued before shutdown() must not attach after it", 0, fake.attached)
        assertEquals("", handle.id)
    }

    @Test
    fun `a registration queued before the first start survives a superseding start's boundary`() {
        // Codex round-3, Critical 1 — the round-2 regression. `TraceItX.start()`
        // shares this shutdown, and round 2 had it clear the queue exactly like
        // `kill()`: so the DOCUMENTED pre-start registration path
        // (`TraceItX.trackPlayer`'s KDoc) detached every handle the instant
        // `start()` ran and never attached anything.
        val fake = FakeIntegration()
        val handle = VitalsRuntime.trackPlayer(fake, null)

        VitalsRuntime.shutdown(dropPending = false)

        val c = controller()
        VitalsRuntime.install(c)
        assertEquals("a pre-start registration must attach once start() installs", 1, fake.attached)
        assertEquals("p1", handle.id)
    }

    @Test
    fun `a registration made after kill attaches to the session the next start installs`() {
        // The post-kill half of the same contract: kill() revokes what was
        // declared for ITS session, then the app declares a player again while
        // awaiting the restart, and the next start() must honour it.
        killGen++; VitalsRuntime.shutdown()    // kill()
        val fake = FakeIntegration()
        val handle = VitalsRuntime.trackPlayer(fake, null)
        VitalsRuntime.shutdown(dropPending = false)   // the next start()'s boundary

        val c = controller()
        VitalsRuntime.install(c)
        assertEquals(1, fake.attached)
        assertEquals("p1", handle.id)
    }

    @Test
    fun `a player attached into the live session is not re-attached by the next start`() {
        // The fourth corner: a registration that was DRAINED belongs to the
        // session that drained it. The next start() detaches it with that
        // controller and must not resurrect it — nothing is left in the queue
        // for the drain to find.
        enableVitals()
        val a = controller()
        VitalsRuntime.install(a)
        awaitRunning(a)
        val fake = FakeIntegration()
        VitalsRuntime.trackPlayer(fake, null)
        assertEquals(1, fake.attached)

        VitalsRuntime.shutdown(dropPending = false)
        val b = controller()
        VitalsRuntime.install(b)
        awaitRunning(b)

        assertEquals("a live registration must not be re-attached into the next session", 1, fake.attached)
        assertTrue(
            "the next session must not announce a player it never attached",
            b.currentStamp()!!.entries.filterIsInstance<VitalsPlayerEvent>().none { it.type == "player_attach" },
        )
    }

    @Test
    fun `shutdown refuses to unpublish a controller a newer start already installed`() {
        // Codex round-3, Critical 2, runtime half. `start(B)` descheduled long
        // enough for `start(C)` to run to completion — install included — used
        // to reach this monitor afterwards and shut C's freshly published
        // controller down on its way past, killing capture for a session that
        // had already begun. The predicate is evaluated INSIDE the monitor, so
        // the decision and the field swap are one critical section.
        enableVitals()
        val c = controller()
        VitalsRuntime.install(c)
        awaitRunning(c)

        VitalsRuntime.shutdown(ifCurrent = { false })

        assertEquals("a superseded shutdown must leave the live controller alone", c, VitalsRuntime.current())
        assertTrue("...and must not stop it collecting", c.isRunning)
    }

    @Test
    fun `a registration made after shutdown is honoured by the next install`() {
        // The other half of Critical 3: a trackPlayer() made while killed is a
        // fresh declaration for the NEXT start(), exactly like one made
        // before the very first start().
        killGen++; VitalsRuntime.shutdown()
        val fake = FakeIntegration()
        val handle = VitalsRuntime.trackPlayer(fake, null)

        val c = controller()
        VitalsRuntime.install(c)
        assertEquals(1, fake.attached)
        assertEquals("p1", handle.id)
    }

    @Test
    fun `install refuses and shuts down a controller whose start epoch is already stale`() {
        // Codex round-1, Critical 2 — the predicate is evaluated INSIDE the
        // publication critical section, so a kill() landing between a
        // caller's own epoch check and install() cannot publish a controller
        // onto a runtime that has already been torn down.
        val fake = FakeIntegration()
        val handle = VitalsRuntime.trackPlayer(fake, null)

        val c = controller()
        VitalsRuntime.install(c) { false }

        assertNull("a refused install must not become the live controller", VitalsRuntime.current())
        assertEquals("a refused install must not drain the queue", 0, fake.attached)
        assertEquals("", handle.id)

        // The refused controller is shut down, so it cannot keep collecting.
        // Safe to drive directly: a refused install subscribes nothing.
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        assertFalse(c.isRunning)

        // ...and the queued registration is still there for the next real install.
        val next = controller()
        VitalsRuntime.install(next)
        assertEquals(1, fake.attached)
        assertEquals("p1", handle.id)
    }

    @Test
    fun `an attach that re-enters trackPlayer during the drain neither deadlocks nor loses a registration`() {
        // Final review, I2. The drain used to run under VitalsRuntime's own
        // monitor, so customer `attach()` code calling back into
        // TraceItX.trackPlayer() from ANOTHER thread blocked on it. Here the
        // re-entrant call is made from attach() itself: the assertion that
        // matters is that both integrations end up registered, which is only
        // true once the drain publishes `controller` before it runs and
        // stops holding the monitor while it does.
        val second = FakeIntegration()
        val first = object : FakeIntegration() {
            override fun onAttach() { VitalsRuntime.trackPlayer(second, "second") }
        }
        val handle = VitalsRuntime.trackPlayer(first, "first")

        enableVitals()
        val c = controller()
        val done = Thread { VitalsRuntime.install(c) }
        done.start()
        done.join(5_000)
        assertFalse("install() deadlocked", done.isAlive)

        assertEquals(1, first.attached)
        assertEquals(1, second.attached)
        assertEquals("p1", handle.id)

        awaitRunning(c)
        // Both are announced exactly once. The ORDER is publication order,
        // not id order: since Important 2, a registration is only published
        // once its `attach()` has RETURNED, and `second` attaches entirely
        // inside `first`'s attach — so the inner player is live first. Ids
        // still record the call order (`first` is p1).
        val attach = attachesIn(c, 2)
        assertEquals(setOf("p1", "p2"), attach.map { it.playerId }.toSet())
        assertEquals(2, attach.size)
    }

    @Test
    fun `a deferred handle detached before its delegate arrives detaches the delegate instead of storing it`() {
        // Final review, I4. Scripting the true concurrent interleaving is
        // not reliable; the invariant that closes the race is sequential and
        // is what is asserted here.
        val handle = VitalsRuntime.DeferredPlayerHandle()
        handle.detach()
        assertTrue(handle.detachedEarly)

        var detached = 0
        val real = object : PlayerHandle {
            override val id = "p9"
            override fun track(name: String, data: Any?) {}
            override fun detach() { detached++ }
        }
        handle.attachDelegate(real)

        assertEquals(1, detached)
        assertNull(handle.delegate)
        assertEquals("", handle.id)
    }


    // ---- Codex round-4 ----

    @Test
    fun `a delayed kill tail revokes only what was declared before its own generation bump`() {
        // Codex round-4, #2. `kill()` bumps the revocation generation inside
        // its `stateLock` critical section and only reaches the vitals
        // teardown much later, after unbounded customer teardown. The
        // generation used to be bumped HERE instead, so everything declared in
        // that window was classified as pre-kill and revoked — including
        // declarations made for the NEXT session, which is exactly the case
        // the round-3 contract promises to honour.
        val before = FakeIntegration()
        val beforeHandle = VitalsRuntime.trackPlayer(before, null)

        killGen++                              // kill()'s stateLock bump
        val after = FakeIntegration()
        val afterHandle = VitalsRuntime.trackPlayer(after, null)
        VitalsRuntime.shutdown()               // ...and its much-delayed tail

        val c = controller()
        VitalsRuntime.install(c)

        assertEquals("a declaration made for the killed session must be revoked", 0, before.attached)
        assertEquals("", beforeHandle.id)
        assertEquals("a declaration made after the kill must survive to the next start", 1, after.attached)
        assertEquals("p1", afterHandle.id)
    }

    @Test
    fun `an install that beats the kill tail to the queue revokes the pre-kill entries itself`() {
        // The other half of #2: the partition is by generation, so it does not
        // matter which of {the kill tail, the next install} reaches the queue
        // first. Here `start()` wins the race and the kill's teardown never
        // gets to the queue at all — the pre-kill declaration must still not
        // attach into the new session.
        val before = FakeIntegration()
        val beforeHandle = VitalsRuntime.trackPlayer(before, null)
        killGen++
        val after = FakeIntegration()
        val afterHandle = VitalsRuntime.trackPlayer(after, null)

        val c = controller()
        VitalsRuntime.install(c)

        assertEquals("a pre-kill declaration must not cross the boundary the kill drew", 0, before.attached)
        assertEquals("", beforeHandle.id)
        assertEquals(1, after.attached)
        assertEquals("p1", afterHandle.id)
    }

    @Test
    fun `a superseded kill tail neither unpublishes the live controller nor clears the signal`() {
        // Codex round-4, #2, the other failure this opens: `kill()`'s tail is
        // unconditional, so a `start()` completing while it ran had its
        // freshly installed controller shut down and its server config
        // cleared — the start returned successfully and vitals were dead for
        // the whole session. Both steps are now guarded on the epoch the kill
        // established, and a stale kill touches neither.
        enableVitals()
        val c = controller()
        VitalsRuntime.install(c)
        awaitRunning(c)

        val staleKill = { false }
        VitalsRuntime.shutdown(dropPending = true, ifCurrent = staleKill)
        VitalsServerConfigSignal.publish(null, staleKill)

        assertEquals("a superseded kill must leave the live controller alone", c, VitalsRuntime.current())
        assertTrue("...and must not stop it collecting", c.isRunning)
        assertNotNull("...nor clear the gate the newer session published", VitalsServerConfigSignal.flow.value)
    }

    @Test
    fun `the drain attaches to the controller that is current, not to the one this install published`() {
        // Codex round-4, #3. `install(B)` snapshots the queue under the
        // monitor and then runs customer `attach()` for every entry outside
        // it. An `install(C)` landing in that window shut B down, and the rest
        // of B's drain then registered onto a dead controller — inert handles
        // that never announce, while C, the live session, never saw those
        // players at all.
        //
        // Made deterministic by superseding B from inside the FIRST drained
        // entry's `attach()`.
        enableVitals()
        val b = controller()
        val cc = controller()
        val second = FakeIntegration()
        val first = object : FakeIntegration() {
            override fun onAttach() {
                if (VitalsRuntime.current() !== b) return
                VitalsRuntime.shutdown(dropPending = false)   // a superseding start()'s boundary
                VitalsRuntime.install(cc)
            }
        }
        val firstHandle = VitalsRuntime.trackPlayer(first, "first")
        val secondHandle = VitalsRuntime.trackPlayer(second, "second")

        VitalsRuntime.install(b)

        assertEquals("the superseding controller must be the live one", cc, VitalsRuntime.current())
        assertEquals(
            "the rest of the drain must attach into the CURRENT controller, not the shut-down one",
            1,
            second.attached,
        )
        // Codex round-8, #3 — `first` lands in the live session too, and it is
        // why the ids moved: B refused it at publication time (it had been
        // shut down from inside its own `attach()`), the drain re-selected C,
        // and `first` attached there — taking p1 — instead of being written
        // off to an inert delegate. Before round 8 it was lost outright and
        // `second` took p1.
        assertEquals("the refused entry is re-attached, not consumed", 2, first.attached)
        assertEquals("p1", firstHandle.id)
        assertEquals("p2", secondHandle.id)
        awaitRunning(cc)
        assertEquals("the live session must see both drained players", 2, attachesIn(cc, 2).size)
    }

    // ---- Codex round-8, #3: a shutdown refusal never consumes a registration ----

    @Test
    fun `a registration refused by a superseded controller is retried against the current one`() {
        // THE finding. The drain lifts the entry out of `pending`, selects B,
        // releases the runtime monitor, and a superseding start shuts B down
        // and installs C before `B.trackPlayer()` gets to publish. B answered
        // with an INERT handle — indistinguishable from "your integration
        // refused" — which the drain committed as the deferred delegate and
        // advanced past. No kill revoked that declaration, yet C never saw it
        // and no later start could recover it: the entry was already out of
        // the queue.
        //
        // Scripted at the exact seam: the superseding install happens inside
        // this entry's own `attach()`, so B is shut down between the drain's
        // monitor release and B's publication check.
        enableVitals()
        val b = controller()
        val cc = controller()
        val fake = object : FakeIntegration() {
            override fun onAttach() {
                if (VitalsRuntime.current() !== b) return
                VitalsRuntime.shutdown(dropPending = false)
                VitalsRuntime.install(cc)
            }
        }
        val handle = VitalsRuntime.trackPlayer(fake, "main")

        VitalsRuntime.install(b)

        assertEquals("the superseding controller is the live one", cc, VitalsRuntime.current())
        assertEquals("B refused for shutdown; C took the registration", 2, fake.attached)
        assertEquals("the handle must not be left inert", "p1", handle.id)
        awaitRunning(cc)
        assertEquals("the live session must see the recovered player", 1, attachesIn(cc, 1).size)
    }

    @Test
    fun `a registration refused with no controller left is requeued for the next start`() {
        // The other half: nothing is current when the refusal comes back, so
        // the entry goes back to the queue rather than being consumed. The
        // next `start()` honours it — which is the contract a pre-start
        // declaration has always had.
        val b = controller()
        val fake = object : FakeIntegration() {
            override fun onAttach() {
                if (VitalsRuntime.current() === b) VitalsRuntime.shutdown(dropPending = false)
            }
        }
        val handle = VitalsRuntime.trackPlayer(fake, "main")

        VitalsRuntime.install(b)

        assertEquals("nothing may be committed to the shut-down controller", "", handle.id)
        assertEquals("the declaration is back in the queue", 1, VitalsRuntime.pendingCountForTesting())

        val next = controller()
        VitalsRuntime.install(next)
        assertEquals("p1", handle.id)
    }

    @Test
    fun `a direct trackPlayer refused for shutdown queues instead of returning an inert handle`() {
        // The direct-delegate path (`VitalsRuntime.trackPlayer` with a
        // controller already installed) has the same seam: the controller can
        // be shut down between the monitor read and the call. A `null` there
        // must fall through to the queueing path, never to the caller.
        val b = controller()
        VitalsRuntime.install(b)
        val fake = object : FakeIntegration() {
            override fun onAttach() {
                if (VitalsRuntime.current() === b) VitalsRuntime.shutdown(dropPending = false)
            }
        }

        val handle = VitalsRuntime.trackPlayer(fake, "main")

        assertEquals("", handle.id)
        assertEquals("the caller never gets an inert handle for a shutdown refusal", 1, VitalsRuntime.pendingCountForTesting())

        val next = controller()
        VitalsRuntime.install(next)
        assertEquals("p1", handle.id)
    }

    @Test
    fun `a drain with no controller left requeues the remainder in declaration order`() {
        // The requeue half of #3: if nothing is current at all (a `kill()`
        // took the controller mid-drain), the not-yet-drained entries go back
        // to the FRONT of the queue so the next install honours them in the
        // order they were declared.
        val second = FakeIntegration()
        val third = FakeIntegration()
        val b = controller()
        val first = object : FakeIntegration() {
            override fun onAttach() {
                if (VitalsRuntime.current() === b) VitalsRuntime.shutdown(dropPending = false)
            }
        }
        VitalsRuntime.trackPlayer(first, "first")
        VitalsRuntime.trackPlayer(second, "second")
        VitalsRuntime.trackPlayer(third, "third")

        VitalsRuntime.install(b)
        assertEquals("nothing may attach to a controller that no longer exists", 0, second.attached)
        assertEquals(0, third.attached)

        val next = controller()
        VitalsRuntime.install(next)
        assertEquals(1, second.attached)
        assertEquals(1, third.attached)
    }

    // ---- Codex round-5 ----

    @Test
    fun `a kill landing mid-drain revokes the rest of the snapshot instead of attaching it`() {
        // Codex round-5, #1. `install` lifts the queue OUT of `pending` under
        // the monitor and then runs customer `attach()` for every entry
        // outside it. A `kill()` + `start(B)` completing inside that window
        // left the remaining entries reachable to nobody: not to the kill
        // tail, not to B's own install (they are no longer in `pending`), so
        // the drain went on and attached a pre-kill declaration to B —
        // project A's player collected under project B.
        //
        // Made deterministic by bumping the kill generation from inside the
        // FIRST drained entry's `attach()`, which is exactly that window.
        val second = FakeIntegration()
        val first = object : FakeIntegration() {
            override fun onAttach() { killGen++ }    // kill()'s stateLock bump
        }
        VitalsRuntime.trackPlayer(first, "first")
        val secondHandle = VitalsRuntime.trackPlayer(second, "second")

        val c = controller()
        VitalsRuntime.install(c)

        assertEquals("precondition: the first entry drained before the kill", 1, first.attached)
        assertEquals(
            "an entry revoked mid-drain must never be attached to the controller that outlives the kill",
            0,
            second.attached,
        )
        assertEquals("", secondHandle.id)
    }

    @Test
    fun `trackPlayer queues instead of attaching to a controller a kill has already doomed`() {
        // Codex round-5, #4. `kill()` bumps the revocation generation inside
        // its `stateLock` critical section and leaves the old controller
        // published until its tail — unbounded customer teardown — finally
        // arrives. A `trackPlayer()` in that window delegated to the doomed
        // controller, the kill tail then detached it, and the next `start()`
        // never saw the registration: a player declared for the NEXT session
        // vanished with the old one.
        enableVitals()
        val a = controller()
        VitalsRuntime.install(a)
        awaitRunning(a)

        killGen++                              // kill()'s stateLock bump; the tail is still to come
        val fake = FakeIntegration()
        val handle = VitalsRuntime.trackPlayer(fake, null)
        assertEquals("a declaration made after the kill must not attach to the doomed controller", 0, fake.attached)
        assertEquals("", handle.id)

        VitalsRuntime.shutdown()               // ...the kill's much-delayed tail
        val b = controller()
        VitalsRuntime.install(b)

        assertEquals("...and the next start must honour it", 1, fake.attached)
        assertEquals("p1", handle.id)
    }

    @Test
    fun `a pre-start detach removes its queue entry instead of leaving it in the process-wide list`() {
        // Codex round-5, #5. `detach()` only set `detachedEarly`, so the
        // `Pending` — and through it the integration, and for media3 the
        // ExoPlayer behind it — stayed in the process-wide queue until some
        // later install or kill happened to partition it away. An app that
        // registers and detaches without ever calling `start()` grew that
        // list without bound.
        val fake = FakeIntegration()
        val handle = VitalsRuntime.trackPlayer(fake, null)
        assertEquals("precondition: the registration really was queued", 1, VitalsRuntime.pendingCountForTesting())

        handle.detach()

        assertEquals("a cancelled registration must not be retained", 0, VitalsRuntime.pendingCountForTesting())

        val c = controller()
        VitalsRuntime.install(c)
        assertEquals(0, fake.attached)
        assertEquals("", handle.id)
    }

    // ---- Codex round-6 ----

    // ---- Codex round-8, #1: a revoked or cancelled declaration releases its integration ----

    @Test
    fun `a pending registration revoked by the kill tail releases its integration`() {
        // Round-8, #1. Revoking marked the deferred handle and stopped. The
        // handle has no delegate yet, so nothing told the INTEGRATION the
        // declaration was over — and media3's integration is holding a release
        // observer on the customer's ExoPlayer from `trackPlayer()` time.
        // Every kill left one more of those on a long-lived player.
        val fake = FakeIntegration()
        VitalsRuntime.trackPlayer(fake, null)

        killGen++            // kill()'s stateLock bump
        VitalsRuntime.shutdown(dropPending = true)   // ...and its tail

        assertEquals(0, fake.attached)
        assertEquals("a revoked declaration must release its integration", 1, fake.detached)
    }

    @Test
    fun `a pending registration revoked by the next install releases its integration`() {
        // The other half of round-4 #2's partition: whichever of {the kill
        // tail, the next install} reaches the queue first does the revoking,
        // so both have to release the integration.
        val fake = FakeIntegration()
        VitalsRuntime.trackPlayer(fake, null)
        killGen++

        VitalsRuntime.install(controller())

        assertEquals(0, fake.attached)
        assertEquals("install()'s own revocation must release it too", 1, fake.detached)
    }

    @Test
    fun `a pre-start detach releases its integration as well as its queue entry`() {
        // Round-5 #5 removed the queue entry; round-8 #1 adds the half that
        // reaches the customer's player. An app that declares a player and
        // changes its mind before ever calling `start()` must not leave a
        // subscription on it.
        val fake = FakeIntegration()
        val handle = VitalsRuntime.trackPlayer(fake, null)
        assertEquals(1, VitalsRuntime.pendingCountForTesting())

        handle.detach()

        assertEquals(0, VitalsRuntime.pendingCountForTesting())
        assertEquals("a cancelled declaration must release its integration", 1, fake.detached)
    }

    @Test
    fun `a revoked declaration releases its integration exactly once`() {
        // Two owners could run the teardown: the revocation itself, and the
        // `onCancel` the deferred handle fires as the revocation marks it.
        // Whoever actually LIFTS the entry out of `pending` owns it — the
        // revocation already has, so `onCancel` must find nothing and stand
        // down. Without that condition a customer `detach()` runs twice for
        // one declaration.
        val fake = FakeIntegration()
        VitalsRuntime.trackPlayer(fake, null)
        killGen++

        VitalsRuntime.shutdown(dropPending = true)

        assertEquals(1, fake.detached)
    }

    // ---- Codex round-9, #1: a cancellation that lands mid-drain ----

    @Test
    fun `a registration cancelled while an earlier one is attaching releases its integration`() {
        // Codex round-9, #1. `install()` lifts EVERY queued entry into its
        // local snapshot before the drain runs any customer `attach()`. A
        // customer that detaches a LATER entry's deferred handle from inside
        // an earlier entry's `attach()` therefore fires an `onCancel` that
        // finds nothing in `pending` and — correctly, per round-8 #1 — stands
        // down, because the drain now owns that entry. The drain then saw
        // `detachedEarly` and skipped it WITHOUT `integration.detach()`, so
        // media3's declaration-time release observer stayed on the customer's
        // ExoPlayer for good; repeated cancellations stack listeners up.
        val second = FakeIntegration()
        var secondHandle: PlayerHandle? = null
        val first = object : FakeIntegration() {
            override fun onAttach() { secondHandle?.detach() }
        }
        VitalsRuntime.trackPlayer(first, null)
        secondHandle = VitalsRuntime.trackPlayer(second, null)
        assertEquals("precondition: both are queued for the next start", 2, VitalsRuntime.pendingCountForTesting())

        VitalsRuntime.install(controller())

        assertEquals("the first entry still attaches", 1, first.attached)
        assertEquals("the cancelled entry is never attached", 0, second.attached)
        assertEquals("...but it must still release its integration", 1, second.detached)
        assertEquals(0, VitalsRuntime.pendingCountForTesting())
    }

    @Test
    fun `a second shutdown refusal re-selects again rather than dropping the registration`() {
        // The retry is a LOOP, not a single second chance: each refusal is
        // answered by re-selecting whatever controller is current now. Two
        // superseding starts in a row — each triggered from inside the
        // `attach()` of the controller that is about to be shut down — walk
        // the registration from B to C to D, and it must arrive, not be
        // returned to the caller unregistered and unqueued.
        //
        // It also shows why this terminates: every iteration either places
        // the registration, queues it, or moves on to a controller NEWER than
        // the one that refused.
        val b = controller()
        val c2 = controller()
        val c3 = controller()
        val fake = object : FakeIntegration() {
            override fun onAttach() {
                val cur = VitalsRuntime.current()
                if (cur === b) { VitalsRuntime.shutdown(dropPending = false); VitalsRuntime.install(c2) }
                if (cur === c2) { VitalsRuntime.shutdown(dropPending = false); VitalsRuntime.install(c3) }
            }
        }
        VitalsRuntime.install(b)

        val handle = VitalsRuntime.trackPlayer(fake, "main")

        assertEquals("the third controller is the live one", c3, VitalsRuntime.current())
        assertEquals("B and C both refused for shutdown; D took it", 3, fake.attached)
        assertEquals("p1", handle.id)
        assertEquals(0, VitalsRuntime.pendingCountForTesting())
    }

    @Test
    fun `a drain refused by the controller that is still published requeues instead of retrying it`() {
        // The termination guard. `install`/`shutdown` publish the replacement
        // inside their critical section and shut the old controller down
        // outside it, so a controller that refuses has normally been replaced
        // by the time the monitor is retaken — but the drain does not ASSUME
        // that. Here the controller is shut down without ever being
        // unpublished (`VitalsController.shutdown()` called directly), so
        // re-selecting it would get the same refusal for ever; the remainder
        // requeues for the next install instead.
        val b = controller()
        val fake = object : FakeIntegration() {
            override fun onAttach() { b.shutdown() }
        }
        val handle = VitalsRuntime.trackPlayer(fake, null)

        // Bounded on purpose: without the guard this drain re-selects the
        // same refusing controller for ever, and a test that HANGS is worse
        // than one that fails — CI would time out instead of naming the
        // regression. Robolectric owns the test thread, so the bound is a
        // daemon worker plus a joined wait, not `@Test(timeout = …)`.
        val worker = Thread { VitalsRuntime.install(b) }.apply { isDaemon = true; start() }
        worker.join(10_000)
        assertFalse("the drain must terminate: a re-selected refusing controller would loop for ever", worker.isAlive)

        assertEquals("", handle.id)
        assertEquals("the entry goes back to the queue", 1, VitalsRuntime.pendingCountForTesting())
    }

    @Test
    fun `a kill bumping inside install's own critical section cannot stamp the controller as live`() {
        // Codex round-6, #2. `install()` evaluated `isCurrent()` and then read
        // `killGeneration()`; both reach for `TraceItX.stateLock` on their own,
        // so a `kill()` bumping between them stamped the DOOMED controller
        // with the generation that had just revoked it. Round-5 #4's guard
        // then read as satisfied: post-kill `trackPlayer()` delegated to that
        // controller instead of queueing, and those registrations died with
        // the kill's delayed teardown.
        //
        // The bump is driven from inside the predicate itself, which is
        // exactly the window — `kill()` bumps synchronously inside its own
        // `stateLock` section, so a bump "during" either read is the real
        // interleaving, not a contrivance.
        val c = controller()
        VitalsRuntime.install(c, isCurrent = { killGen++; true })

        val fake = FakeIntegration()
        val handle = VitalsRuntime.trackPlayer(fake, "main")

        assertEquals(
            "a controller stamped with a generation that post-dates it must not accept registrations",
            0,
            fake.attached,
        )
        assertEquals("", handle.id)
        assertEquals("...the registration waits for the next session instead", 1, VitalsRuntime.pendingCountForTesting())
    }
}
