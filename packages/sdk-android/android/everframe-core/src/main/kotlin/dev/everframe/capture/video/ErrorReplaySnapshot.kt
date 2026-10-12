// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.atomic.AtomicBoolean

/** Error replays (spec 2026-10-11): limits and the one lane their background work runs on. */
internal object ErrorReplayWork {
    const val DEADLINE_MS = 3_000L
    const val MAX_PER_SESSION = 2
    /**
     * Never cancelled, kill() included: cancelling an export or attachment read quarantines the
     * optional export lane for the rest of the process; recording has its own lane. Abandoned work finishes, fails its own
     * allowed() checks, and its result is dropped.
     */
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
}

/**
 * One reserved error replay. The export runs in [ErrorReplayWork.scope]; [await] only waits for it.
 * [settle] runs exactly once: true counts against the session's two replays, false returns the
 * reservation. [discard] settles false unless the error envelope already took ownership ([handOff]).
 */
internal class ErrorReplaySnapshot(
    private val result: Deferred<VideoAttachmentPair?>,
    private val startedNanos: Long,
    private val allowed: () -> Boolean,
    private val settled: (attached: Boolean) -> Unit,
    private val nowNanos: () -> Long = System::nanoTime,
) {
    private val handedOff = AtomicBoolean()
    private val done = AtomicBoolean()

    /** The attachment, or null once [ErrorReplayWork.DEADLINE_MS] from capture has passed. */
    suspend fun await(): VideoAttachmentPair? {
        val remaining = ErrorReplayWork.DEADLINE_MS - (nowNanos() - startedNanos) / 1_000_000
        if (remaining <= 0) return null
        return try { withTimeoutOrNull(remaining) { result.await() } }
        catch (cancelled: CancellationException) { if (result.isCancelled) null else throw cancelled }
        catch (_: Throwable) { null }
    }

    /** Session generation, teardown and privacy; checked inside the outbox store lock before storing. */
    fun replayAllowed(): Boolean = !done.get() && runCatching(allowed).getOrDefault(false)
    fun handOff(): Boolean = handedOff.compareAndSet(false, true)
    fun discard() { if (!handedOff.get()) settle(false) }
    fun settle(attached: Boolean) { if (done.compareAndSet(false, true)) runCatching { settled(attached) } }
}
