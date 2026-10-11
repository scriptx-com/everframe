// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import dev.everframe.capture.video.ErrorReplaySnapshot
import dev.everframe.capture.video.ErrorReplayWork
import dev.everframe.capture.video.VideoAttachmentPair
import dev.everframe.capture.video.sha256
import dev.everframe.envelope.EnvelopeBuilder
import dev.everframe.outbox.CrashSidecar
import dev.everframe.outbox.OutboxAuthorization
import dev.everframe.outbox.OutboxEntry
import dev.everframe.outbox.OutboxToken
import dev.everframe.protocol.generated.ReportEnvelope
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap

/**
 * Error replays (spec 2026-10-11): stored errors that wait for their replay. Drains skip them. In
 * memory only. A hold lapses after [HOLD_NANOS] (5 s on both platforms; the export deadline is 3 s),
 * so a lost release can only delay a report. A lapsed hold is final: once a drain may be sending the
 * stored error, the upgrade's replacement is refused (see [ErrorReplayUpgrade]).
 */
internal object ErrorReplayHolds {
    const val HOLD_NANOS = 5_000_000_000L
    /** Monotonic clock; tests substitute a fixed one. */
    @Volatile internal var clock: () -> Long = System::nanoTime
    private val held = ConcurrentHashMap<String, Long>()
    fun hold(reportId: String, now: Long = clock()) { held[reportId] = now + HOLD_NANOS }
    fun release(reportId: String) { held.remove(reportId) }
    fun isHeld(reportId: String, now: Long = clock()): Boolean {
        val until = held[reportId] ?: return false
        if (now - until < 0) return true
        held.remove(reportId, until)
        return false
    }
}

/** Swaps a stored, held error for the same report with its replay, or leaves it flagged as omitted. */
internal object ErrorReplayUpgrade {
    fun schedule(snapshot: ErrorReplaySnapshot, sidecar: CrashSidecar, token: OutboxToken, original: OutboxEntry,
                 envelope: ReportEnvelope, authorization: OutboxAuthorization) {
        ErrorReplayWork.scope.launch {
            var attached = false
            try {
                val pair = snapshot.await()
                if (pair != null && pair.part.data.size <= 8_000_000 && ErrorReplayHolds.isHeld(original.reportId)) {
                    // Rechecked inside the store lock at every commit step: the hold must still be live.
                    // A drain only uploads after its own hold check AND OutboxDrainAuthorization.tryStart,
                    // which runs under the same store lock with the original token present. So either
                    // this swap commits first (the drain then finds the token gone and sends nothing),
                    // or the hold has lapsed and this swap is refused: it never replaces an envelope
                    // that a drain may already be sending.
                    val replayAuthorization = object : OutboxAuthorization {
                        override fun isAllowed() = authorization.isAllowed() && snapshot.replayAllowed() &&
                            ErrorReplayHolds.isHeld(original.reportId)
                    }
                    attached = sidecar.replaceSync(token, withReplay(original, envelope, pair), replayAuthorization)
                }
            } finally {
                snapshot.settle(attached)
                ErrorReplayHolds.release(original.reportId)
                runCatching { dev.everframe.Everframe.requestOutboxDrain() }
            }
        }
    }

    /** The same report with one session-replay attachment; only the omission flag comes off. */
    internal fun withReplay(original: OutboxEntry, envelope: ReportEnvelope, pair: VideoAttachmentPair): OutboxEntry {
        val control = envelope.captureControl
        val reason = control.degradedReason?.split(';')?.filter { it != CrashReporter.REPLAY_OMITTED_REASON }
            ?.joinToString(";")?.takeIf { it.isNotEmpty() }
        val upgraded = envelope.copy(attachments = listOf(pair.envelope), captureControl = control.copy(degradedReason = reason))
        val bytes = EnvelopeBuilder.JSON.encodeToString(ReportEnvelope.serializer(), upgraded).toByteArray(Charsets.UTF_8)
        val part = pair.part
        return original.copy(envelopeBytes = bytes, idempotencyKey = sha256(bytes),
            attachmentRefs = listOf(OutboxEntry.AttachmentRef(part.name, part.filename, part.contentType, part.data, part.sha256Hex)))
    }
}
