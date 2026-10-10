// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import dev.everframe.health.NativeExposurePointer
import dev.everframe.outbox.OutboxAuthorization
import dev.everframe.outbox.OutboxEntry
import dev.everframe.outbox.OutboxFailure
import dev.everframe.outbox.OutboxStore
import dev.everframe.outbox.OutboxToken
import dev.everframe.outbox.OutboxWriteException
import dev.everframe.protocol.generated.AndroidNativeCrashMetadata
import java.io.InputStream
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import kotlin.math.abs

internal data class AndroidNativeExit(
    val pid: Int,
    val processName: String,
    val timestamp: Long,
    val reason: Int,
    val stateSummary: ByteArray?,
    val openTrace: () -> InputStream?,
    /** ApplicationExitInfo.getStatus(): the terminating signal of a native crash; 0 when unknown. */
    val status: Int,
) {
    constructor(pid: Int, processName: String, timestamp: Long, reason: Int, stateSummary: ByteArray?,
                openTrace: () -> InputStream?) : this(pid, processName, timestamp, reason, stateSummary, openTrace, 0)
}

/** Separate encrypted context + prepared-envelope journals. Never exposes a context as a report.
 * The prepared receipt freezes bytes before admission; source is removed before that receipt.
 * A process death at any boundary can retry only the identical report ID and payload.
 */
