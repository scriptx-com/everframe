// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.vitals

import dev.everframe.envelope.InternalLogger
import dev.everframe.vitals.wire.SessionSummary
import dev.everframe.vitals.wire.SessionSummaryDims
import dev.everframe.vitals.wire.VitalsChunk
import dev.everframe.vitals.wire.VitalsCustomEntry
import dev.everframe.vitals.wire.VitalsIngestPayload
import dev.everframe.vitals.wire.VitalsPlayerEvent
import dev.everframe.vitals.wire.VitalsSample
import dev.everframe.vitals.wire.VitalsWireCodec
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class VitalsCollectorTest {
    @Before
    fun drainLogger() {
        // Failures accumulate in a process-wide ring buffer; drain before
        // each test so the throwing-send / onRotate assertions below are
        // order-independent instead of seeing a prior test's leftovers.
        InternalLogger.drainFailures()
    }

    private class FakeScheduler : VitalsScheduler {
        var tick: (() -> Unit)? = null
        var closed = false
        override fun repeat(intervalMs: Long, tick: () -> Unit): AutoCloseable {
            this.tick = tick
            return AutoCloseable { closed = true; this.tick = null }
        }
        fun fire() = tick?.invoke()
    }

    private val dims = SessionSummaryDims("android", "1", "0.8.0")
    private var now = 1_000_000L
    private val sent = ArrayList<VitalsIngestPayload>()
    private val scheduler = FakeScheduler()
    private var ids = 0

    private fun collector(
        send: (VitalsIngestPayload) -> Unit = { sent.add(it) },
        maxBufferBytes: Int = 65_536,
        onRotate: ((dev.everframe.vitals.wire.VitalsEntry?) -> Unit)? = null,
        maxSeq: Int = dev.everframe.vitals.wire.VitalsLimits.MAX_SEQ,
        maxEntriesPerChunk: Int = 50,
        summaryEveryChunks: Int = 5,
    ) = VitalsCollector(
        VitalsCollector.Deps(
            dims = dims, now = { now }, send = send, newSessionId = { "sid-${ids++}" }, scheduler = scheduler,
            maxBufferBytes = maxBufferBytes, maxEntriesPerChunk = maxEntriesPerChunk, onRotate = onRotate, maxSeq = maxSeq,
            summaryEveryChunks = summaryEveryChunks,
        ),
    )

    private fun sample(mem: Long = 1) = VitalsSample(t = now, mem = mem)

    /**
     * A TRANSPORTED entry. Samples feed the accumulator and count as activity
     * but never reach the chunk queue or the recent ring (see
     * VitalsCollector.addEntry), so every test about chunking, flushing,
     * the ring or the stamp must drive one of these instead. `n` rides in
     * `data` as the identity `mem` used to provide.
     */
    private fun event(n: Long = 1) = VitalsPlayerEvent(
        t = now,
        type = "seek",
        data = buildJsonObject { put("n", n) },
    )

    private fun nOf(e: Any): Long =
        (e as VitalsPlayerEvent).data!!["n"]!!.jsonPrimitive.content.toLong()
    private val chunks get() = sent.filterIsInstance<VitalsChunk>()
    private val summaries get() = sent.filterIsInstance<SessionSummary>()

    @Test
    fun `sends an initial non-final summary on creation`() {
        collector()
        assertEquals(1, sent.size)
        val s = summaries.single()
        assertEquals(false, s.final); assertEquals(0, s.seq); assertEquals("sid-0", s.sessionId)
    }

    @Test
    fun `flushes a chunk at 50 entries without the timer`() {
        val c = collector()
        repeat(49) { c.recordPlayerEvent(event()) }
        assertEquals(0, chunks.size)
        c.recordPlayerEvent(event())
        assertEquals(1, chunks.size); assertEquals(50, chunks[0].entries.size); assertEquals(0, chunks[0].seq)
    }

    @Test
    fun `flushes on the interval tick and increments seq, nothing when empty`() {
        val c = collector()
        c.recordPlayerEvent(event()); scheduler.fire()
        c.recordPlayerEvent(event()); scheduler.fire()
        scheduler.fire()
        assertEquals(listOf(0, 1), chunks.map { it.seq })
    }

    @Test
    fun `sends a fresh non-final summary after every 5th chunk with increasing seq`() {
        val c = collector()
        repeat(10) { c.recordPlayerEvent(event()); scheduler.fire() }
        assertEquals(10, chunks.size)
        assertEquals(listOf(0, 1, 2), summaries.map { it.seq })
        assertTrue(summaries.none { it.final })
    }

    @Test
    fun `the byte cap flushes before admitting, so nothing already accepted is deleted`() {
        // Codex round-2, Important 8. The old policy evicted the OLDEST
        // pending entries until the framed chunk fit under the cap — but their
        // ring entries and their summary contributions survived, so the server
        // silently lost errors its own summary still counted. Now the buffer
        // is SENT and the entry admitted into the empty one.
        val c = collector(maxBufferBytes = 4096)
        val big = VitalsPlayerEvent(t = now, type = "error", data = buildJsonObject { put("message", JsonPrimitive("x".repeat(900))) })
        repeat(20) { c.recordPlayerEvent(big) }
        c.flushNow()
        assertTrue("the buffer must have been flushed more than once", chunks.size > 1)
        assertEquals("every accepted entry must reach the wire", 20, chunks.sumOf { it.entries.size })
        assertTrue(chunks.all { VitalsWireCodec.utf8Length(VitalsWireCodec.encodeChunk(it)) <= 4096 - 32 })
        assertEquals("...and the summary counts exactly what was sent", 20, summaries.last().errorCount)
    }

    @Test
    fun `an entry too large to fit even alone is dropped from the ring and the summary too`() {
        // The one entry the cap may still drop. It must reach neither the ring
        // (crash evidence) nor the accumulator, or the summary would count an
        // error whose entry no timeline ever received.
        val c = collector(maxBufferBytes = 512)
        c.recordPlayerEvent(event(3))
        val huge = VitalsPlayerEvent(t = now, type = "error", data = buildJsonObject { put("message", JsonPrimitive("x".repeat(900))) })
        c.recordPlayerEvent(huge)
        c.flushNow()
        assertEquals(listOf(3L), c.recent().map { nOf(it) })
        // Names the OVERSIZED entry specifically. This used to assert that no
        // player event at all reached the wire, which only held while the
        // small companion entry was a sample — samples no longer transport, so
        // that entry is a player event now and legitimately does reach it.
        assertTrue(
            "the oversized entry must never reach the wire",
            chunks.flatMap { it.entries }.none { it is VitalsPlayerEvent && it.type == "error" },
        )
        assertEquals("a dropped entry must not be counted", 0, summaries.last().errorCount)
    }

    @Test
    fun `a chunk far from the byte cap never pays for the exact framed encode`() {
        // Final review, I5. chunkCost() used to run — full serialise plus the
        // plainNumberLiterals walk over the WHOLE pending chunk — on every
        // addEntry, on the app looper: O(n^2) per chunk for a check that
        // fires only at the cap. 49 samples is one entry short of the
        // maxEntriesPerChunk flush and nowhere near the 64 KB budget.
        val c = collector()
        repeat(49) { c.recordPlayerEvent(event()) }
        assertEquals(49, c.recent().size)
        assertEquals(0, c.exactCostCalls)
    }

    @Test
    fun `the running estimate still honours the cap once entries approach the budget`() {
        // The estimate is a lower bound short only by the chunk envelope, so
        // the exact check has to engage before the framed size can cross the
        // budget. maxBufferBytes 8192 -> budget 8160, exact path from ~4 KB.
        val c = collector(maxBufferBytes = 8192)
        val big = VitalsPlayerEvent(t = now, type = "error", data = buildJsonObject { put("message", JsonPrimitive("x".repeat(900))) })
        repeat(20) { c.recordPlayerEvent(big) }
        assertTrue("exact cost check never engaged", c.exactCostCalls > 0)
        c.flushNow()
        assertTrue("the buffer must have been flushed more than once", chunks.size > 1)
        assertEquals(20, chunks.sumOf { it.entries.size })
        assertTrue(chunks.all { VitalsWireCodec.utf8Length(VitalsWireCodec.encodeChunk(it)) <= 8192 - 32 })
    }

    @Test
    fun `measures the cap in UTF-8 bytes`() {
        val c = collector(maxBufferBytes = 2048)
        val emoji = VitalsPlayerEvent(t = now, type = "error", data = buildJsonObject { put("message", JsonPrimitive("😀".repeat(100))) })
        repeat(10) { c.recordPlayerEvent(emoji) }
        c.flushNow()
        assertEquals(10, chunks.sumOf { it.entries.size })
        assertTrue(chunks.all { VitalsWireCodec.utf8Length(VitalsWireCodec.encodeChunk(it)) <= 2048 - 32 })
    }

    @Test
    fun `recent returns a ring independent of flushing and prunes to the window`() {
        val c = collector()
        c.recordPlayerEvent(event(1)); scheduler.fire()
        assertEquals(1, c.recent().size)
        now += 61_000
        c.recordPlayerEvent(event(2))
        assertEquals(listOf(2L), c.recent().map { nOf(it) })
        assertEquals(1, c.recent(120_000).size) // ring itself was pruned at record time
    }

    @Test
    fun `idle gap over 30 minutes finalizes at the last entry, rotates, then records the trigger`() {
        val c = collector()
        c.recordPlayerEvent(event())
        val lastT = now
        now += 1_800_001
        sent.clear()
        c.recordPlayerEvent(event())
        val finalSummary = summaries.first { it.final }
        assertEquals("sid-0", finalSummary.sessionId)
        assertEquals(lastT - 1_000_000, finalSummary.durationMs)
        assertEquals("sid-1", c.sessionId)
        val fresh = summaries.first { !it.final && it.sessionId == "sid-1" }
        assertEquals(0, fresh.seq)
        assertEquals(1, c.recent().size)
        assertEquals("sid-0", chunks.single().sessionId)
    }

    @Test
    fun `max-age rotation finalizes with durationMs exactly maxSessionMs`() {
        val c = collector()
        now += 86_400_000
        c.recordPlayerEvent(event())
        assertEquals(86_400_000L, summaries.first { it.final }.durationMs)
        assertEquals("sid-1", c.sessionId)
    }

    @Test
    fun `stop flushes pending, sends a final summary, and later calls are no-ops`() {
        val c = collector()
        c.recordPlayerEvent(event())
        c.stop()
        assertEquals(1, chunks.size); assertTrue(summaries.last().final); assertTrue(scheduler.closed)
        val n = sent.size
        c.stop(); c.recordPlayerEvent(event()); c.flushNow()
        assertEquals(n, sent.size)
    }

    @Test
    fun `flushNow sends pending chunk plus a non-final summary`() {
        val c = collector()
        c.recordPlayerEvent(event()); c.flushNow()
        assertEquals(1, chunks.size); assertEquals(2, summaries.size); assertEquals(false, summaries.last().final)
    }

    @Test
    fun `a throwing send never escapes and later ticks still flush`() {
        var fail = true
        val c = collector(send = { if (fail) error("boom") else sent.add(it) })
        c.recordPlayerEvent(event()); scheduler.fire()
        fail = false
        c.recordPlayerEvent(event()); scheduler.fire()
        // The first tick's throwing send must retain its entry rather than
        // dropping it: the eventually-delivered chunk still carries seq 0
        // (never burned by the failed attempt) and both entries (the
        // retained one plus the new one), not just the second entry alone.
        assertEquals(1, chunks.size)
        assertEquals(0, chunks.single().seq)
        assertEquals(2, chunks.single().entries.size)
        assertTrue(InternalLogger.drainFailures().any { it.label == "VitalsCollector.tick" })
    }

    @Test
    fun `caps the ring at 800 entries during a storm`() {
        val c = collector()
        repeat(1000) { c.recordPlayerEvent(event(it.toLong())) }
        val r = c.recent()
        assertEquals(800, r.size); assertEquals(999L, nOf(r.last()))
    }

    @Test
    fun `bounds an oversized player payload but keeps scalars`() {
        val c = collector()
        c.recordPlayerEvent(VitalsPlayerEvent(t = now, type = "error", data = buildJsonObject { put("message", JsonPrimitive("m".repeat(20_000))); put("fatal", JsonPrimitive(true)) }))
        val e = c.recent().single() as VitalsPlayerEvent
        assertEquals(true, e.truncated)
        assertEquals("true", e.data!!["fatal"]!!.jsonPrimitive.content)
        assertTrue(VitalsWireCodec.utf8Length(e.data.toString()) <= 8192)
    }

    @Test
    fun `custom entries buffer and flush with kind custom`() {
        val c = collector()
        c.recordCustom(VitalsCustomEntry(t = now, name = "n"))
        c.flushNow()
        assertTrue(chunks.single().entries.single() is VitalsCustomEntry)
    }

    @Test
    fun `recent times out instead of blocking forever when another thread holds the lock, and sessionId still reads without blocking`() {
        val holding = CountDownLatch(1)
        val release = CountDownLatch(1)
        var sawInitial = true
        val c = collector(send = {
            // Let the constructor's own initial summary (sent under the lock
            // during init) through untouched; only the SECOND send — the one
            // this test deliberately triggers via flushNow() on a background
            // thread — blocks, so the lock stays held from outside.
            if (sawInitial) {
                sawInitial = false
                sent.add(it)
            } else {
                holding.countDown()
                release.await()
            }
        })
        val holder = Thread { c.flushNow() }
        holder.start()
        assertTrue(holding.await(1, TimeUnit.SECONDS))
        try {
            val start = System.nanoTime()
            val result = c.recent(lockTimeoutMs = 50)
            val elapsedMs = (System.nanoTime() - start) / 1_000_000
            assertTrue(result.isEmpty())
            assertTrue("recent() must give up quickly, took ${elapsedMs}ms", elapsedMs < 1000)
            // sessionId is read without taking the lock — must not block either.
            assertEquals("sid-0", c.sessionId)
        } finally {
            release.countDown()
            holder.join(1000)
        }
    }

    @Test
    fun `onRotate runs with the collector lock released`() {
        // Codex round-1, Critical 4. The callback used to run UNDER the
        // collector's lock, which made `onRotate -> reseed -> describe` (all
        // customer code, free to touch a player's own lock) a genuine
        // deadlock against any thread holding that player lock while emitting
        // into this collector.
        //
        // The probe has to run on ANOTHER thread: the collector's lock is
        // reentrant, so a same-thread `recent()` would succeed either way.
        var probe: List<Any>? = null
        var probeFailed: Throwable? = null
        lateinit var c: VitalsCollector
        c = collector(onRotate = {
            val t = Thread {
                try {
                    probe = c.recent(lockTimeoutMs = 50)
                } catch (e: Throwable) {
                    probeFailed = e
                }
            }
            t.start(); t.join(5_000)
        })
        c.recordPlayerEvent(event())
        now += 1_800_001
        c.recordPlayerEvent(event(7))
        assertNull(probeFailed)
        // Non-empty proves the lock was actually free: `recent()` returns an
        // empty list when it cannot take the lock inside the timeout.
        assertEquals(listOf(7L), probe!!.map { nOf(it) })
    }

    @Test
    fun `onRotate receives the entry that triggered the rotation`() {
        var trigger: Any? = null
        val c = collector(onRotate = { trigger = it })
        c.recordPlayerEvent(event())
        now += 1_800_001
        c.recordCustom(VitalsCustomEntry(t = now, name = "trigger"))
        assertEquals("trigger", (trigger as VitalsCustomEntry).name)
    }

    @Test
    fun `the session rotates before either sequence counter can exceed the protocol maximum`() {
        // Codex round-1, Important 6. `maxSeq` is injectable only so this
        // does not have to send a million chunks; the production value is
        // VitalsLimits.MAX_SEQ.
        val rotations = ArrayList<Any?>()
        val c = collector(maxSeq = 4, maxEntriesPerChunk = 1, onRotate = { rotations.add(it) })
        repeat(6) { c.recordPlayerEvent(event(it.toLong())) }
        assertEquals(1, rotations.size)
        // Every chunk and every summary stayed inside the cap...
        assertTrue(chunks.all { it.seq <= 4 }); assertTrue(summaries.all { it.seq <= 4 })
        // ...and the counters restarted in a NEW session rather than running on.
        assertNotEquals("sid-0", c.sessionId)
        assertEquals(listOf(0, 1, 2), chunks.filter { it.sessionId == "sid-0" }.map { it.seq })
        assertEquals(0, chunks.first { it.sessionId == "sid-1" }.seq)
        assertTrue(summaries.any { it.final && it.sessionId == "sid-0" })
    }

    @Test
    fun `a background flush rotates before the summary sequence can exceed the cap`() {
        // Codex round-2, Important 7. Only addEntry() checked the cap, but the
        // periodic tick, flushNow() and the every-5th-chunk summary all burn
        // seq values with no entry involved — so a session whose only traffic
        // is background flushes walked past the cap and had every subsequent
        // payload rejected by ingest for the rest of its life.
        val rotations = ArrayList<Any?>()
        val c = collector(maxSeq = 3, onRotate = { rotations.add(it) })
        repeat(6) { c.flushNow() }
        assertTrue("no entry was ever added, so only flushNow could rotate", rotations.isNotEmpty())
        assertNull("a rotation no entry caused carries no trigger", rotations.first())
        assertTrue("every summary stayed inside the protocol cap", summaries.all { it.seq <= 3 })
        assertNotEquals("sid-0", c.sessionId)
        assertTrue(summaries.any { it.final && it.sessionId == "sid-0" })
    }

    @Test
    fun `stop clears the recent ring`() {
        // Codex round-1, Important 5: the ring is capture evidence. A crash
        // stamp blocked on the collector's lock for the duration of the final
        // send could otherwise still walk away with pre-kill entries.
        val c = collector()
        c.recordPlayerEvent(event())
        assertEquals(1, c.recent().size)
        c.stop()
        assertEquals(0, c.recent().size)
    }

    @Test
    fun `stop clears the recent ring even when the final send throws`() {
        var calls = 0
        val c = collector(send = { calls++; if (calls > 1) error("transport down") })
        c.recordPlayerEvent(event())
        c.stop()
        assertEquals(0, c.recent().size)
    }

    @Test
    fun `stamp takes the session id and the ring under one lock acquisition`() {
        // Codex round-1, Important 4 — the read that EnvelopeBuilder makes.
        val c = collector()
        c.recordPlayerEvent(event(3))
        val stamp = c.stamp()
        assertEquals("sid-0", stamp.sessionId)
        assertEquals(listOf(3L), stamp.entries.map { nOf(it) })

        // The rotation the pair-read could straddle: after it, the id and the
        // entries both belong to the NEW session.
        now += 1_800_001
        c.recordPlayerEvent(event(9))
        val after = c.stamp()
        assertEquals("sid-1", after.sessionId)
        assertEquals(listOf(9L), after.entries.map { nOf(it) })
    }

    @Test
    fun `stamp gives up on a held lock and still reports the session id`() {
        // Same crash-handler guarantee `recent()` has: a stamp taken while a
        // dying thread holds the lock must not block.
        val holding = CountDownLatch(1)
        val release = CountDownLatch(1)
        var sawInitial = true
        val c = collector(send = {
            if (sawInitial) { sawInitial = false; sent.add(it) } else { holding.countDown(); release.await() }
        })
        val holder = Thread { c.flushNow() }
        holder.start()
        assertTrue(holding.await(1, TimeUnit.SECONDS))
        try {
            val start = System.nanoTime()
            val stamp = c.stamp(lockTimeoutMs = 50)
            val elapsedMs = (System.nanoTime() - start) / 1_000_000
            assertEquals("sid-0", stamp.sessionId)
            assertTrue(stamp.entries.isEmpty())
            assertTrue("stamp() must give up quickly, took ${elapsedMs}ms", elapsedMs < 1000)
        } finally {
            release.countDown()
            holder.join(1000)
        }
    }

    @Test
    fun `onRotate fires once per rotation after the new session exists, and a throwing one is contained`() {
        var seen = ""
        val c = collector(onRotate = { seen = "rotated"; error("x") })
        c.recordPlayerEvent(event()); now += 1_800_001; c.recordPlayerEvent(event())
        assertEquals("rotated", seen)
        assertNotEquals("sid-0", c.sessionId)
        c.recordPlayerEvent(event())
        assertEquals(2, c.recent().size)
    }

    // ---- Codex round-4, #1/#7: recording and its rotation notification are
    // separable, and every record says whether it was ACCEPTED ----

    @Test
    fun `a deferred record hands its rotation back unfired`() {
        // #1: `VitalsController` records `player_attach`/`player_detach`/a
        // handle's custom entry while holding that registration's
        // `announceLock`, and the rotation callback reseeds every live player
        // through customer `describe()` code. Firing it from inside the record
        // ran that customer code under the lock; the caller has to be able to
        // take the record now and fire the notification later.
        var rotations = 0
        val c = collector(onRotate = { rotations++ })
        c.recordPlayerEvent(event())
        now += 1_800_001
        val rec = c.recordPlayerEventDeferred(VitalsPlayerEvent(t = now, type = "play", playerId = "p1"))
        assertTrue("the entry itself is recorded immediately", rec.accepted)
        assertNotEquals("...and the new session already exists", "sid-0", c.sessionId)
        assertEquals("the rotation must NOT have fired yet", 0, rotations)
        rec.fireRotate()
        assertEquals(1, rotations)
    }

    @Test
    fun `a deferred record with no rotation is a no-op to fire`() {
        var rotations = 0
        val c = collector(onRotate = { rotations++ })
        val rec = c.recordCustomDeferred(VitalsCustomEntry(t = now, name = "x"))
        assertTrue(rec.accepted)
        rec.fireRotate()
        assertEquals(0, rotations)
    }

    @Test
    fun `a stopped collector accepts nothing`() {
        // #7: the caller needs the difference. `VitalsController.collectStats`
        // answers the integration with this value, and media3 only advances
        // its dropped-frame watermark on a true.
        val c = collector()
        c.stop()
        assertFalse(c.recordPlayerEvent(VitalsPlayerEvent(t = now, type = "play", playerId = "p1")))
        assertFalse(c.recordCustom(VitalsCustomEntry(t = now, name = "x")))
        assertFalse(c.recordPlayerEventDeferred(VitalsPlayerEvent(t = now, type = "play", playerId = "p1")).accepted)
    }

    // ---- Codex round-5 ----

    @Test
    fun `an entry expecting a session the collector has left is refused outright`() {
        // Codex round-5, #6. `VitalsController` used to compare a pinned
        // session id against `sessionId` and only then record: between the
        // two, any other entry could rotate this collector, and the entry
        // landed in a session that never announced its player. The comparison
        // and the admission are one critical section now — a mismatch is not
        // admitted, does not reach the ring, and triggers no rotation.
        var rotations = 0
        val c = collector(onRotate = { rotations++ })
        // The idle gap is measured from the last entry, so seed one.
        c.recordCustom(VitalsCustomEntry(t = now, name = "seed"))
        val stale = c.sessionId
        now += 1_800_001
        assertTrue("precondition: this entry rotates the session", c.recordCustom(VitalsCustomEntry(t = now, name = "rotate")))
        assertNotEquals(stale, c.sessionId)
        assertEquals(1, rotations)

        val rec = c.recordPlayerEventDeferred(VitalsPlayerEvent(t = now, type = "pause", playerId = "p1"), stale)
        rec.fireRotate()

        assertFalse("an entry pinned to a session the collector has left must be refused", rec.accepted)
        assertNull(rec.sessionId)
        assertEquals("...and must not rotate anything", 1, rotations)
        assertTrue(c.recent().filterIsInstance<VitalsPlayerEvent>().none { it.type == "pause" })

        // The current session still admits it, and reports where it landed.
        val ok = c.recordPlayerEventDeferred(VitalsPlayerEvent(t = now, type = "pause", playerId = "p1"), c.sessionId)
        assertTrue(ok.accepted)
        assertEquals(c.sessionId, ok.sessionId)
    }

    @Test
    fun `an UNPINNED entry that triggers a rotation reports the session it landed in`() {
        // The trigger semantics the pin depends on: an unpinned entry rotates
        // and lands in the NEW session, and `Recorded.sessionId` names where
        // it landed — so the announcement `VitalsController` pins from a
        // `player_attach` points at the session that attach is actually in,
        // not at the one the record started from.
        //
        // Codex round-6, #3: this is stated with NO `expectedSessionId`,
        // because `player_attach` is recorded unpinned and a PINNED entry can
        // no longer trigger a rotation at all (see the test below). Round 5
        // wrote it with a pin, which documented the rule round 6 reversed.
        val c = collector()
        c.recordCustom(VitalsCustomEntry(t = now, name = "seed"))
        val before = c.sessionId
        now += 1_800_001
        val rec = c.recordPlayerEventDeferred(VitalsPlayerEvent(t = now, type = "player_attach", playerId = "p1"))
        assertTrue(rec.accepted)
        assertNotEquals("precondition: the entry really rotated the session", before, c.sessionId)
        assertEquals("the pin must name the session the attach landed in", c.sessionId, rec.sessionId)
    }

    // ---- Codex round-6 ----

    @Test
    fun `a pinned entry that would rotate the session is refused, not carried across`() {
        // Codex round-6, #3, reversing round 5's ruling. `expectedSessionId`
        // means "this session or nowhere". Round 5 let the entry that
        // TRIGGERS the rotation pass the check against the old session and
        // land in the new one, which defeated the pin at exactly the moment
        // it exists for: a `player_detach` for a player idle past maxIdleMs
        // rotated the collector and landed in a brand-new session that had
        // never announced that player — and the reseed excludes an
        // unregistered player, so nothing ever would.
        var rotations = 0
        val c = collector(onRotate = { rotations++ })
        // The idle gap is measured from the last entry, so seed one.
        c.recordCustom(VitalsCustomEntry(t = now, name = "seed"))
        val pinned = c.sessionId
        now += 1_800_001

        val rec = c.recordPlayerEventDeferred(VitalsPlayerEvent(t = now, type = "player_detach", playerId = "p1"), pinned)
        rec.fireRotate()

        assertFalse("a pinned entry must never cross a rotation", rec.accepted)
        assertNull(rec.sessionId)
        assertEquals("...and must rotate nothing", 0, rotations)
        assertEquals("...the collector must still be in the pinned session", pinned, c.sessionId)
        assertTrue(
            "the refused marker must appear in no session at all",
            c.recent().filterIsInstance<VitalsPlayerEvent>().none { it.type == "player_detach" },
        )
        // Nothing was finalized either: the only payloads so far are the
        // initial summary and whatever the seed produced.
        assertTrue("no session may have been finalized", summaries.none { it.final })
    }

    @Test
    fun `an unpinned entry still rotates and lands in the new session`() {
        // The other half of round-6 #3: unpinned trigger semantics are
        // unchanged, so a rotation still happens on the very next entry that
        // carries no pin — which is what re-opens the refused player's spans
        // through the reseed.
        var rotations = 0
        val c = collector(onRotate = { rotations++ })
        c.recordCustom(VitalsCustomEntry(t = now, name = "seed"))
        val before = c.sessionId
        now += 1_800_001

        assertTrue(c.recordCustom(VitalsCustomEntry(t = now, name = "rotate")))

        assertEquals(1, rotations)
        assertNotEquals("an unpinned entry still rotates", before, c.sessionId)
        assertTrue(
            "...and lands in the new session",
            c.recent().filterIsInstance<VitalsCustomEntry>().any { it.name == "rotate" },
        )
    }

    @Test
    fun `a pinned entry that would rotate on max age or the seq cap is refused too`() {
        // The idle gap is not the only rotation predicate `admit` has to ask
        // about: max-age and the seq cap rotate the same way, and a pin must
        // survive all three identically.
        val byAge = collector()
        val agePin = byAge.sessionId
        now += 86_400_000
        assertFalse(
            "a pinned entry must not cross a max-age rotation",
            byAge.recordPlayerEventDeferred(VitalsPlayerEvent(t = now, type = "pause", playerId = "p1"), agePin).accepted,
        )
        assertEquals(agePin, byAge.sessionId)

        // maxSeq = 2 means `seq >= 1` already reads as exhausted, so the very
        // first entry after one chunk has gone out would rotate.
        val bySeq = collector(maxSeq = 2, maxEntriesPerChunk = 1)
        bySeq.recordCustom(VitalsCustomEntry(t = now, name = "burn"))
        val seqPin = bySeq.sessionId
        assertFalse(
            "a pinned entry must not cross a seq-cap rotation",
            bySeq.recordPlayerEventDeferred(VitalsPlayerEvent(t = now, type = "pause", playerId = "p1"), seqPin).accepted,
        )
        assertEquals(seqPin, bySeq.sessionId)
    }

    @Test
    fun `an entry the transport refuses for size is not accepted`() {
        // The other refusal path: an entry that does not fit even alone
        // reaches neither the ring nor the accumulator, so a delta reported
        // inside it was never recorded either.
        val c = collector(maxBufferBytes = 300)
        val big = VitalsPlayerEvent(
            t = now, type = "stats", playerId = "p1",
            data = buildJsonObject { put("blob", "x".repeat(4096)) },
        )
        assertFalse(c.recordPlayerEvent(big))
        assertTrue("...and a small one still is", c.recordCustom(VitalsCustomEntry(t = now, name = "ok")))
    }

    // -----------------------------------------------------------------------
    // CPU/memory samples feed the summary but are never transported.
    //
    // Resource consumption is covered by the report resource window: a
    // 2-second-resolution ring attached to the report or crash that explains
    // it, which is both finer than this 30-second stream and actually aligned
    // to the failure. The API discards `sample` entries on arrival, so
    // shipping them only spends the device's battery and the customer's
    // bandwidth. `recordSample` still runs the FULL addEntry path — rotation,
    // lastEntryAt, the accumulator — so session lifetimes and memPeak/memAvg
    // are unchanged.
    // -----------------------------------------------------------------------

    @Test
    fun `samples never reach a chunk`() {
        val c = collector()
        repeat(60) { c.recordSample(sample(it.toLong())) }
        c.flushNow()
        assertTrue("no chunk should have been sent at all", chunks.isEmpty())
    }

    @Test
    fun `samples still feed memPeak and memAvg on the summary`() {
        val c = collector()
        c.recordSample(sample(1000))
        c.recordSample(sample(3000))
        c.stop()
        val s = summaries.last()
        assertEquals(3000L, s.memPeak)
        assertEquals(2000L, s.memAvg)
    }

    @Test
    fun `samples stay out of the recent ring so they never ride into a report`() {
        val c = collector()
        c.recordSample(sample(1000))
        c.recordPlayerEvent(event(7))
        assertEquals(listOf(7L), c.recent().map { nOf(it) })
    }

    @Test
    fun `player events still transport alongside dropped samples`() {
        val c = collector()
        c.recordSample(sample(1000))
        c.recordPlayerEvent(event(1))
        c.recordSample(sample(2000))
        c.recordPlayerEvent(event(2))
        c.flushNow()
        assertEquals(listOf(1L, 2L), chunks.flatMap { it.entries }.map { nOf(it) })
    }

    @Test
    fun `keeps sending periodic summaries for a session with no playback activity`() {
        // The periodic summary used to ride on sendChunk's counter, and
        // sendChunk returns early on an empty buffer. Once samples stopped
        // being transported, a sampling-only session sent NO periodic
        // summaries: memPeak/memAvg reached the server only on a clean stop,
        // and lastSeenAt stopped advancing while the session was still live.
        val c = collector()
        c.recordSample(sample(1000))
        c.recordSample(sample(3000))
        repeat(5) { scheduler.fire() }
        assertEquals(2, summaries.size) // initial + one periodic
        assertEquals(false, summaries.last().final)
        assertEquals(3000L, summaries.last().memPeak)
        assertTrue("no chunk should have been sent", chunks.isEmpty())
    }

    @Test
    fun `stays silent when nothing at all has been recorded`() {
        collector()
        repeat(20) { scheduler.fire() }
        assertEquals(1, summaries.size) // just the initial announcement
    }

    @Test
    fun `an entry admitted after a mid-addEntry flush still marks the summary dirty`() {
        // FLUSH BEFORE ADMIT: an entry that does not fit the current buffer
        // makes addEntry send the buffer as its own chunk, and that send
        // advances the summary cadence — potentially emitting a summary —
        // BEFORE the triggering entry has reached the accumulator. Marking
        // the session dirty early meant that summary cleared the flag, so the
        // entry's own contribution (an error, say) had nothing left to push
        // it out periodically.
        val c = collector(maxBufferBytes = 4096, summaryEveryChunks = 1)
        val big = VitalsPlayerEvent(
            t = now, type = "error", playerId = "p1",
            data = buildJsonObject { put("message", JsonPrimitive("x".repeat(1500))) },
        )
        c.recordPlayerEvent(big)
        c.recordPlayerEvent(big)
        val before = summaries.size
        c.recordPlayerEvent(big) // does not fit -> flush, summary, then admit

        // The admitted entry is still buffered. Flushing it must advance the
        // cadence too, which it cannot if the flag was cleared beneath it.
        scheduler.fire()
        assertTrue(
            "the admitted entry's chunk must still drive a summary",
            summaries.size >= before + 2,
        )
    }
}
