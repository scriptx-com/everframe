// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Finalization half of Android response-body capture: decode a widened
// window, redact the WHOLE window, then truncate the REDACTED output down to
// the cap (web F19 / iOS secretScanOverlap — never cap before redacting).
// Runs off the app's thread; see submit() in the next task.
//
// Spec: the public behavior contract §5.3, §8
package dev.everframe.capture

import androidx.annotation.VisibleForTesting
import dev.everframe.envelope.RedactionEngine
import dev.everframe.protocol.generated.BodySkipped
import dev.everframe.protocol.generated.NetworkBody
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

object NetworkBodyFinalizer {

    /** Outcome of [decodeAndRedact]. Nulls mean "omit this field from the entry". */
    internal data class BodyText(
        val body: String?,
        val truncated: Boolean?,
        val bytes: Double?,
        val skipped: BodySkipped?,
    )

    /** Everything the finalizer needs that the tee cannot know. */
    internal data class Ctx(
        val reqId: Int,
        /** The metadata entry's own timestamp — the single clock both channels share. */
        val t: Long,
        val cap: Int,
        /** Gate generation captured at DECISION time, re-validated at append. */
        val generation: Int,
        /** Already redacted by the interceptor's RedactionEngine.filterHeaders. */
        val resHeaders: Map<String, String>,
    )

    private const val queueDepth = 32

    /**
     * Single worker, bounded queue, discard on saturation. Capture must never
     * apply backpressure to the app, and an unbounded queue would let a burst
     * of finalizations retain raw bytes without limit. A discarded entry is
     * invisible to the app and simply leaves a dangling crumb reqId.
     */
    private val executor = ThreadPoolExecutor(
        1, 1, 0L, TimeUnit.MILLISECONDS,
        ArrayBlockingQueue(queueDepth),
        { r -> Thread(r, "everframe-body-finalizer").apply { isDaemon = true } },
        ThreadPoolExecutor.DiscardPolicy(),
    )

    /** Test-only: run finalization inline so assertions need no synchronization. */
    @VisibleForTesting
    internal var __directForTesting: Boolean = false

    /**
     * Called by the tee at finalization. Returns immediately.
     *
     * @param failed the delegate threw an IOException. Distinguishes a dead
     *   transport from an abandoned body when nothing was copied (spec §8).
     */
    internal fun submit(raw: ByteArray, complete: Boolean, failed: Boolean, declaredLength: Long, ctx: Ctx) {
        val work = Runnable { finalizeNow(raw, complete, failed, declaredLength, ctx) }
        if (__directForTesting) work.run() else executor.execute(work)
    }

    private fun finalizeNow(raw: ByteArray, complete: Boolean, failed: Boolean, declaredLength: Long, ctx: Ctx) {
        // OVERRIDE (task-4 human override, supersedes the brief's literal
        // `raw.isEmpty() && !complete` guard): a chunked response with an
        // empty body has contentLength() == -1, so Task 2's decide() does
        // not screen it out on content length — it reaches finalization
        // with zero bytes AND complete = true. The rule is "no entry for
        // zero bytes, regardless of complete, UNLESS failed" — dropping
        // `&& !complete` here is what makes the complete-but-empty case
        // also produce no entry instead of an empty-body row.
        if (raw.isEmpty()) {
            // Nothing arrived. Two different stories, and they must not look
            // the same: a dead transport is worth reporting, an app that
            // closed the body untouched (or a genuinely empty response) is
            // not (an empty row would be pure noise inside a 256 KiB budget).
            if (failed) appendSkip(BodySkipped.Error, ctx)
            return
        }

        val out = decodeAndRedact(raw, ctx.cap, complete, declaredLength)
        append(
            NetworkBody(
                ref = ctx.reqId.toDouble(),
                t = ctx.t.toDouble(),
                resBody = out.body,
                resBodyBytes = out.bytes,
                resBodyTruncated = out.truncated,
                resBodySkipped = out.skipped,
                resHeaders = ctx.resHeaders,
            ),
            ctx.generation,
        )
    }

    /** Immediate reason-only entry for a Decision.Skip (spec §7). */
    internal fun appendSkip(reason: BodySkipped, ctx: Ctx) {
        append(
            NetworkBody(
                ref = ctx.reqId.toDouble(),
                t = ctx.t.toDouble(),
                resBodySkipped = reason,
                resHeaders = ctx.resHeaders,
            ),
            ctx.generation,
        )
    }

    private fun append(entry: NetworkBody, generation: Int) {
        sharedNetworkBodyBuffer.append(entry) {
            NetworkBodyCaptureState.isActiveForGeneration(generation)
        }
    }

    /**
     * Test-only seam: run an arbitrary closure through the SAME executor
     * (subject to the same bounded-queue discard policy as production
     * work) rather than through [finalizeNow]. Lets a saturation test drain
     * the executor deterministically — via a latch the closure counts down
     * — without reaching into the private [executor] field directly and
     * without a wall-clock sleep.
     */
    @VisibleForTesting
    internal fun __submitForTesting(work: () -> Unit) {
        val runnable = Runnable(work)
        if (__directForTesting) runnable.run() else executor.execute(runnable)
    }

    /**
     * @param raw bytes copied by the tee — already bounded to cap + overlap.
     * @param complete EOF was reached AND the window never filled, so [raw] is
     *   the entire body and `raw.size` is its true size.
     * @param declaredLength the response's `contentLength()`, or -1 if unknown.
     */
    internal fun decodeAndRedact(
        raw: ByteArray,
        cap: Int,
        complete: Boolean,
        declaredLength: Long,
    ): BodyText {
        // Byte accounting (spec §8): a complete read is ground truth and
        // outranks the declaration; otherwise trust the declaration; otherwise
        // omit rather than invent.
        val trueTotal: Long? = when {
            complete -> raw.size.toLong()
            declaredLength >= 0L -> declaredLength
            else -> null
        }

        val window = NetworkBodyTee.utf8Prefix(raw, raw.size)
            ?: return BodyText(null, null, trueTotal?.toDouble(), BodySkipped.Error)

        val redacted = RedactionEngine.redact(window)
        val redactedBytes = redacted.toByteArray(Charsets.UTF_8)

        // Truncation is judged on the REDACTED byte length, not the
        // pre-redaction one: redaction can EXPAND a match (an 11-byte SSN
        // becomes the 14-byte token "[REDACTED:SSN]"), so a body that fit
        // under cap before redaction can still need cutting afterward.
        // An incomplete read never represents the true full body — regardless
        // of whether the declared length or the redacted size happens to fit
        // under cap — so it is always truncated.
        val needsCut = redactedBytes.size > cap
        val truncated = !complete || needsCut
        val body = if (needsCut) {
            // Empty-string fallback (not the unbounded `redacted`) keeps this
            // safe even in the case utf8Prefix can't find a boundary: it must
            // never hand back more than [cap] bytes.
            NetworkBodyTee.utf8Prefix(redactedBytes, cap) ?: ""
        } else {
            redacted
        }

        return BodyText(
            body = body,
            truncated = if (truncated) true else null,
            bytes = trueTotal?.toDouble(),
            skipped = null,
        )
    }
}
