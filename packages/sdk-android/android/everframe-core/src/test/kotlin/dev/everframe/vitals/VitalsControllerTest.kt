// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.vitals

import androidx.lifecycle.testing.TestLifecycleOwner
import dev.everframe.config.VitalsConfig
import dev.everframe.envelope.InternalLogger
import dev.everframe.vitals.wire.SessionSummaryDims
import dev.everframe.vitals.wire.VitalsCustomEntry
import dev.everframe.vitals.wire.VitalsPlayerEvent
import dev.everframe.vitals.wire.VitalsSample
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class VitalsControllerTest {
    private class FakeScheduler : VitalsScheduler {
        override fun repeat(intervalMs: Long, tick: () -> Unit) = AutoCloseable { }
    }

    private open class FakeIntegration(private val ok: Boolean = true) : PlayerIntegration {
        override val library = "fake"; override val version = "1"
        var ctx: PlayerIntegrationContext? = null; var detached = 0; var described = 0
        var snap: PlayerSnapshot? = null
        /** When set, `snapshot()` stores the callback instead of answering it. */
        var deferSnapshot = false
        var deferred: ((PlayerSnapshot?) -> Boolean)? = null
        /** I11: ongoing spans this integration re-opens on a reseed. */
        var playing = false
        var buffering = false
        override fun attach(ctx: PlayerIntegrationContext): Boolean { this.ctx = ctx; return ok }
        /** Round-4, #7: what the controller ANSWERED — the signal media3 commits its deltas on. */
        var onSnapshotAnswer: ((Boolean) -> Unit)? = null
        override fun snapshot(onResult: (PlayerSnapshot?) -> Boolean) {
            if (deferSnapshot) { deferred = onResult; return }
            val answered = onResult(snap)
            onSnapshotAnswer?.invoke(answered)
        }
        override fun startupTimings(): StartupTimings? = null
        override fun describe(ctx: PlayerIntegrationContext) {
            described++
            ctx.emit("source_change", mapOf("src" to "s", "protocol" to "hls"))
            if (playing) ctx.emit("play")
            if (buffering) ctx.emit("buffer_start")
        }
        override fun detach() { detached++ }
    }

    private val sent = ArrayList<String>()
    private var sinkCloses = 0

    /** A [VitalsSink] that records instead of posting; `close()` is counted (round-2, I14). */
    private fun sink() = object : VitalsSink {
        override fun send(body: String) { sent.add(body) }
        override fun close() { sinkCloses++ }
    }
    private var now = 1_000_000L
    private var sessionIds = 0
    private var draw = 0.0
    private var samplerOnSample: ((VitalsSample) -> Unit)? = null
    private var samplerOnTick: (() -> Unit)? = null
    private var lifecycleObserver: VitalsLifecycleObserver? = null


    /**
     * Codex round-8, #3 — `VitalsController.trackPlayer` answers `PlayerHandle?`
     * now: `null` for a SHUTDOWN refusal (transient — another controller is or
     * will be current) and the inert handle only for an INTEGRATION refusal.
     * Every test below registers against a live controller, so a null here is
     * a bug in the test, not an expected answer.
     */
    private fun VitalsController.track(integration: PlayerIntegration, name: String?): PlayerHandle =
        trackPlayer(integration, name) ?: error("the controller refused the registration for shutdown")

    private fun controller(local: VitalsConfig = VitalsConfig(), withLifecycle: Boolean = false) = VitalsController(
        VitalsController.Deps(
            localConfig = local,
            dims = SessionSummaryDims("android", "1", "0.8.0"),
            transport = { sink() },
            scheduler = FakeScheduler(),
            samplerFactory = { onSample, onTick ->
                samplerOnSample = onSample; samplerOnTick = onTick
                object : ResourceSampler(handler = android.os.Handler(android.os.Looper.getMainLooper()), onSample = onSample, onTick = onTick) {}
            },
            lifecycle = if (withLifecycle) {
                { fg, bg -> VitalsLifecycleObserver(fg, bg).also { lifecycleObserver = it } }
            } else {
                { _, _ -> null }
            },
            now = { now },
            random = { draw },
            newSessionId = { "sid" },
            collectorOverrides = { it },
        ),
    )

    /**
     * Round-4, #7 — a collector whose transport budget fits NOTHING, so every
     * entry is refused. `maxBufferBytes` minus the request-wrapper reserve
     * leaves eight bytes; no entry encodes that small.
     */
    private fun tinyBuffer(base: VitalsCollector.Deps) = VitalsCollector.Deps(
        dims = base.dims, now = base.now, send = base.send, newSessionId = base.newSessionId,
        scheduler = base.scheduler, maxBufferBytes = 40, onRotate = base.onRotate,
    )

    /**
     * Codex round-5, #2 — one entry per chunk, so the collector's `send`
     * (invoked under the collector lock, nested inside `announceLock`) fires
     * on the very entry a test wants to race. It is the only injectable code
     * left inside that critical section now that no customer code runs there.
     */
    private fun oneEntryPerChunk(base: VitalsCollector.Deps) = VitalsCollector.Deps(
        dims = base.dims, now = base.now, send = base.send, newSessionId = base.newSessionId,
        scheduler = base.scheduler, maxEntriesPerChunk = 1, onRotate = base.onRotate,
    )

    private fun payloads() = sent.map { Json.parseToJsonElement(it).jsonObject["payload"]!!.jsonObject }
    private fun kinds() = payloads().map { it["kind"]!!.jsonPrimitive.content }

    @Test
    fun `does nothing until the server says enabled`() {
        val c = controller()
        assertFalse(c.isRunning); assertNull(c.currentStamp())
        c.applyServerConfig(VitalsServerConfig(false, 1.0))
        assertFalse(c.isRunning); assertEquals(0, sent.size)
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        assertTrue(c.isRunning); assertEquals(listOf("summary"), kinds()); assertEquals("sid", c.currentStamp()!!.sessionId)
    }

    @Test
    fun `local opt-out wins over the server`() {
        val c = controller(VitalsConfig(enabled = false))
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        assertFalse(c.isRunning)
    }

    @Test
    fun `sampling draw uses min(local, server) and is never re-rolled`() {
        draw = 0.6
        val c = controller(VitalsConfig(sampleRate = 0.9))
        c.applyServerConfig(VitalsServerConfig(true, 0.5))   // 0.6 < 0.5 false → lost
        assertFalse(c.isRunning)
        draw = 0.1
        c.applyServerConfig(VitalsServerConfig(true, 1.0))   // would win now, but the draw is cached
        assertFalse(c.isRunning)
    }

    @Test
    fun `mid-session flip to disabled stops with a final summary, re-enable starts fresh`() {
        val c = controller()
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        samplerOnSample!!(VitalsSample(t = now, mem = 5))
        // Samples no longer transport (VitalsCollector.addEntry), so they
        // cannot be what the stop flushes. Tracking a player emits a
        // `player_attach` — a real transported entry — which keeps this test
        // proving what it is named for: stopping flushes pending AND sends a
        // final summary.
        c.track(FakeIntegration(), "main")
        c.applyServerConfig(VitalsServerConfig(false, 1.0))
        assertFalse(c.isRunning)
        assertEquals(listOf("summary", "chunk", "summary"), kinds())
        assertEquals("true", payloads().last()["final"]!!.jsonPrimitive.content)
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        assertTrue(c.isRunning)
    }

    @Test
    fun `trackPlayer before start is honoured once the collector starts, with player_attach first`() {
        val c = controller()
        val integ = FakeIntegration()
        val h = c.track(integ, "main")
        assertEquals("p1", h.id)
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        val recent = c.currentStamp()!!.entries.filterIsInstance<VitalsPlayerEvent>()
        assertEquals(listOf("player_attach", "source_change"), recent.map { it.type })
        assertEquals("main", recent[0].data!!["name"]!!.jsonPrimitive.content)
        assertEquals("fake", recent[0].data!!["library"]!!.jsonPrimitive.content)
        assertEquals("p1", recent[0].playerId)
    }

    @Test
    fun `integration events flow through with the player id, custom entries are dropped with no collector`() {
        val c = controller()
        val integ = FakeIntegration()
        val h = c.track(integ, null)
        h.track("before", mapOf("a" to 1))           // dropped
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        integ.ctx!!.emit("play")
        h.track("after", mapOf("a" to 1))
        c.trackVitals("global", null, null)
        val entries = c.currentStamp()!!.entries
        assertEquals("p1", entries.filterIsInstance<VitalsPlayerEvent>().last { it.type == "play" }.playerId)
        val customs = entries.filterIsInstance<VitalsCustomEntry>()
        assertEquals(listOf("after", "global"), customs.map { it.name })
        assertEquals("p1", customs[0].playerId); assertNull(customs[1].playerId)
    }

    @Test
    fun `refused attach yields an inert handle, detaches best-effort, and never announces`() {
        // Codex round-1, Important 3. The old handle carried a real "pN" id,
        // so `handle.track()` stamped custom entries with a player the
        // timeline never saw attach; a half-subscribed integration was also
        // left subscribed forever.
        val c = controller()
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        val integ = FakeIntegration(ok = false)
        val h = c.track(integ, null)
        assertEquals("", h.id)
        assertEquals("a refused attach must still be torn down", 1, integ.detached)
        h.track("orphan", null)
        h.detach()
        val entries = c.currentStamp()!!.entries
        assertTrue(entries.filterIsInstance<VitalsPlayerEvent>().none { it.type == "player_attach" })
        assertTrue(entries.filterIsInstance<VitalsPlayerEvent>().none { it.type == "player_detach" })
        assertTrue(entries.filterIsInstance<VitalsCustomEntry>().isEmpty())
    }

    @Test
    fun `a throwing attach is treated exactly like a refusal`() {
        val c = controller()
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        val integ = object : PlayerIntegration {
            override val library = "boom"; override val version: String? = null
            var detached = 0
            override fun attach(ctx: PlayerIntegrationContext): Boolean = error("attach blew up")
            override fun snapshot(onResult: (PlayerSnapshot?) -> Boolean) { onResult(null) }
            override fun startupTimings(): StartupTimings? = null
            override fun describe(ctx: PlayerIntegrationContext) {}
            override fun detach() { detached++ }
        }
        val h = c.track(integ, null)
        assertEquals("", h.id)
        assertEquals(1, integ.detached)
        assertTrue(c.currentStamp()!!.entries.filterIsInstance<VitalsPlayerEvent>().none { it.type == "player_attach" })
    }

    @Test
    fun `a player registered while shutdown is running is refused and detached`() {
        // Parked item N1: VitalsRuntime's drain could register onto a
        // controller a concurrent shutdown() had already torn down, leaving a
        // permanently attached integration nothing would ever detach.
        //
        // Codex round-8, #3 — the refusal is `null`, not an inert handle. It
        // means "not me", and only the caller knows whether another controller
        // should get this registration; an inert handle said "nobody, ever",
        // which is what lost superseded registrations.
        val c = controller()
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        c.shutdown()
        val integ = FakeIntegration()
        assertNull("a shutdown refusal is null, not an inert handle", c.trackPlayer(integ, "late"))
        assertEquals("attach must not even be attempted after shutdown", null, integ.ctx)
        assertEquals(0, integ.detached)
    }

    /**
     * Codex round-3, E2 — controller A finishes `attach()` and is shut down before the
     * registration is published, so A answers the TRANSIENT null and `VitalsRuntime` retries the
     * SAME integration against B. The rollback used to be a plain `detach()`, which on a
     * [RemotePlayerIntegration] clears `playing`/`buffering` (round-1, C1 made detach close its
     * spans) — B then announced a playing player with no open spans and measured nothing until a
     * transition that, for uninterrupted playback, never comes. Twin of `TrackPlayerTests`'
     * `testARegistrationRolledBackForShutdownKeepsItsReleaseDetectionWhenItIsRetried`.
     *
     * `captureSourceQuery` is resolved INSIDE `attach()`, i.e. between `reserve()` and the
     * publication: exactly the window that produces the refusal.
     */
    @Test
    fun `a remote player rolled back for a shutdown keeps its host model for the retry`() {
        val a = controller(); a.applyServerConfig(VitalsServerConfig(true, 1.0))
        val b = controller(); b.applyServerConfig(VitalsServerConfig(true, 1.0))
        var refuseOnce = true
        val i = RemotePlayerIntegration("rnv", null, { if (refuseOnce) { refuseOnce = false; a.shutdown() }; false }, { 9_000L })
        i.record("play", 1L, null)
        i.record("buffer_start", 2L, null)

        assertNull("A refused for shutdown, so the registration goes back on the queue", a.trackPlayer(i, "main"))
        // (A is shut down, so it has no stamp left to inspect; that the rollback emits NOTHING is
        // asserted directly in RemotePlayerIntegrationTest.)

        assertNotNull("…and B picks the same integration up", b.trackPlayer(i, "main"))
        val types = b.currentStamp()!!.entries.filterIsInstance<VitalsPlayerEvent>().map { it.type }
        assertEquals(listOf("player_attach", "play", "buffer_start"), types)
    }

    @Test
    fun `detach emits player_detach once and a stale handle is a no-op`() {
        val c = controller()
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        val integ = FakeIntegration()
        val h = c.track(integ, null)
        h.detach(); h.detach()
        assertEquals(1, integ.detached)
        assertEquals(1, c.currentStamp()!!.entries.filterIsInstance<VitalsPlayerEvent>().count { it.type == "player_detach" })
    }

    @Test
    fun `sampler tick collects stats per player with a snapshot, skipping idle ones`() {
        val c = controller()
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        val a = FakeIntegration().apply { snap = PlayerSnapshot(1200, 5_000_000, 2_000_000, 1280, 720, 3) }
        val b = FakeIntegration()
        c.track(a, null); c.track(b, null)
        samplerOnTick!!()
        val stats = c.currentStamp()!!.entries.filterIsInstance<VitalsPlayerEvent>().filter { it.type == "stats" }
        assertEquals(1, stats.size); assertEquals("p1", stats[0].playerId)
        assertEquals("3", stats[0].data!!["droppedFrames"]!!.jsonPrimitive.content)
        assertEquals("1200", stats[0].data!!["bufferAheadMs"]!!.jsonPrimitive.content)
    }

    @Test
    fun `rotation reseeds every live player`() {
        val c = controller()
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        val integ = FakeIntegration()
        c.track(integ, "main")
        now += 1_800_001
        samplerOnSample!!(VitalsSample(t = now, mem = 1))
        assertEquals(2, integ.described)
        val types = c.currentStamp()!!.entries.filterIsInstance<VitalsPlayerEvent>().map { it.type }
        assertEquals(listOf("player_attach", "source_change"), types)
    }

    @Test
    fun `shutdown finalizes, detaches every player and clears the registry`() {
        val c = controller()
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        val integ = FakeIntegration()
        c.track(integ, null)
        c.shutdown()
        assertEquals(1, integ.detached); assertFalse(c.isRunning); assertNull(c.currentStamp())
        assertEquals("true", payloads().last()["final"]!!.jsonPrimitive.content)
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        assertFalse(c.isRunning)
    }

    @Test
    fun `startup announces a live player exactly once, never one still attaching`() {
        // Codex round-1, Important 2. Registration is published only once
        // attach() has returned, and the publication and the "who announces
        // it" decision happen in one critical section — so the collector's
        // own startup loop and the registering thread can never both announce
        // (nor announce a player mid-attach).
        val c = controller()
        val integ = FakeIntegration()
        c.track(integ, "main")
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        val attaches = c.currentStamp()!!.entries.filterIsInstance<VitalsPlayerEvent>().filter { it.type == "player_attach" }
        assertEquals(1, attaches.size)

        // ...and a player registered while the collector is ALREADY running
        // is announced exactly once too.
        val second = FakeIntegration()
        c.track(second, "second")
        assertEquals(2, c.currentStamp()!!.entries.filterIsInstance<VitalsPlayerEvent>().count { it.type == "player_attach" })
    }

    @Test
    fun `an async snapshot that lands after its player detached emits nothing`() {
        // Codex round-1, Important 8.
        val c = controller()
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        val integ = FakeIntegration().apply { deferSnapshot = true; snap = PlayerSnapshot(1, 2, 3, 4, 5, 6) }
        val h = c.track(integ, null)
        samplerOnTick!!()
        assertNotNull("precondition: the snapshot is still outstanding", integ.deferred)
        h.detach()
        integ.deferred!!(PlayerSnapshot(1, 2, 3, 4, 5, 6))
        assertTrue(
            "stats must never land after player_detach",
            c.currentStamp()!!.entries.filterIsInstance<VitalsPlayerEvent>().none { it.type == "stats" },
        )
    }

    @Test
    fun `an async snapshot that lands after the collector was replaced emits nothing`() {
        val c = controller()
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        val integ = FakeIntegration().apply { deferSnapshot = true }
        c.track(integ, null)
        samplerOnTick!!()
        val late = integ.deferred!!
        // Stop and restart: a NEW collector generation.
        c.applyServerConfig(VitalsServerConfig(false, 1.0))
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        late(PlayerSnapshot(1, 2, 3, 4, 5, 6))
        assertTrue(c.currentStamp()!!.entries.filterIsInstance<VitalsPlayerEvent>().none { it.type == "stats" })
    }

    @Test
    fun `rotation reseeds ongoing play and buffer state, and a duplicate open costs no playtime`() {
        // Codex round-1, Important 11. The new session's accumulator starts
        // empty, so an ongoing play/rebuffer span has to be re-opened.
        //
        // Codex round-7, #1 — what "without double-counting" means now. The
        // controller used to suppress whichever opening transition the
        // rotation-triggering entry had already carried into the new session,
        // because the accumulator counted opens and closes and a second open
        // left the span running to session end. The accumulator is per-player
        // idempotent now, so the guarantee is asserted where it actually
        // lives — in the SUMMARY's playtime, not in how many `play` entries
        // reach the ring.
        val c = controller()
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        val integ = FakeIntegration().apply { playing = true; buffering = true }
        c.track(integ, "main")

        // A rotation triggered by something that is NOT this player's opening
        // transition: both spans are re-opened.
        now += 1_800_001
        samplerOnSample!!(VitalsSample(t = now, mem = 1))
        var types = c.currentStamp()!!.entries.filterIsInstance<VitalsPlayerEvent>().map { it.type }
        assertEquals(listOf("player_attach", "source_change", "play", "buffer_start"), types)

        // Codex round-6, #3 — this player's OWN `play` can no longer trigger
        // a rotation at all. A live emission carries the session pin, and a
        // pinned entry that would rotate is refused outright rather than
        // carried into a session that has not announced its player yet.
        // (Round 5 admitted it and relied on `reseed`'s suppression to avoid
        // the double open; that reading is reversed.)
        val describedBefore = integ.described
        val sentBefore = sent.size
        now += 1_800_001
        assertFalse(
            "a pinned emission that would rotate the session must be refused",
            integ.ctx!!.emit("play", null, null),
        )
        assertEquals("...so no session was finalized or started", sentBefore, sent.size)
        assertEquals("...and no reseed ran", describedBefore, integ.described)

        // The rotation still happens on the very next UNPINNED entry, and the
        // reseed re-opens both spans in the new session, which is where the
        // refused one would have belonged.
        val rotatedAt = now
        samplerOnSample!!(VitalsSample(t = now, mem = 1))
        types = c.currentStamp()!!.entries.filterIsInstance<VitalsPlayerEvent>().map { it.type }
        assertEquals(listOf("player_attach", "source_change", "play", "buffer_start"), types)

        // Round-7, #1: a DUPLICATE open from the same player — the shape every
        // earlier round's latch existed to prevent — is absorbed, and the
        // player's single `pause` still closes the span. The old accumulator
        // would have left it open and charged the extra 500ms to playtime.
        now = rotatedAt + 1_000
        assertTrue("a duplicate open is admitted, not refused", integ.ctx!!.emit("play", null, null))
        now = rotatedAt + 2_000
        assertTrue(integ.ctx!!.emit("pause", null, null))
        now = rotatedAt + 2_500
        c.applyServerConfig(VitalsServerConfig(false, 1.0))

        val summary = payloads().last()
        assertEquals("true", summary["final"]!!.jsonPrimitive.content)
        assertEquals(
            "one pause closes the span the reseed opened, duplicate open and all",
            "2000",
            summary["playtimeMs"]!!.jsonPrimitive.content,
        )
    }

    @Test
    fun `shutdown does not hold the controller monitor while integrations tear down`() {
        // Codex round-1, Critical 5: an integration whose detach() waits on
        // another thread that re-enters the controller used to hang shutdown
        // permanently, because the monitor was held across every detach().
        val c = controller()
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        val reentered = java.util.concurrent.CountDownLatch(1)
        val integ = object : FakeIntegration() {
            override fun detach() {
                super.detach()
                val t = Thread { c.trackVitals("from-detach", null, null); reentered.countDown() }
                t.start(); t.join(5_000)
            }
        }
        c.track(integ, null)
        val done = Thread { c.shutdown() }
        done.start(); done.join(5_000)
        assertFalse("shutdown() deadlocked against a re-entrant detach()", done.isAlive)
        assertTrue(reentered.await(1, java.util.concurrent.TimeUnit.SECONDS))
        assertEquals(1, integ.detached)
    }

    @Test
    fun `startCollector does not hold the controller monitor while describing`() {
        // The other half of Critical 5: describe() ran under the monitor too.
        val c = controller()
        val integ = object : FakeIntegration() {
            override fun describe(ctx: PlayerIntegrationContext) {
                super.describe(ctx)
                val t = Thread { c.trackVitals("from-describe", null, null) }
                t.start(); t.join(5_000)
                assertFalse("describe() ran with the controller monitor held", t.isAlive)
            }
        }
        c.track(integ, null)
        val done = Thread { c.applyServerConfig(VitalsServerConfig(true, 1.0)) }
        done.start(); done.join(5_000)
        assertFalse("applyServerConfig() deadlocked against a re-entrant describe()", done.isAlive)
        assertEquals(1, integ.described)
        assertTrue(c.currentStamp()!!.entries.filterIsInstance<VitalsCustomEntry>().any { it.name == "from-describe" })
    }

    // ---- Codex round-2 ----

    @Test
    fun `an enable tail superseded mid-flight stops the sampler it started and uninstalls the observer`() {
        // Codex round-2, Critical 2. `sampler.start()` and `lifecycle.install()`
        // run with the monitor DROPPED (Critical 5's discipline), so a kill()
        // can complete between the transition being decided and the tail
        // executing: it stops the sampler it captured and returns, and the
        // tail then starts that same sampler and installs a
        // ProcessLifecycleOwner observer that outlives the process's interest
        // in it. The fake below makes the race deterministic by re-entering
        // shutdown() from inside start().
        val owner = TestLifecycleOwner()
        var stops = 0
        var reentered = false
        lateinit var c: VitalsController
        c = VitalsController(
            VitalsController.Deps(
                localConfig = VitalsConfig(),
                dims = SessionSummaryDims("android", "1", "0.8.0"),
                transport = { sink() },
                scheduler = FakeScheduler(),
                samplerFactory = { onSample, onTick ->
                    object : ResourceSampler(handler = android.os.Handler(android.os.Looper.getMainLooper()), onSample = onSample, onTick = onTick) {
                        override fun start() {
                            if (!reentered) { reentered = true; c.shutdown() }
                            super.start()
                        }
                        override fun stop() { stops++; super.stop() }
                    }
                },
                lifecycle = { fg, bg -> VitalsLifecycleObserver(fg, bg, owner = { owner }) },
                now = { now },
                random = { draw },
                newSessionId = { "sid" },
            ),
        )
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        // install()/uninstall() always post to main; drain them.
        shadowOf(android.os.Looper.getMainLooper()).idle()

        assertTrue("shutdown() must have run from inside start()", reentered)
        assertTrue("the resurrected sampler must be stopped again", stops >= 2)
        assertEquals("a superseded tail must not leave an observer installed", 0, owner.observerCount)
        assertFalse(c.isRunning)
    }

    @Test
    fun `a throwing sampler factory publishes nothing and a later config change retries`() {
        // Codex round-2, Important 6. The collector used to be published
        // BEFORE the sampler was built, so a throwing factory left a live
        // collector and flush timer with no sampler — and because
        // `collector != null` from then on, no later apply ever retried.
        var boom = true
        val c = VitalsController(
            VitalsController.Deps(
                localConfig = VitalsConfig(),
                dims = SessionSummaryDims("android", "1", "0.8.0"),
                transport = { sink() },
                scheduler = FakeScheduler(),
                samplerFactory = { onSample, onTick ->
                    if (boom) error("no sampler today")
                    object : ResourceSampler(handler = android.os.Handler(android.os.Looper.getMainLooper()), onSample = onSample, onTick = onTick) {}
                },
                lifecycle = { _, _ -> null },
                now = { now },
                random = { draw },
                newSessionId = { "sid" },
            ),
        )
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        assertFalse("a failed construction must not publish a collector", c.isRunning)
        assertNull(c.currentStamp())

        boom = false
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        assertTrue("the next config change must be able to retry", c.isRunning)
    }

    @Test
    fun `a throwing sampler stop still finalizes the collector on shutdown`() {
        // Codex round-2, Important 6, teardown half: every step is guarded on
        // its own, so one throwing teardown call cannot cost the final summary.
        val c = VitalsController(
            VitalsController.Deps(
                localConfig = VitalsConfig(),
                dims = SessionSummaryDims("android", "1", "0.8.0"),
                transport = { sink() },
                scheduler = FakeScheduler(),
                samplerFactory = { onSample, onTick ->
                    object : ResourceSampler(handler = android.os.Handler(android.os.Looper.getMainLooper()), onSample = onSample, onTick = onTick) {
                        override fun stop() = error("teardown blew up")
                    }
                },
                lifecycle = { _, _ -> null },
                now = { now },
                random = { draw },
                newSessionId = { "sid" },
            ),
        )
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        c.shutdown()
        assertEquals("true", payloads().last()["final"]!!.jsonPrimitive.content)
        assertFalse(c.isRunning)
    }

    @Test
    fun `events emitted before player_attach are dropped, never buffered ahead of it`() {
        // Codex round-2, Important 5. `attach()` is called before the
        // registration is published, so anything it emits used to land in the
        // timeline carrying a player id that had no `player_attach` yet — and
        // if the registration then went on to be refused or torn down, never
        // would.
        val c = controller()
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        val integ = object : FakeIntegration() {
            override fun attach(ctx: PlayerIntegrationContext): Boolean {
                ctx.emit("play")          // too early — must be dropped
                ctx.emit("buffer_start")  // ditto
                return super.attach(ctx)
            }
        }
        c.track(integ, null)
        val types = c.currentStamp()!!.entries.filterIsInstance<VitalsPlayerEvent>().map { it.type }
        assertEquals(listOf("player_attach", "source_change"), types)

        // ...and once announced, the very same context works normally.
        integ.ctx!!.emit("play")
        assertEquals("play", c.currentStamp()!!.entries.filterIsInstance<VitalsPlayerEvent>().last().type)
    }

    @Test
    fun `an event type outside the protocol enum is dropped and logged`() {
        // Codex round-2, Important 9. `type` is a free String from customer
        // code; one `ctx.emit("buffering")` reaching the wire makes ingest
        // reject the entire containing chunk, deleting every other entry in it.
        val c = controller()
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        val integ = FakeIntegration()
        c.track(integ, null)
        InternalLogger.drainFailures()

        integ.ctx!!.emit("buffering")   // not in PlayerEventTypes
        integ.ctx!!.emit("play")

        val types = c.currentStamp()!!.entries.filterIsInstance<VitalsPlayerEvent>().map { it.type }
        assertEquals(listOf("player_attach", "source_change", "play"), types)
        assertTrue(
            "an unknown type must be recorded as an internal failure",
            InternalLogger.drainFailures().any { it.label == "VitalsController.emit.unknownType" },
        )
    }

    // ---- Codex round-3 ----

    @Test
    fun `the protocol-valid dropped_frames type is not treated as a typo`() {
        // Codex round-3, Important 4. `stats` supersedes it for the SDKs in
        // this repo, but it is still a member of the protocol enum
        // (packages/protocol/src/vitals.ts) — omitting it made the emit
        // allowlist stricter than the wire contract, so a custom integration
        // emitting it had the entry silently discarded and logged as a typo.
        val c = controller()
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        val integ = FakeIntegration()
        c.track(integ, null)
        InternalLogger.drainFailures()

        integ.ctx!!.emit("dropped_frames", mapOf("count" to 12))

        val types = c.currentStamp()!!.entries.filterIsInstance<VitalsPlayerEvent>().map { it.type }
        assertEquals(listOf("player_attach", "source_change", "dropped_frames"), types)
        assertTrue(
            "a protocol-valid type must not be logged as an unknown one",
            InternalLogger.drainFailures().none { it.label == "VitalsController.emit.unknownType" },
        )
    }

    @Test
    fun `a registration unregistered before its announcement is never announced`() {
        // Codex round-3, Important 5. The enable transition snapshots the
        // registry under the monitor and announces after dropping it, so a
        // concurrent release could unregister a player while `announced` was
        // still false: the detach path emitted nothing, and the announce then
        // recorded `player_attach` and called `describe()` on an
        // already-detached integration — a ghost player, attached forever.
        //
        // Made deterministic by detaching the SECOND player from inside the
        // FIRST one's describe(), which runs inside the announce tail with no
        // lock held: p2 is in the snapshot but gone from the registry by the
        // time its own announce runs.
        val c = controller()
        var second: PlayerHandle? = null
        val i1 = object : FakeIntegration() {
            override fun describe(ctx: PlayerIntegrationContext) {
                super.describe(ctx)
                second?.detach()
            }
        }
        val i2 = FakeIntegration()
        c.track(i1, "one")
        second = c.track(i2, "two")

        c.applyServerConfig(VitalsServerConfig(true, 1.0))

        val events = c.currentStamp()!!.entries.filterIsInstance<VitalsPlayerEvent>()
        assertEquals("the released player must not be announced", 0, events.count { it.playerId == "p2" })
        assertEquals("...nor described", 0, i2.described)
        assertEquals("...and it really was released", 1, i2.detached)
        assertEquals(listOf("player_attach", "source_change"), events.filter { it.playerId == "p1" }.map { it.type })
    }

    @Test
    fun `a detach racing an announcement emits player_detach after the attach, never before`() {
        // The other half of Important 5. The releasing thread unregisters,
        // tears the integration down, then blocks on the same announce monitor
        // the announcing thread is holding — so its marker can only land after
        // the attach it closes.
        //
        // Codex round-5, #2 moved the `integration.library` getter (round 3's
        // seam into that window) OUT of the monitor, precisely because it is
        // customer code. The seam is now the collector's own `send`, which
        // runs under the collector lock nested inside `announceLock`; with one
        // entry per chunk it fires on the `player_attach` record itself.
        var releaser: Thread? = null
        var armed = false
        var handle: PlayerHandle? = null
        val integ = FakeIntegration()
        val c = VitalsController(
            VitalsController.Deps(
                localConfig = VitalsConfig(),
                dims = SessionSummaryDims("android", "1", "0.8.0"),
                transport = {
                    object : VitalsSink {
                        override fun send(body: String) {
                            sent.add(body)
                            if (armed && body.contains("player_attach")) {
                                armed = false
                                val h = handle!!
                                releaser = Thread { h.detach() }.also { it.start() }
                                // Cannot finish: it is blocked on the announce
                                // monitor this thread is holding.
                                releaser!!.join(300)
                            }
                        }
                        override fun close() { sinkCloses++ }
                    }
                },
                scheduler = FakeScheduler(),
                samplerFactory = { onSample, onTick ->
                    samplerOnSample = onSample; samplerOnTick = onTick
                    object : ResourceSampler(handler = android.os.Handler(android.os.Looper.getMainLooper()), onSample = onSample, onTick = onTick) {}
                },
                lifecycle = { _, _ -> null },
                now = { now },
                random = { draw },
                newSessionId = { "sid" },
                collectorOverrides = { base -> oneEntryPerChunk(base) },
            ),
        )
        handle = c.track(integ, null)
        armed = true

        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        releaser?.join(5_000)

        val types = c.currentStamp()!!.entries.filterIsInstance<VitalsPlayerEvent>().map { it.type }
        assertEquals("the integration really was released", 1, integ.detached)
        assertTrue("the attach must be recorded", types.contains("player_attach"))
        assertTrue("the detach must be recorded", types.contains("player_detach"))
        assertTrue(
            "player_detach must never precede the player_attach it closes",
            types.indexOf("player_attach") < types.indexOf("player_detach"),
        )
    }

    /** Player-event types across every chunk that has been SENT, in order. */
    private fun sentPlayerTypes(): List<String> =
        payloads().filter { it["kind"]!!.jsonPrimitive.content == "chunk" }
            .flatMap { it["entries"]!!.jsonArray }
            .map { it.jsonObject }
            .filter { it["kind"]!!.jsonPrimitive.content == "player" }
            .map { it["type"]!!.jsonPrimitive.content }

    @Test
    fun `shutdown waits for an asynchronous detach so its closing spans precede player_detach`() {
        // Codex round-3, Important 6. An integration that tears down on its
        // own thread (media3 does — `bufferStartAt`/`playing` have a single
        // writer there) finishes AFTER `detach()` returns. The controller used
        // to record `player_detach` immediately and stop the collector, so the
        // closing `buffer_end`/`pause` landed after the marker, or during a
        // shutdown were dropped entirely — leaving the union spans open to the
        // end of the session in the summary.
        val c = controller()
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        val integ = object : FakeIntegration() {
            override fun detach(onComplete: () -> Unit) {
                detached++
                Thread {
                    Thread.sleep(40)
                    ctx!!.emit("pause")
                    onComplete()
                }.start()
            }
        }
        c.track(integ, null)
        sent.clear()

        c.shutdown()

        val types = sentPlayerTypes()
        assertTrue("the closing span must survive the shutdown", types.contains("pause"))
        assertTrue(types.contains("player_detach"))
        assertTrue(
            "player_detach must follow the events the teardown closed",
            types.indexOf("pause") < types.indexOf("player_detach"),
        )
    }

    @Test
    fun `an integration that never completes its detach does not hang shutdown`() {
        // The bound on Important 6's wait. A wedged player looper costs the
        // marker and 250 ms, never the shutdown.
        val c = controller()
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        val integ = object : FakeIntegration() {
            override fun detach(onComplete: () -> Unit) { detached++ }   // never completes
        }
        c.track(integ, null)
        InternalLogger.drainFailures()

        val started = System.currentTimeMillis()
        c.shutdown()
        val elapsed = System.currentTimeMillis() - started

        assertEquals(1, integ.detached)
        assertTrue("shutdown must not wait indefinitely (took ${elapsed}ms)", elapsed < 5_000)
        assertTrue(
            "the timed-out drain must be recorded as an internal failure",
            InternalLogger.drainFailures().any { it.label == "VitalsController.shutdown.detachDrain" },
        )
        assertFalse(c.isRunning)
    }

    @Test
    fun `a handle detach records player_detach only once its integration has finished tearing down`() {
        val c = controller()
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        val pending = ArrayList<() -> Unit>()
        val integ = object : FakeIntegration() {
            override fun detach(onComplete: () -> Unit) { detached++; pending.add(onComplete) }
        }
        val h = c.track(integ, null)

        h.detach()
        assertEquals(
            "nothing may be recorded until the integration reports completion",
            0,
            c.currentStamp()!!.entries.filterIsInstance<VitalsPlayerEvent>().count { it.type == "player_detach" },
        )

        integ.ctx!!.emit("pause")
        pending.single()()

        val types = c.currentStamp()!!.entries.filterIsInstance<VitalsPlayerEvent>().map { it.type }
        assertEquals(listOf("player_attach", "source_change", "pause", "player_detach"), types)
    }

    @Test
    fun `a detached handle records nothing`() {
        // Codex round-3, Important 11. A handle keeps its nonblank id after
        // detach (callers hold it), so an unguarded `track()` kept stamping
        // custom entries with a player id the timeline had already closed —
        // and after a rotation, fed the NEW session entries for a player it
        // never saw attach.
        val c = controller()
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        val integ = FakeIntegration()
        val h = c.track(integ, null)
        h.track("before", null)
        h.detach()
        h.track("after", null)

        val custom = c.currentStamp()!!.entries.filterIsInstance<VitalsCustomEntry>().map { it.name }
        assertEquals(listOf("before"), custom)
        assertEquals("the id is deliberately unchanged — only the recording is gated", "p1", h.id)
    }

    @Test
    fun `each collector gets its own sink, closed after that collector's final summary`() {
        // Codex round-2, Important 14. The transport used to be built once per
        // start() and closed never, so a start/kill cycle left every one of
        // them holding its payload, its delayed retries and its in-flight
        // calls. It is per-collector now, and closed AFTER the collector's own
        // stop() so the final summary still goes out.
        var built = 0
        val closedAfter = ArrayList<Int>()
        val c = VitalsController(
            VitalsController.Deps(
                localConfig = VitalsConfig(),
                dims = SessionSummaryDims("android", "1", "0.8.0"),
                transport = {
                    built++
                    object : VitalsSink {
                        override fun send(body: String) { sent.add(body) }
                        override fun close() { closedAfter.add(sent.size) }
                    }
                },
                scheduler = FakeScheduler(),
                samplerFactory = { onSample, onTick ->
                    object : ResourceSampler(handler = android.os.Handler(android.os.Looper.getMainLooper()), onSample = onSample, onTick = onTick) {}
                },
                lifecycle = { _, _ -> null },
                now = { now },
                random = { draw },
                newSessionId = { "sid" },
            ),
        )
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        assertEquals(1, built)
        assertTrue(closedAfter.isEmpty())

        c.applyServerConfig(VitalsServerConfig(false, 1.0))
        assertEquals(1, closedAfter.size)
        assertEquals("the final summary must go out before the sink closes", sent.size, closedAfter[0])
        assertEquals("true", payloads().last()["final"]!!.jsonPrimitive.content)

        // A re-enable builds a FRESH sink rather than reusing the closed one.
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        assertEquals(2, built)
        c.shutdown()
        assertEquals(2, closedAfter.size)
    }

    @Test
    fun `lifecycle observer flushes on background and does not throw on foreground`() {
        val c = controller(withLifecycle = true)
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        val integ = FakeIntegration()
        c.track(integ, null) // player_attach + source_change land in `pending`
        sent.clear()

        val owner = TestLifecycleOwner()
        lifecycleObserver!!.onStop(owner)
        assertEquals(listOf("chunk", "summary"), kinds())

        lifecycleObserver!!.onStart(owner) // must not throw; resumes the sampler
    }

    // ---- Codex round-4 ----

    @Test
    fun `a rotation triggered under a registration's announce lock does not run customer code under it`() {
        // Codex round-4, #1. `announce()` held the registration's
        // `announceLock` across the `player_attach` record, and the record
        // fired `onRotate` INLINE — so `reseed -> describe()` (customer code)
        // ran under that lock. A `describe()` that waits for a thread which
        // detaches the handle being announced deadlocks: the worker blocks on
        // `announceLock` in the detach path, and the announcing thread waits
        // for the worker.
        //
        // Scripted exactly that way, entirely inside the enable tail, which
        // announces both pre-registered players in order:
        //  1. `one` is announced; its `describe()` opens a > 30 min idle gap;
        //  2. `two`'s `player_attach` therefore rotates the session while its
        //     own `announceLock` is held;
        //  3. the rotation reseeds, re-announcing `one`, and its `describe()`
        //     has a worker thread detach `two` — which has to take exactly
        //     that lock to record its `player_detach`.
        val c = controller()
        var second: PlayerHandle? = null
        var gapOpened = false
        // Captured INSIDE describe(), while the announce is still in progress:
        // once it returns, the lock is released and the worker unblocks, so a
        // check made afterwards would pass either way.
        var workerRan: Boolean? = null
        val first = object : FakeIntegration() {
            override fun describe(ctx: PlayerIntegrationContext) {
                super.describe(ctx)
                if (!gapOpened) { gapOpened = true; now += 1_800_001; return }
                // Only the FIRST reseed observation counts: a later one runs
                // after the announce has released the lock, when the detach is
                // already a no-op.
                if (workerRan != null) return
                val h = second ?: return
                val worker = Thread { h.detach() }
                worker.start()
                worker.join(2_000)
                workerRan = !worker.isAlive
            }
        }
        val secondInteg = FakeIntegration()
        c.track(first, "one")
        second = c.track(secondInteg, "two")

        c.applyServerConfig(VitalsServerConfig(true, 1.0))

        assertTrue("precondition: the rotation reseed really re-described the first player", gapOpened)
        assertNotNull("precondition: the reseed reached the detaching describe", workerRan)
        assertTrue(
            "the reseed's describe() ran under the announcing registration's announceLock — " +
                "a detach on another thread deadlocked against it",
            workerRan!!,
        )
        assertEquals("...and the detach really completed", 1, secondInteg.detached)
    }

    @Test
    fun `a delayed describe emission is dropped once its registration is gone`() {
        // Codex round-4, #5. `announce()` records `player_attach`, releases
        // `announceLock` and only THEN calls `describe()` — so a detach can
        // complete in between and the retained source/DRM state used to be
        // emitted after the `player_detach` that closed the player. Worse, an
        // opening `play`/`buffer_start` from a delayed describe left a summary
        // span open for the rest of the session.
        //
        // The detach is driven from inside `describe()` itself, which is
        // precisely the window: the announce monitor is released, the
        // registration is torn down, and the describe then emits.
        val c = controller()
        val integ = object : FakeIntegration() {
            var handle: PlayerHandle? = null
            override fun describe(ctx: PlayerIntegrationContext) {
                handle!!.detach()
                described++
                ctx.emit("source_change", mapOf("src" to "s", "protocol" to "hls"))
                ctx.emit("play")
            }
        }
        integ.handle = c.track(integ, null)

        c.applyServerConfig(VitalsServerConfig(true, 1.0))

        val types = c.currentStamp()!!.entries.filterIsInstance<VitalsPlayerEvent>().map { it.type }
        assertEquals("the describe really ran", 1, integ.described)
        assertEquals(listOf("player_attach", "player_detach"), types)
    }

    @Test
    fun `a handle track that races its own detach cannot land after player_detach`() {
        // Codex round-4, #6. Round 3's `isLive()` check was a plain TOCTOU:
        // the entry was BUILT and recorded after it, so a detach completing in
        // between put a custom entry after `player_detach` — and if it rotated
        // the session, carried a `playerId` into a session that never
        // announced that player.
        //
        // The window is scripted through `JsonCoerce`'s fallback for an
        // unrepresentable value: `toString()` runs while the entry is being
        // built, which is exactly where the old code sat between its liveness
        // check and its record.
        val c = controller()
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        val integ = FakeIntegration()
        val h = c.track(integ, null)
        val detachingPayload = object {
            override fun toString(): String {
                h.detach()
                return "detached-underneath-me"
            }
        }

        h.track("late", detachingPayload)

        val types = c.currentStamp()!!.entries.filterIsInstance<VitalsPlayerEvent>().map { it.type }
        assertEquals("precondition: the detach really completed", listOf("player_attach", "source_change", "player_detach"), types)
        assertTrue(
            "a custom entry must never land after the player_detach that closed its player",
            c.currentStamp()!!.entries.filterIsInstance<VitalsCustomEntry>().isEmpty(),
        )
    }

    @Test
    fun `a snapshot the collector refuses answers the integration false`() {
        // Codex round-4, #7. The callback used to return a hardcoded `true`
        // whenever the registry and collector-identity checks passed, so an
        // entry the collector then REFUSED (stopped, or over-budget) still
        // told media3 to advance `droppedReported` — discarding that
        // dropped-frame delta permanently. The refusal here is the size one,
        // which is reachable through the public gate; the stopped-collector
        // half is pinned by `VitalsCollectorTest`.
        val c = VitalsController(
            VitalsController.Deps(
                localConfig = VitalsConfig(),
                dims = SessionSummaryDims("android", "1", "0.8.0"),
                transport = { sink() },
                scheduler = FakeScheduler(),
                samplerFactory = { onSample, onTick ->
                    samplerOnSample = onSample; samplerOnTick = onTick
                    object : ResourceSampler(handler = android.os.Handler(android.os.Looper.getMainLooper()), onSample = onSample, onTick = onTick) {}
                },
                lifecycle = { _, _ -> null },
                now = { now },
                random = { draw },
                newSessionId = { "sid" },
                // Nothing fits: every entry is refused by the transport.
                collectorOverrides = { base -> tinyBuffer(base) },
            ),
        )
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        val integ = FakeIntegration().apply { snap = PlayerSnapshot(1200, 5_000_000, 2_000_000, 1280, 720, 3) }
        c.track(integ, null)

        var answered: Boolean? = null
        integ.onSnapshotAnswer = { answered = it }
        samplerOnTick!!()

        assertEquals("a refused entry must not be reported as recorded", false, answered)
    }

    @Test
    fun `a snapshot landing between a rotation and the reseed emits nothing`() {
        // Codex round-5, residual of #6/#7. `stats` was the one player
        // emission still resolved through the CONTROLLER FIELD rather than
        // through the announcement: the `collector !== c` check passed across
        // a rotation (same collector object, brand-new session), so a sampler
        // tick landing before this player had been reseeded put its `stats`
        // ahead of its own `player_attach` in the new session. The pin is the
        // session id, checked atomically with admission inside the collector.
        var landDeferred: (() -> Unit)? = null
        val c = VitalsController(
            VitalsController.Deps(
                localConfig = VitalsConfig(),
                dims = SessionSummaryDims("android", "1", "0.8.0"),
                transport = { sink() },
                scheduler = FakeScheduler(),
                samplerFactory = { onSample, onTick ->
                    samplerOnSample = onSample; samplerOnTick = onTick
                    object : ResourceSampler(handler = android.os.Handler(android.os.Looper.getMainLooper()), onSample = onSample, onTick = onTick) {}
                },
                lifecycle = { _, _ -> null },
                now = { now },
                random = { draw },
                newSessionId = { "sid-" + (++sessionIds) },
                // The rotation callback IS the reseed; landing the outstanding
                // snapshot from inside it, before delegating, reproduces the
                // exact window — the new session has begun and this player has
                // not been re-announced into it yet.
                collectorOverrides = { base ->
                    VitalsCollector.Deps(
                        dims = base.dims, now = base.now, send = base.send, newSessionId = base.newSessionId,
                        scheduler = base.scheduler,
                        onRotate = { trigger ->
                            landDeferred?.invoke()
                            landDeferred = null
                            base.onRotate?.invoke(trigger)
                        },
                    )
                },
            ),
        )
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        val integ = FakeIntegration().apply { deferSnapshot = true }
        c.track(integ, null)
        samplerOnTick!!()
        assertNotNull("precondition: the snapshot is outstanding", integ.deferred)
        val late = integ.deferred!!
        var answered: Boolean? = null
        landDeferred = { answered = late(PlayerSnapshot(1200, 5_000_000, 2_000_000, 1280, 720, 3)) }

        // Rotate: an idle gap wider than maxIdleMs, tripped by a sample.
        now += 1_800_001
        samplerOnSample!!(VitalsSample(t = now, mem = 1))

        assertEquals("a snapshot that missed its session must be answered false", false, answered)
        val types = c.currentStamp()!!.entries.filterIsInstance<VitalsPlayerEvent>().map { it.type }
        assertTrue("no stats may precede the reseeded player_attach: " + types, types.none { it == "stats" })
        assertEquals(listOf("player_attach", "source_change"), types)
    }

    @Test
    fun `a detach completing after a collector swap emits into neither collector`() {
        // Codex round-4, #8. A live-handle detach unregisters the player and
        // queues the integration's teardown on its own thread. A server-config
        // disable + re-enable landing before that runnable completes used to
        // hand its closing spans AND the `player_detach` marker to the NEW
        // collector — a detach-only timeline for a player that session never
        // saw attach.
        val c = controller()
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        val pending = ArrayList<() -> Unit>()
        val integ = object : FakeIntegration() {
            override fun detach(onComplete: () -> Unit) { detached++; pending.add(onComplete) }
        }
        val h = c.track(integ, null)

        h.detach()
        c.applyServerConfig(VitalsServerConfig(false, 1.0))   // collector #1 stops
        c.applyServerConfig(VitalsServerConfig(true, 1.0))    // collector #2 — a different session

        integ.ctx!!.emit("pause")     // the teardown's closing span
        pending.single()()            // ...and its completion, which marks the detach

        assertTrue(
            "the new collector must receive nothing for a player it never announced",
            c.currentStamp()!!.entries.filterIsInstance<VitalsPlayerEvent>().isEmpty(),
        )
    }

    // ---- Codex round-5 ----

    @Test
    fun `the library getter never runs under the registration's announce lock`() {
        // Codex round-5, #2. `integration.library`/`version` are CUSTOMER
        // getters and were read inside `announceLock`. A getter that waits for
        // the player's own lock — while the player thread holds it and is
        // itself blocked on this `announceLock`, completing a detach — hung
        // both threads for good.
        //
        // Scripted with the deadlock's exact shape: the getter hands a worker
        // thread the very detach that has to take `announceLock`, and waits.
        val c = controller()
        var handle: PlayerHandle? = null
        var armed = false
        var workerFinished: Boolean? = null
        val integ = object : PlayerIntegration {
            var detached = 0
            override val library: String
                get() {
                    if (armed) {
                        armed = false
                        val worker = Thread { handle!!.detach() }
                        worker.start()
                        worker.join(2_000)
                        workerFinished = !worker.isAlive
                    }
                    return "fake"
                }
            override val version: String? = "1"
            override fun attach(ctx: PlayerIntegrationContext) = true
            override fun snapshot(onResult: (PlayerSnapshot?) -> Boolean) { onResult(null) }
            override fun startupTimings(): StartupTimings? = null
            override fun describe(ctx: PlayerIntegrationContext) {}
            override fun detach() { detached++ }
        }
        handle = c.track(integ, null)
        armed = true

        c.applyServerConfig(VitalsServerConfig(true, 1.0))

        assertNotNull("precondition: the getter really ran during the announce", workerFinished)
        assertTrue(
            "the library getter ran under the announce monitor — a concurrent detach deadlocked against it",
            workerFinished!!,
        )
        assertEquals("...and the detach really completed", 1, integ.detached)
    }

    @Test
    fun `a throwing library getter still announces the player and never propagates`() {
        // The other half of #2: the getter used to throw out of `announce()`,
        // through `trackPlayer()`, into the host app — after the registration
        // had already been published, so the player was live and unannounced
        // forever.
        val c = controller()
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        val integ = object : PlayerIntegration {
            override val library: String get() = error("library blew up")
            override val version: String? get() = error("version blew up")
            override fun attach(ctx: PlayerIntegrationContext) = true
            override fun snapshot(onResult: (PlayerSnapshot?) -> Boolean) { onResult(null) }
            override fun startupTimings(): StartupTimings? = null
            override fun describe(ctx: PlayerIntegrationContext) {}
            override fun detach() {}
        }

        val h = c.track(integ, "main")

        assertEquals("p1", h.id)
        val attach = c.currentStamp()!!.entries.filterIsInstance<VitalsPlayerEvent>().single { it.type == "player_attach" }
        assertEquals("unknown", attach.data!!["library"]!!.jsonPrimitive.content)
        assertNull("a throwing version getter reports nothing at all", attach.data["libraryVersion"])
    }

    @Test
    fun `a describe emission coerces its customer map with no announce lock held`() {
        // Codex round-5, #3. A describe-context emit held `announceLock`
        // across `JsonCoerce.toJsonObject(data)` — and `data` is the
        // customer's own `Map`. One backed by player-locked state (an
        // `entries` getter that reaches for the player's lock) waits for a
        // thread that is itself blocked on this very `announceLock` in
        // track/detach: a permanent deadlock inside the SDK.
        val c = controller()
        var workerFinished: Boolean? = null
        val backing = mapOf<String, Any?>("src" to "s", "protocol" to "hls")
        val integ = object : FakeIntegration() {
            var handle: PlayerHandle? = null
            override fun describe(ctx: PlayerIntegrationContext) {
                described++
                val hostile = object : Map<String, Any?> by backing {
                    override val entries: Set<Map.Entry<String, Any?>>
                        get() {
                            if (workerFinished == null) {
                                val worker = Thread { handle!!.detach() }
                                worker.start()
                                worker.join(2_000)
                                workerFinished = !worker.isAlive
                            }
                            return backing.entries
                        }
                }
                ctx.emit("source_change", hostile)
            }
        }
        integ.handle = c.track(integ, null)

        c.applyServerConfig(VitalsServerConfig(true, 1.0))

        assertNotNull("precondition: the hostile map really was traversed", workerFinished)
        assertTrue(
            "the customer map was traversed under the announce monitor — a concurrent detach deadlocked against it",
            workerFinished!!,
        )
        // Round-4, #5 still holds: the detach won, so the delayed describe
        // emission is dropped rather than landing after the marker.
        assertEquals(
            listOf("player_attach", "player_detach"),
            c.currentStamp()!!.entries.filterIsInstance<VitalsPlayerEvent>().map { it.type },
        )
    }

    @Test
    fun `a live emission that races its own detach cannot land after player_detach`() {
        // Codex round-7, #2. A live callback resolves `announcedIn`, then
        // BUILDS its entry outside every lock — it must, because coercing the
        // customer's `data` map runs customer code (round-5, #3) — and a
        // detach completing in that window records `player_detach` into the
        // very session this entry is pinned to. The pin still matched, so an
        // opening `play` was admitted AFTER the marker that closed the
        // player, and nothing was left attached to ever close it. The session
        // pin cannot tell draining from done.
        //
        // Scripted with the round-5 #3 hostile map: its `entries` getter runs
        // the detach to completion, which is exactly "the entry was built
        // before, and admitted after".
        val c = controller()
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        val integ = FakeIntegration()
        val h = c.track(integ, "main")

        val backing = mapOf<String, Any?>("reason" to "resume")
        var detachRan = false
        val hostile = object : Map<String, Any?> by backing {
            override val entries: Set<Map.Entry<String, Any?>>
                get() {
                    if (!detachRan) { detachRan = true; h.detach() }
                    return backing.entries
                }
        }

        assertFalse(
            "a live emission admitted after its detach completed must be refused",
            integ.ctx!!.emit("play", hostile, null),
        )
        assertTrue("precondition: the detach really completed mid-build", detachRan)
        assertEquals(1, integ.detached)
        assertEquals(
            listOf("player_attach", "source_change", "player_detach"),
            c.currentStamp()!!.entries.filterIsInstance<VitalsPlayerEvent>().map { it.type },
        )
    }

    @Test
    fun `a live callback between a re-enable and that player's announcement records nothing`() {
        // Codex round-5, #7. `announced` was a bare boolean, set once and
        // never cleared. A server-config disable stops C1; the re-enable
        // publishes C2 and announces the live players from the tail, OUTSIDE
        // the monitor — so a player callback arriving in that window passed
        // the stale boolean and recorded into C2 AHEAD of that player's own
        // `player_attach`, which is exactly what round-2 Important 5 forbids.
        //
        // Made deterministic by emitting from the SECOND player's live context
        // inside the FIRST player's `describe()`, which runs inside C2's
        // announce tail before the second player has been announced at all.
        val c = controller()
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        val second = FakeIntegration()
        val first = object : FakeIntegration() {
            var armed = false
            override fun describe(ctx: PlayerIntegrationContext) {
                super.describe(ctx)
                if (armed) { armed = false; second.ctx!!.emit("play", null, null) }
            }
        }
        c.track(first, "one")
        c.track(second, "two")

        c.applyServerConfig(VitalsServerConfig(false, 1.0))   // C1 stops
        first.armed = true
        c.applyServerConfig(VitalsServerConfig(true, 1.0))    // C2 is published, then announces

        val p2 = c.currentStamp()!!.entries.filterIsInstance<VitalsPlayerEvent>().filter { it.playerId == "p2" }
        assertEquals("precondition: the second player really was announced into C2", 1, p2.count { it.type == "player_attach" })
        assertEquals(
            "nothing may reach a new collector before that player's own player_attach",
            "player_attach",
            p2.first().type,
        )
    }

    @Test
    fun `a live callback between a rotation and that player's reseed records nothing in the new session`() {
        // Codex round-5, #6. A live callback resolved to whatever collector
        // was CURRENT, so one arriving after a rotation but before that
        // player's own reseed landed in the new session ahead of its
        // `player_attach`. The pin is taken at announce time and carries the
        // session it landed in, so the entry is refused instead — the
        // documented lossy path.
        var ids = 0
        val c = VitalsController(
            VitalsController.Deps(
                localConfig = VitalsConfig(),
                dims = SessionSummaryDims("android", "1", "0.8.0"),
                transport = { sink() },
                scheduler = FakeScheduler(),
                samplerFactory = { onSample, onTick ->
                    samplerOnSample = onSample; samplerOnTick = onTick
                    object : ResourceSampler(handler = android.os.Handler(android.os.Looper.getMainLooper()), onSample = onSample, onTick = onTick) {}
                },
                lifecycle = { _, _ -> null },
                now = { now },
                random = { draw },
                newSessionId = { "sid-${ids++}" },
            ),
        )
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        val second = FakeIntegration()
        val first = object : FakeIntegration() {
            var armed = false
            override fun describe(ctx: PlayerIntegrationContext) {
                super.describe(ctx)
                if (armed) { armed = false; second.ctx!!.emit("play", null, null) }
            }
        }
        c.track(first, "one")
        c.track(second, "two")

        val before = c.currentStamp()!!.sessionId
        first.armed = true
        now += 1_800_001
        c.trackVitals("rotate-me", null, null)
        assertNotEquals("precondition: the session really rotated", before, c.currentStamp()!!.sessionId)

        val p2 = c.currentStamp()!!.entries.filterIsInstance<VitalsPlayerEvent>().filter { it.playerId == "p2" }
        assertEquals("precondition: the reseed really re-announced the second player", 1, p2.count { it.type == "player_attach" })
        assertEquals(
            "nothing may reach a new session before that player's reseeded player_attach",
            "player_attach",
            p2.first().type,
        )
    }

    @Test
    fun `a player_attach that trips a rotation announces that player exactly once`() {
        // Codex round-5, #8. A new player's `player_attach` recorded after a
        // long idle gap rotates the session and lands in the NEW one. The
        // rotation callback then reseeded every live player — including the
        // one currently being announced — so it got a second `player_attach`
        // and a second `describe()`. A player must not appear in one
        // timeline twice, whatever the accumulator does with the duplicate
        // `play` that follows (Codex round-7, #1 makes that half harmless).
        val c = controller()
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        val existing = FakeIntegration()
        c.track(existing, "one")

        now += 1_800_001
        val joining = FakeIntegration().apply { playing = true }
        c.track(joining, "two")

        val p2 = c.currentStamp()!!.entries.filterIsInstance<VitalsPlayerEvent>().filter { it.playerId == "p2" }
        assertEquals("precondition: the attach really rotated the session", 1, existing.described - 1)
        assertEquals("exactly one attach for the joining player", 1, p2.count { it.type == "player_attach" })
        assertEquals("...and exactly one open play span", 1, p2.count { it.type == "play" })
        assertEquals("...described once, not twice", 1, joining.described)
    }

    @Test
    fun `a detach completing after a session rotation emits into neither session`() {
        // The session-id half of #8: the collector is the same object, but the
        // session it is in is not the one the detach began against.
        var ids = 0
        val c = VitalsController(
            VitalsController.Deps(
                localConfig = VitalsConfig(),
                dims = SessionSummaryDims("android", "1", "0.8.0"),
                transport = { sink() },
                scheduler = FakeScheduler(),
                samplerFactory = { onSample, onTick ->
                    samplerOnSample = onSample; samplerOnTick = onTick
                    object : ResourceSampler(handler = android.os.Handler(android.os.Looper.getMainLooper()), onSample = onSample, onTick = onTick) {}
                },
                lifecycle = { _, _ -> null },
                now = { now },
                random = { draw },
                newSessionId = { "sid-${ids++}" },
            ),
        )
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        val pending = ArrayList<() -> Unit>()
        val integ = object : FakeIntegration() {
            override fun detach(onComplete: () -> Unit) { detached++; pending.add(onComplete) }
        }
        val h = c.track(integ, null)

        h.detach()
        val before = c.currentStamp()!!.sessionId
        now += 1_800_001
        c.trackVitals("rotate-me", null, null)
        assertNotEquals("precondition: the session really rotated", before, c.currentStamp()!!.sessionId)

        integ.ctx!!.emit("pause")
        pending.single()()

        assertTrue(
            "a detach that began in the previous session must not be marked in this one",
            c.currentStamp()!!.entries.filterIsInstance<VitalsPlayerEvent>().isEmpty(),
        )
    }

    // ---- Codex round-6 ----

    @Test
    fun `a player_detach after a long idle gap is dropped, not rotated into a fresh session`() {
        // Codex round-6, #3. Detaching a paused player after a long
        // background idle unregisters it and only then records its marker.
        // The marker carried the session pin, passed the equality check, and
        // then rotated the collector and landed in the NEW session — where
        // the reseed, which walks only LIVE registrations, would never
        // announce that player. The result was a `player_detach` for a player
        // the session had never seen attach.
        //
        // The pin means "this session or nowhere": the marker is refused.
        // Its session was finalized and sent the moment the gap opened.
        val c = controller()
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        val integ = FakeIntegration()
        val h = c.track(integ, null)

        now += 1_800_001
        h.detach()

        assertEquals("precondition: the integration really tore down", 1, integ.detached)
        // Flush everything the collector is holding, so nothing is hiding in
        // an unsent buffer.
        c.applyServerConfig(VitalsServerConfig(false, 1.0))
        assertTrue(
            "a marker for a player whose session has aged out must appear in no session at all",
            sent.none { it.contains("player_detach") },
        )
        assertEquals(
            "...and it must not have rotated a session of its own",
            1,
            payloads().count { it["final"]?.jsonPrimitive?.content == "true" },
        )
    }

    @Test
    fun `a describe emission from a superseded announcement is dropped`() {
        // Codex round-6, #4. A describe context pinned the COLLECTOR and
        // re-read `reg.announcedIn` on every emission. A rotation during a
        // slow `describe()` therefore let the reseed re-announce and
        // re-describe the player — and when the ORIGINAL describe resumed it
        // still matched on collector identity (a rotation keeps the same
        // collector object) and emitted into the NEW announcement as well —
        // a superseded announcement's view of the player restated into a
        // timeline that had already been told the current one. (Round-7 #1
        // made the duplicate `play` harmless at the accumulator; the stale
        // identity it travels with is what this drops.)
        //
        // Scripted by holding the first describe's context and using it after
        // the reseed has re-described the player, which is exactly the
        // resumed-describe moment.
        val c = controller()
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        val integ = object : FakeIntegration() {
            var firstCtx: PlayerIntegrationContext? = null
            override fun describe(ctx: PlayerIntegrationContext) {
                described++
                // The first announce's describe is the SLOW one: it captures
                // its context and emits nothing yet.
                if (firstCtx == null) { firstCtx = ctx; return }
                // Every later describe is a reseed, re-opening the span.
                ctx.emit("play")
            }
        }
        c.track(integ, null)
        val stale = integ.firstCtx!!

        now += 1_800_001
        samplerOnSample!!(VitalsSample(t = now, mem = 1))
        assertEquals("precondition: the rotation really re-described the player", 2, integ.described)

        assertFalse(
            "an emission from a superseded announcement must be dropped",
            stale.emit("play", null, null),
        )

        val types = c.currentStamp()!!.entries.filterIsInstance<VitalsPlayerEvent>().map { it.type }
        assertEquals(listOf("player_attach", "play"), types)
        assertEquals("exactly one open play span in the new session", 1, types.count { it == "play" })
    }

    @Test
    fun `a snapshot that races its own detach cannot land after player_detach`() {
        // Codex round-6, #6. `collectStats` checked `isLive()` and resolved
        // the announcement OUTSIDE `announceLock`, and only then recorded —
        // a plain TOCTOU. An asynchronous snapshot could pass the liveness
        // check, pause, and resume after another thread had unregistered the
        // player and recorded its `player_detach`; the announcement still
        // matched, so `stats` was admitted AFTER the marker that closed the
        // player and the integration committed its dropped-frame delta
        // against it.
        //
        // The window is scripted through the clock: `buildPlayerEvent` stamps
        // the entry with `deps.now()`, which the old code reached only after
        // its liveness check. Detaching from inside that call puts the whole
        // detach exactly where the gap was.
        var onNow: (() -> Unit)? = null
        val c = VitalsController(
            VitalsController.Deps(
                localConfig = VitalsConfig(),
                dims = SessionSummaryDims("android", "1", "0.8.0"),
                transport = { sink() },
                scheduler = FakeScheduler(),
                samplerFactory = { onSample, onTick ->
                    samplerOnSample = onSample; samplerOnTick = onTick
                    object : ResourceSampler(handler = android.os.Handler(android.os.Looper.getMainLooper()), onSample = onSample, onTick = onTick) {}
                },
                lifecycle = { _, _ -> null },
                now = { onNow?.invoke(); now },
                random = { draw },
                newSessionId = { "sid" },
            ),
        )
        c.applyServerConfig(VitalsServerConfig(true, 1.0))
        val integ = FakeIntegration().apply { deferSnapshot = true }
        val h = c.track(integ, null)
        samplerOnTick!!()
        assertNotNull("precondition: the snapshot is outstanding", integ.deferred)
        val late = integ.deferred!!

        // Fires once, from inside the stats entry's own timestamp read.
        onNow = { onNow = null; h.detach() }
        val answered = late(PlayerSnapshot(1200, 5_000_000, 2_000_000, 1280, 720, 3))

        assertEquals("a snapshot that lost the race must be answered false", false, answered)
        val types = c.currentStamp()!!.entries.filterIsInstance<VitalsPlayerEvent>().map { it.type }
        assertEquals(listOf("player_attach", "source_change", "player_detach"), types)
        assertTrue("stats must never land after the player_detach that closed its player", types.none { it == "stats" })
    }
}
