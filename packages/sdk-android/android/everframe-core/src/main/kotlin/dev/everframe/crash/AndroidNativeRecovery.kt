// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import dev.everframe.outbox.OutboxAuthorization
import dev.everframe.outbox.OutboxEntry
import dev.everframe.outbox.OutboxStore
import dev.everframe.protocol.generated.AndroidNativeCrashMetadata
import java.io.InputStream
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*

internal data class AndroidNativeExit(
    val pid: Int,
    val processName: String,
    val timestamp: Long,
    val reason: Int,
    val stateSummary: ByteArray?,
    val openTrace: () -> InputStream?,
)

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
        private val json = Json { encodeDefaults = false; explicitNulls = false }
        private fun digest(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        private fun token(id: String) = (TOKEN_PREFIX + id).toByteArray(Charsets.US_ASCII)
    }

    fun arm(template: OutboxEntry, pid: Int, processName: String, authorization: OutboxAuthorization,
            diagnostics: Boolean = false, processLaunchId: String = UUID.randomUUID().toString(), apiLevel: Int = 31, register: (ByteArray) -> Unit) {
        require(UUID.fromString(template.reportId).toString() == template.reportId)
        require(template.identitySubject == null && template.attachmentRefs.isEmpty())
        require(template.envelopeBytes.size <= MAX_CONTEXT_BYTES && pid > 0 && processName.length in 1..256)
        val envelope = json.parseToJsonElement(template.envelopeBytes.toString(Charsets.UTF_8)).jsonObject
        require(envelope["reportId"]?.jsonPrimitive?.content == template.reportId)
        require(envelope["reporter"]?.jsonObject?.get("user") == null)
        require(envelope["sessionId"] == null)
        require(envelope["payload"]?.jsonObject?.isEmpty() == true)
        val context = buildJsonObject {
            put("version", if (diagnostics) 2 else 1); put("pid", pid); put("process", processName); put("envelope", envelope)
            if (diagnostics) {
                require(apiLevel >= 30 && UUID.fromString(processLaunchId).toString() == processLaunchId)
                put("processLaunchId", processLaunchId); put("apiLevel", apiLevel)
            }
        }.toString().toByteArray(Charsets.UTF_8)
        require(context.size <= MAX_CONTEXT_BYTES)
        val durable = contexts.enqueueSync(template.copy(envelopeBytes = context), authorization)
        try {
            check(authorization.isAllowed())
            register(token(template.reportId))
            check(authorization.isAllowed())
        } catch (failure: Exception) {
            contexts.removeIfPresent(durable)
            throw failure
        }
    }

    fun recover(exits: List<AndroidNativeExit>, nowMs: Long, authorization: OutboxAuthorization, allowDiagnostics: Boolean = false, admit: (OutboxEntry) -> Boolean): Int {
        var admitted = drainPrepared(authorization, admit, allowDiagnostics)
        val alreadyPrepared = prepared.snapshotTokens().mapNotNull { prepared.readIfPresent(it)?.entry?.reportId }.toSet()
        for (key in contexts.snapshotTokens()) {
            if (!authorization.isAllowed()) break
            val context = contexts.readIfPresent(key)?.entry ?: continue
            if (context.reportId in alreadyPrepared) continue
            if (nowMs >= context.createdAt && nowMs - context.createdAt > MAX_AGE_MS) {
                contexts.removeIfPresent(key); continue
            }
            val state = try {
                require(context.envelopeBytes.size <= MAX_CONTEXT_BYTES)
                json.parseToJsonElement(context.envelopeBytes.toString(Charsets.UTF_8)).jsonObject
            } catch (_: Exception) { continue }
            val version = state["version"]?.jsonPrimitive?.intOrNull
            if (version != 1 && version != 2) continue
            val diagnostics = version == 2
            val launchId = state["processLaunchId"]?.jsonPrimitive?.contentOrNull
            val apiLevel = state["apiLevel"]?.jsonPrimitive?.intOrNull ?: 31
            if (diagnostics && (apiLevel < 30 || runCatching { UUID.fromString(launchId).toString() == launchId }.getOrDefault(false).not())) continue
            val pid = state["pid"]?.jsonPrimitive?.intOrNull ?: continue
            val process = state["process"]?.jsonPrimitive?.contentOrNull ?: continue
            val expected = token(context.reportId)
            val matches = exits.take(32).filter { it.pid == pid && it.processName == process &&
                it.timestamp >= context.createdAt && it.timestamp <= nowMs && it.stateSummary?.contentEquals(expected) == true }
            if (matches.size != 1) continue
            val exit = matches.single()
            if (exit.reason != NATIVE_REASON && (!diagnostics || !allowDiagnostics)) { contexts.removeIfPresent(key); continue }
            var trace = AndroidExitDiagnostic.trace("not_requested")
            var native: AndroidNativeCrashMetadata? = null
            if (exit.reason == NATIVE_REASON) {
                if (apiLevel < 31) trace = AndroidExitDiagnostic.trace("unsupported")
                else try {
                    val stream = exit.openTrace()
                    if (stream == null) trace = AndroidExitDiagnostic.trace("unavailable")
                    else {
                        native = AndroidTombstoneReader.read(stream, expectedPid = exit.pid)
                        trace = if (native == null) AndroidExitDiagnostic.trace("malformed")
                            else AndroidExitDiagnostic.trace("available", "android_tombstone", native.framesIncomplete)
                    }
                } catch (_: Exception) { trace = AndroidExitDiagnostic.trace("malformed") }
            } else if (exit.reason == 6) trace = AndroidExitDiagnostic.readAnr(exit.openTrace, exit.pid)
            if (!authorization.isAllowed()) break
            val envelope = state["envelope"]?.jsonObject ?: continue
            val diagnostic = if (diagnostics) AndroidExitDiagnostic.evidence(context.reportId, launchId!!, apiLevel, exit, nowMs, trace) else null
            val report = recovered(context, envelope, exit, native, nowMs, diagnostic)
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

    private fun recovered(context: OutboxEntry, template: JsonObject, exit: AndroidNativeExit,
                          native: AndroidNativeCrashMetadata?, nowMs: Long, diagnostic: JsonObject?): OutboxEntry {
        val frames = native?.frames.orEmpty().map {
            buildJsonObject { put("raw", "${it.module ?: "<unknown>"} ${it.relativePC}") }
        }
        val kind = native?.signalNumber?.let { "Native signal $it" } ?: "Native process crash"
        val groupInput = kind + native?.frames.orEmpty().take(5).joinToString("|") { "${it.buildID}:${it.module}:${it.relativePC}" }
        val crash = buildJsonObject {
            put("exceptionType", kind)
            put("message", if (native == null) "Native process crash (tombstone unavailable)" else "Native process crash")
            put("mechanism", "android-exit-info"); put("handled", false); put("fatal", true)
            put("occurredAt", Instant.ofEpochMilli(exit.timestamp).toString())
            put("fingerprint", digest(groupInput.toByteArray()).take(16))
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