internal class AndroidNativeRecovery(
    private val contexts: OutboxStore,
    private val prepared: OutboxStore,
) {
    companion object {
        private const val TOKEN_PREFIX = "everframe-native-v1:"
        private const val MAX_AGE_MS = 14L * 24 * 60 * 60 * 1000
        private const val MAX_CONTEXT_BYTES = 65536
        private const val NATIVE_REASON = 5 // ApplicationExitInfo.REASON_CRASH_NATIVE, guarded by runtime API31.
        private const val ANR_REASON = 6 // ApplicationExitInfo.REASON_ANR.
        private val json = Json { encodeDefaults = false; explicitNulls = false }
        private fun digest(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        private fun token(id: String) = (TOKEN_PREFIX + id).toByteArray(Charsets.US_ASCII)
    }
    private var armed: OutboxToken? = null // Caller serializes arm and disarm.

    fun arm(template: OutboxEntry, pid: Int, processName: String, authorization: OutboxAuthorization,
            diagnostics: Boolean = false, processLaunchId: String = UUID.randomUUID().toString(), apiLevel: Int = 31, nativeExposure: NativeExposurePointer? = null,
            exits: List<AndroidNativeExit> = emptyList(), onReclaimed: (unreportable: Int, oldest: Int) -> Unit = { _, _ -> },
            register: (ByteArray) -> Unit) {
        require(UUID.fromString(template.reportId).toString() == template.reportId)
        require(template.identitySubject == null && template.attachmentRefs.isEmpty())
        require(template.envelopeBytes.size <= MAX_CONTEXT_BYTES && pid > 0 && processName.length in 1..256)
        val envelope = json.parseToJsonElement(template.envelopeBytes.toString(Charsets.UTF_8)).jsonObject
        require(envelope["reportId"]?.jsonPrimitive?.content == template.reportId)
        require(envelope["reporter"]?.jsonObject?.get("user") == null)
        require(envelope["sessionId"] == null)
        require(envelope["payload"]?.jsonObject?.isEmpty() == true)
        require(nativeExposure == null || (nativeExposure.valid() && nativeExposure.processLaunchId == processLaunchId))
        val enriched = diagnostics || nativeExposure != null
        val context = buildJsonObject {
            // The version persists the arm-time mode; a native-only context may still carry a pointer.
            put("version", if (diagnostics) 2 else 1); put("pid", pid); put("process", processName); put("envelope", envelope)
            if (enriched) {
                require(apiLevel >= 30 && UUID.fromString(processLaunchId).toString() == processLaunchId)
                put("processLaunchId", processLaunchId); put("apiLevel", apiLevel)
                if (nativeExposure != null) put("nativeExposure", nativeExposure.toJson())
            }
        }.toString().toByteArray(Charsets.UTF_8)
        require(context.size <= MAX_CONTEXT_BYTES)
        val durable = enqueueContext(template.copy(envelopeBytes = context), authorization, exits, pid, onReclaimed)
        try {
            check(authorization.isAllowed())
            register(token(template.reportId))
            check(authorization.isAllowed())
        } catch (failure: Exception) {
            contexts.removeIfPresent(durable)
            throw failure
        }
        armed = durable
    }

    /**
     * A full journal must not stop capture. It first drops contexts that can no longer be reported:
     * unreadable ones, and those of ended processes with no single matching OS exit record (a reboot
     * lost it, or the history evicted it). If the journal is still full, the oldest contexts go.
     */
    private fun enqueueContext(entry: OutboxEntry, authorization: OutboxAuthorization, exits: List<AndroidNativeExit>,
                               currentPid: Int, onReclaimed: (Int, Int) -> Unit): OutboxToken {
        fun full(failure: OutboxWriteException) = failure.failure == OutboxFailure.CAPACITY
        try { return contexts.enqueueSync(entry, authorization) } catch (failure: OutboxWriteException) { if (!full(failure)) throw failure }
        fun held() = contexts.snapshotTokens().mapNotNull { token -> contexts.readIfPresent(token)?.entry?.let { token to it } }
        var unreportable = 0
        for ((token, context) in held()) {
            val state = parse(context)
            val reportable = state != null && (state.pid == currentPid || matchingExits(state, context.reportId, exits).size == 1)
            if (!reportable) { contexts.removeIfPresent(token); unreportable++ }
        }
        var oldest = 0
        while (true) {
            try { return contexts.enqueueSync(entry, authorization).also { onReclaimed(unreportable, oldest) } }
            catch (failure: OutboxWriteException) {
                if (!full(failure)) throw failure
                val (token, _) = held().minByOrNull { it.second.createdAt } ?: throw failure
                contexts.removeIfPresent(token); oldest++
            }
        }
    }

    private class State(val version: Int, val pid: Int, val process: String, val json: JsonObject)

    private fun parse(context: OutboxEntry): State? = try {
        require(context.envelopeBytes.size <= MAX_CONTEXT_BYTES)
        val state = json.parseToJsonElement(context.envelopeBytes.toString(Charsets.UTF_8)).jsonObject
        val version = state["version"]?.jsonPrimitive?.intOrNull
        if (version != 1 && version != 2) null
        else State(version, state["pid"]!!.jsonPrimitive.int, state["process"]!!.jsonPrimitive.content, state)
    } catch (_: Exception) { null }

    /**
     * The exact random token plus PID and process name identify the exit; no other process can set this
     * process's summary. Wall-clock times are not compared: a clock that jumps would hide the match.
     */
    private fun matchingExits(state: State, reportId: String, exits: List<AndroidNativeExit>): List<AndroidNativeExit> {
        val expected = token(reportId)
        return exits.take(32).filter { it.pid == state.pid && it.processName == state.process && it.stateSummary?.contentEquals(expected) == true }
    }

    /** Drops only this owner's current-process context, after its OS token was replaced or cleared. */
    fun disarm() {
        armed?.let { contexts.removeIfPresent(it) }
        armed = null
    }

    fun recover(exits: List<AndroidNativeExit>, nowMs: Long, authorization: OutboxAuthorization, allowDiagnostics: Boolean = false,
                signalCapture: (String) -> NativeSignalCapture = { NativeSignalCapture.NONE }, admit: (OutboxEntry) -> Boolean): Int {
        var admitted = drainPrepared(authorization, admit, allowDiagnostics)
        val alreadyPrepared = prepared.snapshotTokens().mapNotNull { prepared.readIfPresent(it)?.entry?.reportId }.toSet()
        for (key in contexts.snapshotTokens()) {
            if (!authorization.isAllowed()) break
            val context = contexts.readIfPresent(key)?.entry ?: continue
            if (context.reportId in alreadyPrepared) continue
            // A context with no single matching exit expires 14 days from its creation in either clock
            // direction, so a clock that jumps back cannot keep it forever. A matched one is reported
            // however far the clock moved: its age on a jumping wall clock proves nothing.
            val unmatched = { if (abs(nowMs - context.createdAt) > MAX_AGE_MS) contexts.removeIfPresent(key) }
            val parsed = parse(context)
            if (parsed == null) { unmatched(); continue }
            val state = parsed.json
            val diagnostics = parsed.version == 2
            val launchId = state["processLaunchId"]?.jsonPrimitive?.contentOrNull
            val apiLevel = state["apiLevel"]?.jsonPrimitive?.intOrNull ?: 31
            if (diagnostics && (apiLevel < 30 || runCatching { UUID.fromString(launchId).toString() == launchId }.getOrDefault(false).not())) { unmatched(); continue }
            val matches = matchingExits(parsed, context.reportId, exits)
            if (matches.size != 1) { unmatched(); continue }
            val exit = matches.single()
            // Only native crashes and ANRs are reported. Low-memory kills, user stops, JVM crashes (the
            // uncaught-exception handler reports those) and other exits are consumed without a report,
            // so an app the OS routinely kills cannot crowd real crashes out of ingest limits.
            if (exit.reason != NATIVE_REASON && (exit.reason != ANR_REASON || !diagnostics || !allowDiagnostics)) {
                contexts.removeIfPresent(key); continue
            }
            if (exit.reason == NATIVE_REASON && launchId != null) {
                // API26..30 signal capture reports a fault it recorded once, with its fault frame. The
                // protocol carries a native exit only as a crash envelope, so this exit then adds none.
                when (runCatching { signalCapture(launchId) }.getOrDefault(NativeSignalCapture.NONE)) {
                    NativeSignalCapture.DELIVERED -> { contexts.removeIfPresent(key); continue }
                    NativeSignalCapture.PENDING -> continue // Decide again once that record is delivered or gone.
                    NativeSignalCapture.NONE -> Unit
                }
            }
            var trace = AndroidExitDiagnostic.trace("not_requested")
            var tombstone: AndroidTombstone? = null
            if (exit.reason == NATIVE_REASON) {
                if (apiLevel < 31) trace = AndroidExitDiagnostic.trace("unsupported")
                else try {
                    val stream = exit.openTrace()
                    if (stream == null) trace = AndroidExitDiagnostic.trace("unavailable")
                    else {
                        tombstone = AndroidTombstoneReader.readTombstone(stream, expectedPid = exit.pid)
                        val native = tombstone?.metadata
                        trace = if (native == null) AndroidExitDiagnostic.trace("malformed")
                            else AndroidExitDiagnostic.trace("available", "android_tombstone", native.framesIncomplete)
                    }
                } catch (_: Exception) { trace = AndroidExitDiagnostic.trace("malformed") }
            } else if (exit.reason == ANR_REASON) trace = AndroidExitDiagnostic.readAnr(exit.openTrace, exit.pid)
            if (!authorization.isAllowed()) break
            val envelope = state["envelope"]?.jsonObject ?: continue
            val frozen = (state["nativeExposure"] as? JsonObject)?.let(NativeExposurePointer::parse)
                ?.takeIf { it.processLaunchId == launchId }
            val diagnostic = if (diagnostics || frozen != null) {
                val evidence = AndroidExitDiagnostic.evidence(context.reportId, launchId!!, apiLevel, exit, nowMs, trace)
                if (frozen == null) evidence else JsonObject(evidence + ("nativeExposure" to frozen.toJson()))
            } else null
            val report = recovered(context, envelope, exit, tombstone, nowMs, diagnostic)
            try { prepared.enqueueSync(report, authorization) } catch (_: Exception) { continue }
            admitted += drainPrepared(authorization, admit, allowDiagnostics)
        }
        return admitted
    }

    private fun drainPrepared(authorization: OutboxAuthorization, admit: (OutboxEntry) -> Boolean, allowDiagnostics: Boolean): Int {
        var count = 0
        for (key in prepared.snapshotTokens()) {
            if (!authorization.isAllowed()) break
            val pending = prepared.readIfPresent(key) ?: continue
            if (!allowDiagnostics) {
                val source = runCatching { json.parseToJsonElement(pending.entry.envelopeBytes.toString(Charsets.UTF_8))
                    .jsonObject["source"]?.jsonPrimitive?.content }.getOrNull() ?: continue
                if (source == "diagnostic") {
                    forgetContext(pending.entry.reportId)
                    prepared.removeIfPresent(key)
                    continue
                }
            }
            // Caller must also fence target admission through the outbox's own authorization.
            val accepted = try { admit(pending.entry) } catch (_: Exception) { false }
            if (!accepted) continue
            forgetContext(pending.entry.reportId)
            prepared.removeIfPresent(key)
            count++
        }
        return count
    }

    private fun forgetContext(reportId: String) {
        for (source in contexts.snapshotTokens()) {
            if (contexts.readIfPresent(source)?.entry?.reportId == reportId) contexts.removeIfPresent(source)
        }
    }

    /** Signal plus app-packaged frames only: OS/ART build IDs and PCs change with every device build
     * and dexopt state, so they would split one crash site. Without app frames, the crashing module. */
    private fun groupKey(kind: String, tombstone: AndroidTombstone?): String {
        val frames = tombstone?.metadata?.frames.orEmpty()
        val app = frames.filterIndexed { index, _ -> tombstone?.appCode?.getOrNull(index) == true }.take(5)
        val identity = if (app.isEmpty()) frames.firstOrNull()?.module.orEmpty()
            else app.joinToString("|") { "${it.module}:${it.relativePC}" }
        return "$kind|$identity"
    }

    private fun recovered(context: OutboxEntry, template: JsonObject, exit: AndroidNativeExit,
                          tombstone: AndroidTombstone?, nowMs: Long, diagnostic: JsonObject?): OutboxEntry {
        val native = tombstone?.metadata
        val frames = native?.frames.orEmpty().map {
            buildJsonObject { put("raw", "${it.module ?: "<unknown>"} ${it.relativePC}") }
        }
        val signal = native?.signalNumber ?: exit.status.takeIf { it in 1..64 }?.toLong()
        val kind = signal?.let { "Native signal $it" } ?: "Native process crash"
        val crash = buildJsonObject {
            put("exceptionType", kind)
            put("message", if (native == null) "Native process crash (tombstone unavailable)" else "Native process crash")
            put("mechanism", "android-exit-info"); put("handled", false); put("fatal", true)
            put("occurredAt", Instant.ofEpochMilli(exit.timestamp).toString())
            put("fingerprint", digest(groupKey(kind, tombstone).toByteArray()).take(16))
            put("frames", JsonArray(frames))
            if (native != null) put("androidNative", json.encodeToJsonElement(native))
        }
        val bytes = JsonObject(template + mapOf("source" to JsonPrimitive(if (exit.reason == NATIVE_REASON) "crash" else "diagnostic"),
            "submittedAt" to JsonPrimitive(Instant.ofEpochMilli(nowMs).toString()),
            "payload" to buildJsonObject {
                if (exit.reason == NATIVE_REASON) put("crash", crash)
                if (diagnostic != null) put("diagnostic", diagnostic)
            })).toString().toByteArray(Charsets.UTF_8)
        return context.copy(createdAt = exit.timestamp, envelopeBytes = bytes, idempotencyKey = digest(bytes),
            identitySubject = null, attachmentRefs = emptyList())
    }

    /** Atomic invalidation can run alongside the SDK's epoch transition. Disk erasure runs outside stateLock. */
    fun invalidate() { contexts.invalidateSync(); prepared.invalidateSync() }
    fun revoke() {
        // Poison BOTH generations before any disk operation can fail. Attempt both
        // physical erasures; the caller retains its obligation if either fails.
        invalidate()
        var failure: Exception? = null
        for (store in listOf(contexts, prepared)) {
            try { store.revokeSync() }
            catch (error: Exception) {
                if (failure == null) failure = error else failure.addSuppressed(error)
            }
        }
        failure?.let { throw it }
    }
}
