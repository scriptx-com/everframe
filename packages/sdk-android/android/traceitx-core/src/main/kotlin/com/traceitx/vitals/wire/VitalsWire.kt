// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Hand-written twins of packages/protocol/src/vitals.ts (spec 2026-09-05 §1).
// Codegen only covers the report envelope, so these are maintained by hand and
// pinned by VitalsFixtureParityTest + vitals-android-fixture.spec.ts.
package com.traceitx.vitals.wire

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

object PlayerEventTypes {
    const val PLAY = "play"
    const val PAUSE = "pause"
    const val SEEK = "seek"
    const val BUFFER_START = "buffer_start"
    const val BUFFER_END = "buffer_end"
    const val BITRATE_CHANGE = "bitrate_change"
    const val RATE_CHANGE = "rate_change"
    const val ERROR = "error"
    const val STARTUP = "startup"
    /**
     * Codex round-3, Important 4. Superseded by `stats` for the SDKs in this
     * repo (spec 2026-09-02 §1 — `stats.droppedFrames` carries the delta), but
     * it is still a valid member of the protocol enum
     * (`packages/protocol/src/vitals.ts`) precisely so stored sessions and
     * third-party integrations keep parsing. Omitting it from [ALL] made the
     * emit allowlist STRICTER than the wire contract: a custom integration
     * emitting the protocol-valid `dropped_frames` had it silently discarded
     * and logged as a typo.
     */
    const val DROPPED_FRAMES = "dropped_frames"
    const val SOURCE_CHANGE = "source_change"
    const val PLAYER_ATTACH = "player_attach"
    const val PLAYER_DETACH = "player_detach"
    const val DRM = "drm"
    const val QUALITY_CHANGE = "quality_change"
    const val STATS = "stats"

    /**
     * Codex round-2, Important 9 — the allowlist `VitalsController`'s emit
     * path validates against. A customer `PlayerIntegration` hands the SDK a
     * free `String`; one `ctx.emit("buffering")` used to reach the wire as a
     * `type` outside the protocol enum, and ingest validation rejects the
     * WHOLE containing chunk — so a single typo in a third-party integration
     * silently deleted every other player's entries in that chunk too.
     */
    val ALL: Set<String> = setOf(
        PLAY, PAUSE, SEEK, BUFFER_START, BUFFER_END, BITRATE_CHANGE, RATE_CHANGE,
        ERROR, STARTUP, DROPPED_FRAMES, SOURCE_CHANGE, PLAYER_ATTACH, PLAYER_DETACH,
        DRM, QUALITY_CHANGE, STATS,
    )
}

object VitalsLimits {
    const val MAX_ENVELOPE_VITALS_ENTRIES = 400
    const val MAX_CUSTOM_DATA_BYTES = 2048
    const val MAX_PLAYER_EVENT_DATA_BYTES = 8192
    const val MAX_CUSTOM_NAME_LENGTH = 64
    const val MAX_PLAYER_ID_LENGTH = 32
    const val MAX_PLAYER_LIBRARY_LENGTH = 32
    const val MAX_CHUNK_ENTRIES = 200
    const val MAX_SEQ = 1_000_000
    const val INT32_MAX = 2_147_483_647L
}

@Serializable
sealed class VitalsEntry {
    abstract val t: Long
}

@Serializable
@SerialName("sample")
data class VitalsSample(
    override val t: Long,
    val cpu: Double? = null,
    val mem: Long,
    val extras: Map<String, Double>? = null,
) : VitalsEntry()

@Serializable
@SerialName("player")
data class VitalsPlayerEvent(
    override val t: Long,
    val type: String,
    val playerId: String? = null,
    val data: JsonObject? = null,
    val truncated: Boolean? = null,
) : VitalsEntry()

@Serializable
@SerialName("custom")
data class VitalsCustomEntry(
    override val t: Long,
    val name: String,
    val data: JsonElement? = null,
    val truncated: Boolean? = null,
    val playerId: String? = null,
) : VitalsEntry()

@Serializable
sealed class VitalsIngestPayload

@Serializable
@SerialName("chunk")
data class VitalsChunk(
    val sessionId: String,
    val seq: Int,
    val entries: List<VitalsEntry>,
) : VitalsIngestPayload()

@Serializable
data class SessionSummaryDims(
    val platform: String,
    val appVersion: String,
    val sdkVersion: String,
    val deviceModel: String? = null,
    val osVersion: String? = null,
)

/** Every field is always present on the wire; the two nullable ones encode as explicit null. */
@Serializable
@SerialName("summary")
data class SessionSummary(
    val sessionId: String,
    val final: Boolean,
    val seq: Int,
    val startedAt: Long,
    val durationMs: Long,
    val playtimeMs: Long,
    val startupTimeMs: Long?,
    val rebufferCount: Int,
    val rebufferDurationMs: Long,
    val bitrateMean: Long?,
    val errorCount: Int,
    val memPeak: Long,
    val memAvg: Long,
    val playerCount: Int,
    val playerCountSaturated: Boolean,
    val dims: SessionSummaryDims,
) : VitalsIngestPayload()
