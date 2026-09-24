// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.vitals

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RemotePlayerIntegrationTest {
    private class Ctx : PlayerIntegrationContext {
        val emitted = mutableListOf<Triple<String, Map<String, Any?>?, Long?>>()
        var admit = true
        override fun emit(type: String, data: Map<String, Any?>?, t: Long?): Boolean { emitted += Triple(type, data, t); return admit }
        override fun now(): Long = 1_757_000_000_000
        fun types() = emitted.map { it.first }
    }

    /**
     * The clock is PINNED, and to an instant BEFORE the `1_757_000_000_1xx` host timestamps
     * these tests feed. It used to be the default wall clock, which since codex round-3's E1
     * reseed floor is load-bearing: `attach()` records its seed instant, and a host event
     * stamped before it is emitted AT the seed. With the real clock (now well past
     * 1_757_000_000_000) every span event below would be floored to "now" and
     * `forwards events with the JS timestamp once attached` would assert the wrong thing on a
     * machine whose date is not the one the test was written on.
     */
    private fun integration(keepQuery: Boolean = false) =
        RemotePlayerIntegration(
            library = "react-native-video", version = "7.0.0", captureSourceQuery = { keepQuery },
            now = { 1_757_000_000_000 },
        )

    @Test fun `forwards events with the JS timestamp once attached`() {
        val i = integration(); val ctx = Ctx(); assertTrue(i.attach(ctx)); ctx.emitted.clear()
        i.record("play", 1_757_000_000_100, null)
        assertEquals(listOf(Triple("play", null, 1_757_000_000_100L)), ctx.emitted)
    }

    @Test fun `source_change src is sanitised on emission — query stripped by default`() {
        val i = integration(); val ctx = Ctx(); i.attach(ctx); ctx.emitted.clear()
        i.record("source_change", 1L, mapOf("src" to "https://cdn.example/a.m3u8?token=secret", "live" to true))
        val data = ctx.emitted.single().second!!
        assertEquals("https://cdn.example/a.m3u8", data["src"]); assertEquals("hls", data["protocol"]); assertEquals(true, data["live"])
    }

    @Test fun `mime wins over the URL extension for protocol, extensionless URLs included`() {
        val i = integration(); val ctx = Ctx(); i.attach(ctx); ctx.emitted.clear()
        i.record("source_change", 1L, mapOf("src" to "https://cdn/live/master", "mime" to "application/x-mpegurl"))
        assertEquals("hls", ctx.emitted.single().second!!["protocol"])
    }

    @Test fun `no mime — the extension still decides the protocol`() {
        val i = integration(); val ctx = Ctx(); i.attach(ctx); ctx.emitted.clear()
        i.record("source_change", 1L, mapOf("src" to "https://cdn.example/a.mpd"))
        assertEquals("dash", ctx.emitted.single().second!!["protocol"])
    }

    @Test fun `an unknown or reserved lifecycle type is silently dropped and never touches the model`() {
        val i = integration(); val ctx = Ctx(); i.attach(ctx); ctx.emitted.clear()
        i.record("player_attach", 1L, null)
        i.record("player_detach", 2L, null)
        i.record("bogus", 3L, mapOf("src" to "https://c/a.m3u8"))
        assertTrue(ctx.emitted.isEmpty())
        // A following attach seeds nothing — the bogus "source_change"-shaped data never
        // reached the model because `record` returned before the `when` ran.
        val rotated = Ctx(); i.describe(rotated)
        assertTrue(rotated.emitted.isEmpty())
    }

    @Test fun `captureSourceQuery keeps the query`() {
        val i = integration(keepQuery = true); val ctx = Ctx(); i.attach(ctx); ctx.emitted.clear()
        i.record("source_change", 1L, mapOf("src" to "https://cdn.example/a.mpd?x=1"))
        assertEquals("https://cdn.example/a.mpd?x=1", ctx.emitted.single().second!!["src"])
    }

    @Test fun `events before attach only update the model and attach seeds identity then open spans`() {
        val i = integration()
        i.record("source_change", 1L, mapOf("src" to "https://c/a.m3u8"))
        i.record("drm", 2L, mapOf("keySystem" to "widevine"))
        i.record("play", 3L, null); i.record("buffer_start", 4L, null)
        val ctx = Ctx(); i.attach(ctx)
        assertEquals(listOf("source_change", "drm", "play", "buffer_start"), ctx.types())
    }

    @Test fun `pause closes the play span and buffer_end the buffer span`() {
        val i = integration(); i.record("play", 1L, null); i.record("pause", 2L, null)
        i.record("buffer_start", 3L, null); i.record("buffer_end", 4L, mapOf("durationMs" to 100))
        val ctx = Ctx(); i.attach(ctx)
        assertEquals(emptyList<String>(), ctx.types())
    }

    @Test fun `describe re-emits identity and open spans — say too much`() {
        val i = integration(); val ctx = Ctx(); i.attach(ctx)
        i.record("source_change", 1L, mapOf("src" to "https://c/a.m3u8")); i.record("play", 2L, null)
        val rotated = Ctx(); i.describe(rotated)
        assertEquals(listOf("source_change", "play"), rotated.types())
    }

    @Test fun `snapshot serves fresh stats once then idles`() {
        val i = integration(); i.attach(Ctx())
        i.updateStats(mapOf("bufferAheadMs" to 1500.0, "bitrate" to 3_000_000.0, "width" to 1920.0, "height" to 1080.0))
        var got: PlayerSnapshot? = null
        i.snapshot { got = it; true }
        assertEquals(PlayerSnapshot(bufferAheadMs = 1500, bandwidthEstimate = null, bitrate = 3_000_000, width = 1920, height = 1080, droppedFramesDelta = 0), got)
        var second: PlayerSnapshot? = PlayerSnapshot(0, null, null, null, null, 0)
        i.snapshot { second = it; true }
        assertNull(second)
    }

    @Test fun `dropped frames delta commits only on an accepted snapshot`() {
        val i = integration(); i.attach(Ctx())
        i.updateStats(mapOf("bufferAheadMs" to 1.0, "droppedFrames" to 10.0))
        i.snapshot { assertEquals(10, it!!.droppedFramesDelta); false }   // rejected
        i.updateStats(mapOf("bufferAheadMs" to 1.0, "droppedFrames" to 14.0))
        i.snapshot { assertEquals(14, it!!.droppedFramesDelta); true }    // still uncommitted → full delta
        i.updateStats(mapOf("bufferAheadMs" to 1.0, "droppedFrames" to 15.0))
        i.snapshot { assertEquals(1, it!!.droppedFramesDelta); true }
    }

    @Test fun `non-finite and negative stats fields are dropped, the snapshot is not`() {
        val i = integration(); i.attach(Ctx())
        i.updateStats(mapOf("bufferAheadMs" to Double.NaN, "bitrate" to -5.0, "width" to Double.POSITIVE_INFINITY))
        var got: PlayerSnapshot? = null; i.snapshot { got = it; true }
        assertEquals(PlayerSnapshot(null, null, null, null, null, 0), got)
    }

    @Test fun `startupTimings is null and detach on a never-attached integration is a no-op`() {
        val i = integration(); assertNull(i.startupTimings()); i.detach()
        val ctx = Ctx(); i.attach(ctx); ctx.emitted.clear(); i.detach()
        i.record("play", 1L, null)
        assertTrue(ctx.emitted.isEmpty())
    }

    /**
     * Codex round-1, C1 — `player_detach` is not a closer at the accumulator: only
     * `pause` closes a play span and only `buffer_end` closes a buffer span. A host that
     * navigates away mid-playback therefore left a span accruing to the end of the SESSION.
     * `buffer_end` first (the rebuffer is nested inside the play span), then `pause`.
     */
    @Test fun `detach closes the open buffer span then the open play span, exactly once`() {
        val i = RemotePlayerIntegration("rnv", null, { false }, { 9_000L })
        val ctx = Ctx(); i.attach(ctx)
        i.record("play", 1L, null); i.record("buffer_start", 2L, null)
        ctx.emitted.clear()
        i.detach()
        assertEquals(listOf(Triple("buffer_end", null, 9_000L), Triple("pause", null, 9_000L)), ctx.emitted)
        ctx.emitted.clear()
        i.detach()                                   // idempotent: the latches are cleared
        assertTrue(ctx.emitted.isEmpty())
    }

    @Test fun `detach on an integration that never attached emits nothing`() {
        val i = RemotePlayerIntegration("rnv", null, { false }, { 9_000L })
        i.record("play", 1L, null); i.record("buffer_start", 2L, null)
        i.detach()                                   // no ctx: nothing to emit into
        val ctx = Ctx(); i.attach(ctx)
        // Round-4, F1 changed the second half of this expectation. It used to assert an empty
        // context — "detach really cleared the model" — because `detach()` reset
        // `playing`/`buffering`. It now clears only the ANNOUNCED state, so HOST truth (the
        // player is playing and stalled; nobody said otherwise) survives and the attach seeds
        // it. The first half is unchanged: a detach with no bound ctx emits nothing.
        assertEquals(listOf("play", "buffer_start"), ctx.types())
    }

    /**
     * Codex round-1, C2 — the ORDERED OUTBOX. The seed used to copy the model, unlock and
     * emit; a `record("pause")` landing in that window emitted FIRST and left the stale
     * seed to emit `play` LAST, opening a play span for a paused player that nothing would
     * ever close. This drives that interleaving deterministically: the context re-enters
     * `record("pause")` from inside the seed's own `emit`.
     */
    @Test fun `a seed cannot overtake a live transition — the outbox preserves model order`() {
        lateinit var i: RemotePlayerIntegration
        val order = mutableListOf<String>()
        var raced = false
        val racing = object : PlayerIntegrationContext {
            override fun emit(type: String, data: Map<String, Any?>?, t: Long?): Boolean {
                if (type == "play" && !raced) { raced = true; i.record("pause", 5L, null) }
                order += type
                return true
            }
            override fun now() = 0L
        }
        i = RemotePlayerIntegration("rnv", null, { false }, { 9_000L })
        i.record("play", 1L, null)                   // model only — not attached yet
        i.attach(racing)                             // the seed emits `play`; emit re-enters record("pause")
        assertEquals(listOf("play", "pause"), order)
        val after = Ctx(); i.describe(after)
        assertTrue(after.emitted.isEmpty())          // the model really is paused
    }

    /**
     * Codex round-1, C8/C12 — a new source's `drm` arrives AFTER its own `source_change`
     * if it arrives at all, and the host-fed stats describe the OUTGOING source.
     */
    @Test fun `source_change clears the cached drm and the cached stats`() {
        val i = integration(); val ctx = Ctx(); i.attach(ctx)
        i.record("source_change", 1L, mapOf("src" to "https://c/a.m3u8"))
        i.record("drm", 2L, mapOf("keySystem" to "widevine"))
        i.updateStats(mapOf("bufferAheadMs" to 4000.0))
        i.record("source_change", 3L, mapOf("src" to "https://c/b.mpd"))
        val rotated = Ctx(); i.describe(rotated)
        assertEquals(listOf("source_change"), rotated.types())
        assertEquals("https://c/b.mpd", rotated.emitted.single().second!!["src"])
        var got: PlayerSnapshot? = PlayerSnapshot(0, null, null, null, null, 0)
        i.snapshot { got = it; true }
        assertNull(got)
    }

    /** Codex round-1, C13 — the Swift twin's `nonNegInt64` rejects booleans explicitly; Kotlin's
     *  `as? Number` already does, and both now share the 9.2e18 upper bound. */
    @Test fun `booleans and out-of-range magnitudes are not numbers`() {
        val i = integration(); i.attach(Ctx())
        i.updateStats(mapOf("width" to true, "height" to 9.21e18, "bitrate" to -5.0, "bufferAheadMs" to Double.NaN, "droppedFrames" to 3.0))
        var got: PlayerSnapshot? = null; i.snapshot { got = it; true }
        assertEquals(PlayerSnapshot(null, null, null, null, null, 3), got)
    }

    // ---- Codex round-2, D1 — the detach completion is an ordered outbox barrier ----

    /**
     * Records what it is given and REFUSES everything once `detached` is set — the fake
     * controller. `VitalsController` sets exactly that flag from the completion callback (and
     * records `player_detach` there), so anything this integration still owed the timeline
     * after the completion fires is lost, and the play span it should have closed accrues to
     * the end of the session.
     */
    private class DetachRaceCtx : PlayerIntegrationContext {
        private val l = Any()
        private val order0 = mutableListOf<String>()
        private var detached = false
        /** Run from inside `emit("play")`, once, to drive the race deterministically. */
        var onPlay: (() -> Unit)? = null
        val order: List<String> get() = synchronized(l) { ArrayList(order0) }
        fun markDetached() = synchronized(l) { order0 += "complete"; detached = true }
        override fun emit(type: String, data: Map<String, Any?>?, t: Long?): Boolean {
            synchronized(l) {
                if (detached) return false               // the controller refuses it: reg.detached
                order0 += type
            }
            if (type == "play") { val h = onPlay; onPlay = null; h?.invoke() }
            return true
        }
        override fun now() = 0L
    }

    private fun racingIntegration() = RemotePlayerIntegration("rnv", null, { false }, { 9_000L })

    /**
     * Re-entrant variant: the detach is requested from INSIDE the drain, on the drainer's own
     * thread. The completion must still land behind the `pause` this teardown queued.
     */
    @Test fun `detach completion runs after the closing spans, re-entrantly`() {
        val i = racingIntegration()
        val ctx = DetachRaceCtx()
        var completions = 0
        ctx.onPlay = { i.detach { completions++; ctx.markDetached() } }
        i.record("play", 1L, null)                       // model only — not attached yet
        i.attach(ctx)                                    // the seed emits `play`; emit re-enters detach
        assertEquals(listOf("play", "pause", "complete"), ctx.order)
        assertEquals(1, completions)
    }

    /**
     * Cross-thread variant: this thread owns the drain (parked inside `emit("play")`), another
     * thread calls `detach(onComplete)`. That thread must not block — the latch it counts down
     * AFTER `detach` returns is what the drainer is waiting on, so a teardown that waited on
     * the drain would deadlock — and the completion must still be run by the drainer, after
     * the `pause`, which must be ADMITTED.
     */
    @Test fun `detach completion is ordered behind the closers across threads`() {
        val i = racingIntegration()
        val ctx = DetachRaceCtx()
        val detachReturned = java.util.concurrent.CountDownLatch(1)
        val completed = java.util.concurrent.CountDownLatch(1)
        val completions = java.util.concurrent.atomic.AtomicInteger(0)
        ctx.onPlay = {
            val b = Thread {
                i.detach { completions.incrementAndGet(); ctx.markDetached(); completed.countDown() }
                detachReturned.countDown()               // detach never blocks on the drain
            }
            b.start()
            assertTrue(detachReturned.await(5, java.util.concurrent.TimeUnit.SECONDS))
        }
        i.record("play", 1L, null)
        i.attach(ctx)                                    // this thread owns the drain throughout
        assertTrue(completed.await(5, java.util.concurrent.TimeUnit.SECONDS))
        assertEquals(listOf("play", "pause", "complete"), ctx.order)
        assertEquals(1, completions.get())
    }

    /** The synchronous `detach()` is unchanged: closers, no completion, still idempotent. */
    @Test fun `the synchronous detach still queues the closers with no completion`() {
        val i = racingIntegration()
        val ctx = Ctx(); i.attach(ctx)
        i.record("play", 1L, null); i.record("buffer_start", 2L, null)
        ctx.emitted.clear()
        i.detach()
        assertEquals(listOf("buffer_end", "pause"), ctx.types())
        // …and the async form on an integration with nothing open still completes exactly once.
        var completions = 0
        i.detach { completions++ }
        assertEquals(1, completions)
        assertEquals(listOf("buffer_end", "pause"), ctx.types())
    }

    // MARK: - Codex round-3, E1 (the reseed floor) and E2 (attachment rollback)

    /** A movable clock, so one integration can be seeded across a rotation. */
    private fun clocked(read: () -> Long) =
        RemotePlayerIntegration("rnv", null, { false }, read)

    /**
     * E1 — the bridge is asynchronous. A JS `pause` stamped at 1900 can still be in flight when
     * the native side rotates at 2000 and `describe()` re-opens the play span there. Delivered
     * with its own 1900 the collector DROPS it (it predates the session), the reseeded play span
     * never closes, and `detach()` closes nothing either because the model is already paused —
     * the session accrues playtime for a player that has been paused throughout. Stamped at the
     * seed it closes the span it was meant to close, as a zero-length one.
     */
    @Test fun `a span transition predating the reseed is stamped at the seed`() {
        var clock = 1_000L
        val i = clocked { clock }
        // `describe` seeds into the ROTATION's context; the attach-time one stays live and is
        // where every later host event goes (the controller routes it to the current session).
        val live = Ctx(); i.attach(live)
        i.record("play", 1_500L, null)
        live.emitted.clear()
        clock = 2_000L
        val rotated = Ctx(); i.describe(rotated)
        assertEquals(listOf("play"), rotated.types())
        assertEquals(2_000L, rotated.emitted[0].third)          // the seed itself

        i.record("pause", 1_900L, null)                         // bridge-delayed, predates the seed
        assertEquals(listOf("pause"), live.types())
        assertEquals(2_000L, live.emitted[0].third)             // …stamped at the seed, not dropped
    }

    /**
     * Only the four SPAN types are floored. A `seek` is a point in time, and moving it would
     * misreport when it happened for no gain.
     */
    @Test fun `a non-span event keeps the host timestamp across a reseed`() {
        var clock = 1_000L
        val i = clocked { clock }
        val live = Ctx(); i.attach(live)
        clock = 2_000L
        i.describe(Ctx())
        i.record("seek", 1_900L, mapOf("fromMs" to 10, "toMs" to 20))
        assertEquals(listOf("seek"), live.types())
        assertEquals(1_900L, live.emitted[0].third)
    }

    /** A span transition at or after the seed is untouched — the floor is a floor, not a stamp. */
    @Test fun `a span transition at or after the seed keeps its own timestamp`() {
        var clock = 1_000L
        val i = clocked { clock }
        val live = Ctx(); i.attach(live)
        clock = 2_000L
        i.describe(Ctx())
        i.record("play", 2_000L, null)                          // exactly at the seed
        i.record("pause", 2_500L, null)                         // after it
        assertEquals(listOf("play", "pause"), live.types())
        assertEquals(listOf(2_000L, 2_500L), live.emitted.map { it.third })
    }

    /**
     * E2 — an attachment rollback is not a teardown. The controller attaches BEFORE it
     * publishes; a superseding `start()` refuses the publication and `VitalsRuntime` retries
     * THIS SAME integration against the next controller. A terminal `detach()` there cleared
     * `playing`/`buffering`, so the retry announced a playing player with no open spans and its
     * uninterrupted playback was never measured.
     */
    @Test fun `rollbackAttach keeps the host model and emits nothing`() {
        val i = clocked { 9_000L }
        i.record("source_change", 1L, mapOf("src" to "https://c/a.m3u8"))
        i.record("play", 2L, null)
        i.record("buffer_start", 3L, null)

        val a = Ctx(); i.attach(a)                              // controller A: seeded
        assertEquals(listOf("source_change", "play", "buffer_start"), a.types())
        a.emitted.clear()

        i.rollbackAttach()                                      // the publication was refused
        assertTrue(a.emitted.isEmpty())                         // no pause, no buffer_end, nothing

        val b = Ctx(); i.attach(b)                              // the runtime retries against B
        assertEquals(listOf("source_change", "play", "buffer_start"), b.types())
        assertTrue(a.emitted.isEmpty())                         // A heard nothing after the rollback
        // …and no closer was fabricated for either context at any point.
        assertTrue("pause" !in (a.types() + b.types()))
        assertTrue("buffer_end" !in (a.types() + b.types()))
    }

    /**
     * Codex round-4, F1 — HOST TRUTH vs the ANNOUNCED span state, and the reason the split
     * exists: a `detach()` unbinds the announcement without stopping the player, and THIS SAME
     * object is bound again on every re-attach path (a deferred registration retried after a
     * rollback, a controller re-announcing the player against a new session). If `detach()`
     * still cleared the model, that re-attached registration would announce a playing player
     * with no open span — and for uninterrupted playback no later transition ever comes to
     * open one.
     *
     * This test replaces `the terminal detach still clears the model, unlike a rollback`, whose
     * second assertion (`b` hears nothing) is exactly the behaviour the ruling reverses. What
     * still separates a detach from a rollback is the FIRST half — the detach closes the
     * announced span, the rollback (see above) emits nothing at all.
     */
    @Test fun `detach closes the announced span but host truth survives into the next attach`() {
        val i = clocked { 9_000L }
        i.record("play", 1L, null)
        val a = Ctx(); i.attach(a); a.emitted.clear()
        i.detach()
        assertEquals(listOf("pause"), a.types())                // the announced span is closed
        val b = Ctx(); i.attach(b)
        assertEquals(listOf("play"), b.types())                 // …and host truth survived it
        assertEquals(listOf("pause"), a.types())                // A heard nothing more
    }

    /**
     * The announced state is what `detach()` closes, and it is per-ATTACHMENT: a transition
     * recorded while nothing is bound moves host truth only, so the next detach must not
     * fabricate a closer for a span the bound ctx never heard open.
     */
    @Test fun `detach closes nothing for a span the bound context never heard open`() {
        val i = clocked { 9_000L }
        val a = Ctx(); i.attach(a)                              // attached with nothing playing
        i.detach()                                              // unbinds; announced state empty
        i.record("play", 1L, null)                              // host truth only — no ctx bound
        a.emitted.clear()
        val b = Ctx(); i.attach(b)
        assertEquals(listOf("play"), b.types())                 // seeded from host truth
        b.emitted.clear()
        i.record("pause", 2L, null)
        i.detach()
        assertEquals(listOf("pause"), b.types())                // the pause itself, and no second one
    }

    @Test fun `library and version are exposed`() {
        val i = integration(); assertEquals("react-native-video", i.library); assertEquals("7.0.0", i.version)
    }
}
