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
    /** ApplicationExitInfo.getImportance() at death; 0 when unknown. */
    val importance: Int = 0,
    /** ApplicationExitInfo.getPss()/getRss() at death, in KiB; 0 when unknown. */
    val pss: Long = 0,
    val rss: Long = 0,
    /** ApplicationExitInfo.getDescription(); kept only as bounded printable text, for low-memory kills. */
    val description: String? = null,
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
        private const val LOW_MEMORY_REASON = 3 // ApplicationExitInfo.REASON_LOW_MEMORY.
        /**
         * RunningAppProcessInfo.IMPORTANCE_VISIBLE: up to here the user could see or hear the app (a
         * foreground service plays in the background; visible covers picture-in-picture playback).
         * Not PERCEPTIBLE (230): expedited jobs and backup agents report it for work nobody saw.
         */
        private const val IMPORTANCE_VISIBLE = 200
        private const val LOW_MEMORY_KIND = "Low memory kill"
        /** Appended to the OS token once the JVM handler admitted this process's fatal crash. */
        internal val JVM_FATAL_SUFFIX = "|jvm".toByteArray(Charsets.US_ASCII)
        /** A low-memory kill has no stack: one issue per app across releases, not one per occurrence,
         * and never one shared by every app of a project (groups are unique per project and fingerprint). */
        internal fun lowMemoryFingerprint(appId: String) = digest("$LOW_MEMORY_KIND|system_low_memory|$appId".toByteArray()).take(16)
        /** Foreground, foreground service (background playback) or visible at death. */
        fun userFacing(exit: AndroidNativeExit) = exit.reason == LOW_MEMORY_REASON && exit.importance in 1..IMPORTANCE_VISIBLE
        private val json = Json { encodeDefaults = false; explicitNulls = false }
        private fun digest(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        private fun token(id: String) = (TOKEN_PREFIX + id).toByteArray(Charsets.US_ASCII)
    }
    private var armed: OutboxToken? = null // Caller serializes arm and disarm.

    fun arm(template: OutboxEntry, pid: Int, processName: String, authorization: OutboxAuthorization,
            diagnostics: Boolean = false, processLaunchId: String = UUID.randomUUID().toString(), apiLevel: Int = 31, nativeExposure: NativeExposurePointer? = null,
            exits: List<AndroidNativeExit> = emptyList(), onReclaimed: (unreportable: Int, oldest: Int) -> Unit = { _, _ -> },
            appId: String? = null, register: (ByteArray) -> Unit) {
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
        val held = held(exits, pid)
        val context = buildJsonObject {
            // The version persists the arm-time mode; a native-only context may still carry a pointer.
            put("version", if (diagnostics) 2 else 1); put("pid", pid); put("process", processName); put("envelope", envelope)
            // Insertion order for a full journal: wall-clock createdAt cannot rank contexts when the clock jumps.
            put("sequence", (held.maxOfOrNull { it.sequence } ?: 0L).coerceAtLeast(0L) + 1)
            if (appId != null) put("appId", appId)
            if (enriched) {
                require(apiLevel >= 30 && UUID.fromString(processLaunchId).toString() == processLaunchId)
                put("processLaunchId", processLaunchId); put("apiLevel", apiLevel)
                if (nativeExposure != null) put("nativeExposure", nativeExposure.toJson())
            }
        }.toString().toByteArray(Charsets.UTF_8)
        require(context.size <= MAX_CONTEXT_BYTES)
        val durable = enqueueContext(template.copy(envelopeBytes = context), authorization, held, onReclaimed)
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

    /** A held context: [reportable] when its process is this one or one OS exit record matches it. */
    private class Held(val token: OutboxToken, val sequence: Long, val reportable: Boolean)

    private fun held(exits: List<AndroidNativeExit>, currentPid: Int): List<Held> =
        contexts.snapshotTokens().mapNotNull { token ->
            val context = contexts.readIfPresent(token)?.entry ?: return@mapNotNull null
            val state = parse(context)
            Held(token, state?.sequence ?: -1L,
                state != null && (state.pid == currentPid || matchingExits(state, context.reportId, exits).size == 1))
        }

    /**
     * A full journal must not stop capture, and frees only the slots this context needs: contexts that
     * can no longer be reported first (unreadable, or an ended process with no single matching OS exit
     * record because a reboot lost it or the history evicted it), then still reportable ones, each
     * oldest first by insertion sequence. The newest held context, the latest earlier process whose
     * exit may not be in the history yet, is never dropped.
     */
    private fun enqueueContext(entry: OutboxEntry, authorization: OutboxAuthorization, held: List<Held>,
                               onReclaimed: (Int, Int) -> Unit): OutboxToken {
        fun full(failure: OutboxWriteException) = failure.failure == OutboxFailure.CAPACITY
        var refused = try { return contexts.enqueueSync(entry, authorization) } catch (failure: OutboxWriteException) {
            if (!full(failure)) throw failure
            failure
        }
        val newest = held.maxByOrNull { it.sequence }
        var unreportable = 0
        var oldest = 0
        for (candidate in held.filter { it !== newest }.sortedWith(compareBy<Held>({ it.reportable }, { it.sequence }))) {
            contexts.removeIfPresent(candidate.token)
            if (candidate.reportable) oldest++ else unreportable++
            try { return contexts.enqueueSync(entry, authorization).also { onReclaimed(unreportable, oldest) } }
            catch (failure: OutboxWriteException) { if (!full(failure)) throw failure; refused = failure }
        }
        throw refused
    }

    private class State(val version: Int, val pid: Int, val process: String, val json: JsonObject, val sequence: Long)

    private fun parse(context: OutboxEntry): State? = try {
        require(context.envelopeBytes.size <= MAX_CONTEXT_BYTES)
        val state = json.parseToJsonElement(context.envelopeBytes.toString(Charsets.UTF_8)).jsonObject
        val version = state["version"]?.jsonPrimitive?.intOrNull
        if (version != 1 && version != 2) null
        else State(version, state["pid"]!!.jsonPrimitive.int, state["process"]!!.jsonPrimitive.content, state,
            state["sequence"]?.jsonPrimitive?.longOrNull ?: 0L)
    } catch (_: Exception) { null }

    /**
     * The exact random token plus PID and process name identify the exit; no other process can set this
     * process's summary. Wall-clock times are not compared: a clock that jumps would hide the match.
     * The token may carry [JVM_FATAL_SUFFIX].
     */
    private fun matchingExits(state: State, reportId: String, exits: List<AndroidNativeExit>): List<AndroidNativeExit> {
        val expected = token(reportId)
        val jvmFatal = expected + JVM_FATAL_SUFFIX
        return exits.take(32).filter { exit ->
            val summary = exit.stateSummary
            exit.pid == state.pid && exit.processName == state.process &&
                summary != null && (summary.contentEquals(expected) || summary.contentEquals(jvmFatal))
        }
    }

    /** Drops only this owner's current-process context, after its OS token was replaced or cleared. */
    fun disarm() {
        armed?.let { contexts.removeIfPresent(it) }
        armed = null
    }

    /**
     * [retainSignalReceipts] receives the launches whose contexts remain once recovery has run to the
     * end: the API26..30 signal path keeps a delivery receipt exactly as long as its launch's context.
     */
    fun recover(exits: List<AndroidNativeExit>, nowMs: Long, authorization: OutboxAuthorization, allowDiagnostics: Boolean = false,
                signalCapture: (String) -> NativeSignalCapture = { NativeSignalCapture.NONE },
                retainSignalReceipts: (Set<String>) -> Unit = {}, admit: (OutboxEntry) -> Boolean): Int {
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
            // The JVM handler already reported this process's fatal crash: a low-memory kill that ended
            // it while the handler ran (a Java OOM) is the same death, not a second issue.
            val jvmReported = exit.stateSummary?.contentEquals(token(context.reportId) + JVM_FATAL_SUFFIX) == true
            // Reported: native crashes, ANRs, and low-memory kills while the user could see or hear the
            // app. Background and cached reclaims, user stops, JVM crashes (the uncaught-exception
            // handler reports those) and other exits are consumed without a report, so an app the OS
            // routinely kills cannot crowd real crashes out of ingest limits.
            val evidenceExit = exit.reason == ANR_REASON || (userFacing(exit) && !jvmReported)
            if (exit.reason != NATIVE_REASON && (!evidenceExit || !diagnostics || !allowDiagnostics)) {
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
            // A clock that moved back (a TV that boots at 1970 before network time) can put the exit
            // after this launch's clock. Collection never precedes the exit it collected: the protocol
            // rejects that, and a rejected report is final.
            val collectedMs = maxOf(nowMs, exit.timestamp)
            val frozen = (state["nativeExposure"] as? JsonObject)?.let(NativeExposurePointer::parse)
                ?.takeIf { it.processLaunchId == launchId }
            val diagnostic = if (diagnostics || frozen != null) {
                val evidence = AndroidExitDiagnostic.evidence(context.reportId, launchId!!, apiLevel, exit, collectedMs, trace)
                if (frozen == null) evidence else JsonObject(evidence + ("nativeExposure" to frozen.toJson()))
            } else null
            val appId = state["appId"]?.jsonPrimitive?.contentOrNull
                ?: envelope["context"]?.jsonObject?.get("app")?.jsonObject?.get("name")?.jsonPrimitive?.contentOrNull.orEmpty()
            val report = recovered(context, envelope, exit, tombstone, collectedMs, diagnostic, appId)
            try { prepared.enqueueSync(report, authorization) } catch (_: Exception) { continue }
            admitted += drainPrepared(authorization, admit, allowDiagnostics)
        }
        // Only a complete pass knows which contexts are left; an interrupted one keeps every receipt.
        if (authorization.isAllowed()) runCatching {
            val held = contexts.snapshotTokens().map { token ->
                val context = contexts.readIfPresent(token)?.entry ?: return@map null
                parse(context)?.json?.get("processLaunchId")?.jsonPrimitive?.contentOrNull
            }
            retainSignalReceipts(held.filterNotNull().toSet())
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
                          tombstone: AndroidTombstone?, collectedMs: Long, diagnostic: JsonObject?, appId: String): OutboxEntry {
        val native = tombstone?.metadata
        val frames = native?.frames.orEmpty().map {
            buildJsonObject { put("raw", "${it.module ?: "<unknown>"} ${it.relativePC}") }
        }
        val signal = native?.signalNumber ?: exit.status.takeIf { it in 1..64 }?.toLong()
        val kind = signal?.let { "Native signal $it" } ?: "Native process crash"
        val lowMemory = userFacing(exit)
        val crash = if (lowMemory) buildJsonObject {
            put("exceptionType", LOW_MEMORY_KIND)
            val sizes = listOfNotNull(exit.pss.takeIf { it > 0 }?.let { "PSS $it KiB" }, exit.rss.takeIf { it > 0 }?.let { "RSS $it KiB" })
            put("message", "Killed for low memory while ${importanceName(exit.importance)}" +
                if (sizes.isEmpty()) "" else " (${sizes.joinToString(", ")})")
            put("mechanism", "android-exit-info"); put("handled", false); put("fatal", true)
            put("occurredAt", Instant.ofEpochMilli(exit.timestamp).toString())
            put("fingerprint", lowMemoryFingerprint(appId))
            put("frames", JsonArray(emptyList()))
        } else buildJsonObject {
            put("exceptionType", kind)
            put("message", if (native == null) "Native process crash (tombstone unavailable)" else "Native process crash")
            put("mechanism", "android-exit-info"); put("handled", false); put("fatal", true)
            put("occurredAt", Instant.ofEpochMilli(exit.timestamp).toString())
            put("fingerprint", digest(groupKey(kind, tombstone).toByteArray()).take(16))
            put("frames", JsonArray(frames))
            if (native != null) put("androidNative", json.encodeToJsonElement(native))
        }
        val fatal = exit.reason == NATIVE_REASON || lowMemory
        val bytes = JsonObject(template + mapOf("source" to JsonPrimitive(if (fatal) "crash" else "diagnostic"),
            "submittedAt" to JsonPrimitive(Instant.ofEpochMilli(collectedMs).toString()),
            "payload" to buildJsonObject {
                if (fatal) put("crash", crash)
                if (diagnostic != null) put("diagnostic", diagnostic)
            })).toString().toByteArray(Charsets.UTF_8)
        return context.copy(createdAt = exit.timestamp, envelopeBytes = bytes, idempotencyKey = digest(bytes),
            identitySubject = null, attachmentRefs = emptyList())
    }

    private fun importanceName(importance: Int) = when {
        importance <= 100 -> "in the foreground"
        importance <= 125 -> "running a foreground service"
        else -> "visible"
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
