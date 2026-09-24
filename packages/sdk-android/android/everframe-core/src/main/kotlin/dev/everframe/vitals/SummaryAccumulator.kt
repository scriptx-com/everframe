// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Port of packages/sdk-core/src/vitals/summary.ts — see that file's comments
// for the union-span reasoning (Codex round-3 F2) and the player cap.
//
// Codex round-7, #1 — the union spans are PER-PLAYER IDEMPOTENT. `playCount`
// and `bufferCount` used to be plain counters across every player, so a
// duplicate `play` from ONE player was a real corruption: the count went to
// two, that player's single later `pause` brought it back to one, and the
// union span ran to the end of the session. Every open/close pair in the
// timeline is genuinely per player, so the accumulator now tracks WHICH
// players are inside the span. Union semantics are identical for well-formed
// pairs — the span opens on the first player to enter and closes when the
// last one leaves — and the only behavioural change is that a duplicate open,
// or a close with no matching open, from the same player is a no-op.
//
// That is what retired an entire family of latches in the SDK: media3's seed
// ownership flags, and the controller's `suppressedFor` for the entry that
// triggered a rotation. Both existed solely to stop a duplicate open reaching
// this class; none of them could cover every interleaving, and each round of
// review found another. Idempotence here covers all of them at once.
package dev.everframe.vitals

import dev.everframe.vitals.wire.PlayerEventTypes
import dev.everframe.vitals.wire.SessionSummary
import dev.everframe.vitals.wire.SessionSummaryDims
import dev.everframe.vitals.wire.VitalsCustomEntry
import dev.everframe.vitals.wire.VitalsEntry
import dev.everframe.vitals.wire.VitalsLimits
import dev.everframe.vitals.wire.VitalsPlayerEvent
import dev.everframe.vitals.wire.VitalsSample
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

class SummaryAccumulator(
    private val sessionId: String,
    private val startedAt: Long,
    private val dims: SessionSummaryDims,
) {
    /**
     * Codex round-7, #1 — the players currently inside the union rebuffer
     * span, not a count of opens. Bounded by the number of players with an
     * OPEN span at one instant, which is the live player set; a player is
     * removed the moment its `buffer_end` arrives, and every integration
     * closes its spans on detach ([PlayerIntegration.detach]'s contract).
     */
    private val buffering = HashSet<String>()
    private var bufferSpanStartT: Long? = null
    private var rebufferCount = 0
    private var rebufferDurationMs = 0L
    private var startupTimeMs: Long? = null
    private var bitrateSum = 0.0
    private var bitrateN = 0
    private var errorCount = 0
    /** Codex round-7, #1 — the players currently playing. See [buffering]. */
    private val playing = HashSet<String>()
    private var playSpanStartT: Long? = null
    private var playtimeMs = 0L
    private var memPeak = 0L
    private var memSum = 0L
    private var memN = 0
    private val players = HashSet<String>()
    private var playerCountSaturated = false

    private fun num(e: VitalsPlayerEvent, key: String): Double? =
        (e.data?.get(key) as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull

    fun onEntry(entry: VitalsEntry) {
        when (entry) {
            is VitalsSample -> {
                if (entry.mem > memPeak) memPeak = entry.mem
                memSum += entry.mem
                memN++
            }
            is VitalsPlayerEvent -> {
                val id = entry.playerId ?: ""
                if (id !in players) {
                    if (players.size < MAX_TRACKED_PLAYERS) players.add(id) else playerCountSaturated = true
                }
                val t = entry.t
                when (entry.type) {
                    // Round-7, #1: `add`/`remove` ANSWER whether this player
                    // changed the set, so a repeated open (or a close with no
                    // open) never moves the span. `rebufferCount` still counts
                    // union spans — incremented when the span OPENS, exactly
                    // as the counter version did.
                    PlayerEventTypes.BUFFER_START -> if (buffering.add(id) && buffering.size == 1) {
                        bufferSpanStartT = t; rebufferCount++
                    }
                    PlayerEventTypes.BUFFER_END -> if (buffering.remove(id) && buffering.isEmpty()) {
                        val start = bufferSpanStartT
                        if (start != null) { rebufferDurationMs += maxOf(0L, t - start); bufferSpanStartT = null }
                    }
                    PlayerEventTypes.STARTUP -> if (startupTimeMs == null) num(entry, "ttffMs")?.let { startupTimeMs = Math.round(it) }
                    PlayerEventTypes.BITRATE_CHANGE -> num(entry, "bitrate")?.let { bitrateSum += it; bitrateN++ }
                    PlayerEventTypes.ERROR -> errorCount++
                    PlayerEventTypes.PLAY -> if (playing.add(id) && playing.size == 1) playSpanStartT = t
                    PlayerEventTypes.PAUSE -> if (playing.remove(id) && playing.isEmpty()) {
                        val start = playSpanStartT
                        if (start != null) { playtimeMs += maxOf(0L, t - start); playSpanStartT = null }
                    }
                }
            }
            is VitalsCustomEntry -> Unit
        }
    }

    fun snapshot(final: Boolean, now: Long, seq: Int): SessionSummary {
        var playtime = playtimeMs
        playSpanStartT?.let { if (playing.isNotEmpty()) playtime += maxOf(0L, now - it) }
        var rebuffer = rebufferDurationMs
        bufferSpanStartT?.let { if (buffering.isNotEmpty()) rebuffer += maxOf(0L, now - it) }
        val i32 = VitalsLimits.INT32_MAX
        return SessionSummary(
            sessionId = sessionId,
            final = final,
            seq = seq,
            startedAt = startedAt,
            durationMs = maxOf(0L, now - startedAt).coerceAtMost(i32),
            playtimeMs = playtime.coerceAtMost(i32),
            startupTimeMs = startupTimeMs?.coerceIn(0L, i32),
            rebufferCount = rebufferCount,
            rebufferDurationMs = rebuffer.coerceAtMost(i32),
            bitrateMean = if (bitrateN > 0) Math.round(bitrateSum / bitrateN) else null,
            errorCount = errorCount,
            memPeak = memPeak,
            memAvg = if (memN > 0) Math.round(memSum.toDouble() / memN) else 0L,
            playerCount = players.size,
            playerCountSaturated = playerCountSaturated,
            dims = dims,
        )
    }

    companion object {
        const val MAX_TRACKED_PLAYERS = 1000
    }
}
