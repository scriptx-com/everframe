// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.vitals

import dev.everframe.vitals.wire.SessionSummaryDims
import dev.everframe.vitals.wire.VitalsCustomEntry
import dev.everframe.vitals.wire.VitalsPlayerEvent
import dev.everframe.vitals.wire.VitalsSample
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SummaryAccumulatorTest {
    private val dims = SessionSummaryDims("android", "1", "0.8.0")
    private fun acc() = SummaryAccumulator("sid", 1000, dims)
    private fun ev(t: Long, type: String, playerId: String? = "p1", vararg data: Pair<String, Number>) =
        VitalsPlayerEvent(t = t, type = type, playerId = playerId, data = if (data.isEmpty()) null else buildJsonObject { data.forEach { (k, v) -> put(k, JsonPrimitive(v)) } })

    @Test
    fun `counts rebuffers from buffer_start buffer_end pairs`() {
        val a = acc()
        a.onEntry(ev(2000, "buffer_start")); a.onEntry(ev(2500, "buffer_end"))
        a.onEntry(ev(4000, "buffer_start")); a.onEntry(ev(4100, "buffer_end"))
        val s = a.snapshot(false, 5000, 0)
        assertEquals(2, s.rebufferCount); assertEquals(600L, s.rebufferDurationMs)
    }

    @Test
    fun `takes the FIRST startup ttff and averages bitrates`() {
        val a = acc()
        a.onEntry(ev(1, "startup", data = arrayOf("ttffMs" to 800)))
        a.onEntry(ev(2, "startup", data = arrayOf("ttffMs" to 9999)))
        a.onEntry(ev(3, "bitrate_change", data = arrayOf("bitrate" to 1000)))
        a.onEntry(ev(4, "bitrate_change", data = arrayOf("bitrate" to 3000)))
        val s = a.snapshot(false, 10, 0)
        assertEquals(800L, s.startupTimeMs); assertEquals(2000L, s.bitrateMean)
    }

    @Test
    fun `accumulates playtime across spans and closes an open span at snapshot`() {
        val a = acc()
        a.onEntry(ev(1000, "play")); a.onEntry(ev(3000, "pause")); a.onEntry(ev(5000, "play"))
        assertEquals(4000L, a.snapshot(false, 7000, 0).playtimeMs)
    }

    @Test
    fun `tracks mem peak and avg from samples, errors from error events`() {
        val a = acc()
        a.onEntry(VitalsSample(t = 1, mem = 100)); a.onEntry(VitalsSample(t = 2, mem = 300))
        a.onEntry(ev(3, "error")); a.onEntry(ev(4, "error"))
        val s = a.snapshot(false, 5, 0)
        assertEquals(300L, s.memPeak); assertEquals(200L, s.memAvg); assertEquals(2, s.errorCount)
    }

    @Test
    fun `clamps durations to zero on a backwards clock`() {
        val a = acc()
        a.onEntry(ev(5000, "play")); a.onEntry(ev(4000, "pause"))
        a.onEntry(ev(5000, "buffer_start")); a.onEntry(ev(4000, "buffer_end"))
        val s = a.snapshot(false, 500, 0)
        assertEquals(0L, s.playtimeMs); assertEquals(0L, s.rebufferDurationMs); assertEquals(0L, s.durationMs)
    }

    @Test
    fun `null startup and bitrate when never observed`() {
        val s = acc().snapshot(true, 2000, 3)
        assertNull(s.startupTimeMs); assertNull(s.bitrateMean); assertTrue(s.final); assertEquals(3, s.seq); assertEquals(1000L, s.durationMs)
    }

    @Test
    fun `two players - playtime is the union, not the sum`() {
        val a = acc()
        a.onEntry(ev(1000, "play", "p1")); a.onEntry(ev(2000, "play", "p2"))
        a.onEntry(ev(3000, "pause", "p1")); a.onEntry(ev(5000, "pause", "p2"))
        assertEquals(4000L, a.snapshot(false, 6000, 0).playtimeMs)
    }

    @Test
    fun `overlapping buffer spans from two players collapse into one rebuffer`() {
        val a = acc()
        a.onEntry(ev(1000, "buffer_start", "p1")); a.onEntry(ev(1500, "buffer_start", "p2"))
        a.onEntry(ev(2000, "buffer_end", "p1", "durationMs" to 1000)); a.onEntry(ev(3000, "buffer_end", "p2", "durationMs" to 1500))
        val s = a.snapshot(false, 4000, 0)
        assertEquals(1, s.rebufferCount); assertEquals(2000L, s.rebufferDurationMs)
    }

    @Test
    fun `stray pause or buffer_end never goes negative`() {
        val a = acc()
        a.onEntry(ev(1000, "pause")); a.onEntry(ev(1000, "buffer_end"))
        a.onEntry(ev(2000, "play")); a.onEntry(ev(3000, "pause"))
        assertEquals(1000L, a.snapshot(false, 5000, 0).playtimeMs)
    }

    // ---- Codex round-7, #1: per-player idempotent spans ----

    @Test
    fun `a duplicate play from one player still closes on that player's single pause`() {
        // The whole point of round-7 #1. With union COUNTERS, `play, play,
        // pause` left the count at one, so the span never closed and the
        // snapshot charged playback all the way to `now`. The span belongs to
        // the PLAYER, so the second open is a no-op and the pause closes it.
        val a = acc()
        a.onEntry(ev(1000, "play", "p1")); a.onEntry(ev(1500, "play", "p1")); a.onEntry(ev(3000, "pause", "p1"))
        assertEquals(2000L, a.snapshot(false, 9000, 0).playtimeMs)
    }

    @Test
    fun `a duplicate buffer_start from one player closes on its single buffer_end and counts one rebuffer`() {
        val a = acc()
        a.onEntry(ev(1000, "buffer_start", "p1")); a.onEntry(ev(1500, "buffer_start", "p1"))
        a.onEntry(ev(3000, "buffer_end", "p1"))
        val s = a.snapshot(false, 9000, 0)
        assertEquals(2000L, s.rebufferDurationMs); assertEquals(1, s.rebufferCount)
    }

    @Test
    fun `a duplicate open from one player never disturbs another player's span`() {
        // p1 opens at 1000 and repeats itself at 1500; p2 joins at 2000 and
        // leaves at 4000. The union span is p1's open to p2's close.
        val a = acc()
        a.onEntry(ev(1000, "play", "p1")); a.onEntry(ev(1500, "play", "p1"))
        a.onEntry(ev(2000, "play", "p2"))
        a.onEntry(ev(3000, "pause", "p1")); a.onEntry(ev(4000, "pause", "p2"))
        assertEquals(3000L, a.snapshot(false, 9000, 0).playtimeMs)
    }

    @Test
    fun `a pause or buffer_end from a player that never opened is a no-op for the open span`() {
        // p2 never played, and its stray `pause` must not close p1's span —
        // the counter version decremented on any close from anyone.
        val a = acc()
        a.onEntry(ev(1000, "play", "p1")); a.onEntry(ev(1500, "pause", "p2"))
        a.onEntry(ev(1000, "buffer_start", "p1")); a.onEntry(ev(1500, "buffer_end", "p2"))
        val s = a.snapshot(false, 3000, 0)
        assertEquals("p1's play span is still open at snapshot time", 2000L, s.playtimeMs)
        assertEquals("...and so is its rebuffer span", 2000L, s.rebufferDurationMs)
    }

    @Test
    fun `playerCount counts distinct ids across any player event, unnamed once, custom never`() {
        val a = acc()
        a.onEntry(ev(1, "play", "p1")); a.onEntry(ev(2, "stats", "p2")); a.onEntry(ev(3, "pause", null)); a.onEntry(ev(4, "play", null))
        a.onEntry(VitalsCustomEntry(t = 5, name = "x", playerId = "p9"))
        val s = a.snapshot(false, 6, 0)
        assertEquals(3, s.playerCount); assertFalse(s.playerCountSaturated)
    }

    @Test
    fun `playerCount saturates at 1000 and flags it`() {
        val a = acc()
        repeat(1000) { a.onEntry(ev(1, "play", "p$it")) }
        assertFalse(a.snapshot(false, 2, 0).playerCountSaturated)
        a.onEntry(ev(1, "play", "p1000"))
        val s = a.snapshot(false, 2, 0)
        assertEquals(1000, s.playerCount); assertTrue(s.playerCountSaturated)
    }

    @Test
    fun `ignores string-typed ttffMs and bitrate, then takes the first numeric startup`() {
        val a = acc()
        a.onEntry(VitalsPlayerEvent(t = 1, type = "startup", playerId = "p1", data = buildJsonObject { put("ttffMs", JsonPrimitive("1300")) }))
        a.onEntry(VitalsPlayerEvent(t = 2, type = "bitrate_change", playerId = "p1", data = buildJsonObject { put("bitrate", JsonPrimitive("2000")) }))
        val s1 = a.snapshot(false, 10, 0)
        assertNull(s1.startupTimeMs); assertNull(s1.bitrateMean)
        a.onEntry(ev(3, "startup", data = arrayOf("ttffMs" to 800)))
        val s2 = a.snapshot(false, 10, 0)
        assertEquals(800L, s2.startupTimeMs)
    }

    @Test
    fun `clamps durationMs, playtimeMs, rebufferDurationMs and startupTimeMs to Int32 max`() {
        val i32 = 2_147_483_647L

        val durationAcc = SummaryAccumulator("sid", 0, dims)
        assertEquals(i32, durationAcc.snapshot(false, 3_000_000_000L, 0).durationMs)

        val playAcc = acc()
        playAcc.onEntry(ev(0, "play"))
        assertEquals(i32, playAcc.snapshot(false, 3_000_000_000L, 0).playtimeMs)

        val bufferAcc = acc()
        bufferAcc.onEntry(ev(0, "buffer_start"))
        assertEquals(i32, bufferAcc.snapshot(false, 3_000_000_000L, 0).rebufferDurationMs)

        val startupAcc = acc()
        startupAcc.onEntry(ev(0, "startup", data = arrayOf("ttffMs" to 3.0e9)))
        assertEquals(i32, startupAcc.snapshot(false, 10, 0).startupTimeMs)
    }
}
