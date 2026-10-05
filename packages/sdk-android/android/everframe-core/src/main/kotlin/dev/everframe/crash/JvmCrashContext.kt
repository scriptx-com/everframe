// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import dev.everframe.envelope.RedactionEngine
import dev.everframe.protocol.generated.Frame
import dev.everframe.protocol.generated.JVMCause
import dev.everframe.protocol.generated.JVMCrashMetadata
import java.util.Collections
import java.util.IdentityHashMap

private const val MAX_CAUSES = 8
private const val MAX_CAUSE_FRAMES = 32
private val R8_MAPPING_ID = Regex("[A-Za-z0-9][A-Za-z0-9._-]{0,127}")

internal data class CapturedThrowableContext(
    val jvm: JVMCrashMetadata,
    val causeChain: dev.everframe.protocol.generated.CrashCauseChain?,
)

/** Preserve the existing JVM projection for callers that only need that context. */
internal fun captureJvmContext(throwable: Throwable, mappingId: String?): JVMCrashMetadata =
    captureThrowableContext(throwable, mappingId) { true }.jvm

/** One host traversal, with independently fitted JVM and generic wire projections. */
internal fun captureThrowableContext(
    throwable: Throwable, mappingId: String?, stillOwned: () -> Boolean,
): CapturedThrowableContext {
    val causes = ArrayList<JVMCause>(MAX_CAUSES)
    val generic = org.json.JSONArray()
    val visited = Collections.newSetFromMap(IdentityHashMap<Throwable, Boolean>())
    visited.add(throwable)
    var causesTruncated = false
    var genericLoss = false
    var cancelled = false
    fun owned(): Boolean {
        val current = runCatching { stillOwned() }.getOrDefault(false)
        if (!current) cancelled = true
        return current
    }
    fun next(node: Throwable): Throwable? {
        if (!owned()) return null
        val value = try { node.cause } catch (_: Throwable) { causesTruncated = true; null }
        return if (owned()) value else null
    }
    var current = next(throwable)
    while (current != null && owned()) {
        if (causes.size == MAX_CAUSES || !visited.add(current)) { causesTruncated = true; break }
        val rawType = current.javaClass.name
        val rawMessage = try { current.message ?: rawType } catch (_: Throwable) { genericLoss = true; rawType }
        if (!owned()) break
        val stack = try { current.stackTrace } catch (_: Throwable) { null }
        if (!owned()) break
        val frames = stack?.take(MAX_CAUSE_FRAMES)?.map(::captureFrame).orEmpty()
        val framesLost = stack == null || stack.size > MAX_CAUSE_FRAMES
        causes += JVMCause(exceptionType = redactAndCap(rawType, 256), message = redactAndCap(rawMessage, 4096),
            frames = frames, framesTruncated = framesLost)
        // One extra scan unit lets the generic fitter describe discarded text.
        // This independent input never alters the legacy JVM redaction/capping.
        val rawFrames = org.json.JSONArray()
        stack?.take(MAX_CAUSE_FRAMES)?.forEach { element ->
            rawFrames.put(org.json.JSONObject().put("raw", element.toString().take(8193))
                .put("file", element.fileName?.take(8193)).put("function", element.methodName.take(8193))
                .apply { if (element.lineNumber >= 0) put("line", element.lineNumber) })
        }
        generic.put(org.json.JSONObject().put("exceptionType", rawType.take(8193)).put("message", rawMessage.take(8193))
            .put("frames", rawFrames).put("framesTruncated", framesLost))
        current = next(current)
    }
    val jvm = JVMCrashMetadata(causes = causes, causesTruncated = causesTruncated || cancelled,
        mappingID = mappingId?.takeIf { R8_MAPPING_ID.matches(it) })
    val causeChain = if (cancelled || (causes.isEmpty() && !causesTruncated && !genericLoss)) null else
        normalizeCrashCauseChain(org.json.JSONObject().put("causes", generic).put("truncated", causesTruncated || genericLoss),
            RedactionEngine::redact, stillOwned)
    return CapturedThrowableContext(jvm, causeChain)
}

internal fun captureFrame(element: StackTraceElement) = Frame(
    raw = redactAndCap(element.toString(), 1024),
    file = element.fileName?.let { redactAndCap(it, 1024) },
    function = redactAndCap(element.methodName, 512),
    line = element.lineNumber.takeIf { it >= 0 }?.toLong(),
)

internal fun redactAndCap(value: String, cap: Int): String =
    normalizeJsonbText(RedactionEngine.redact(value).take(cap))

/** Replace text PostgreSQL JSONB cannot encode after the UTF-16-unit cap is applied. */
private fun normalizeJsonbText(value: String): String {
    val normalized = StringBuilder(value.length)
    var index = 0
    while (index < value.length) {
        val current = value[index]
        when {
            current == '\u0000' -> normalized.append('\uFFFD')
            Character.isHighSurrogate(current) -> {
                val next = value.getOrNull(index + 1)
                if (next != null && Character.isLowSurrogate(next)) {
                    normalized.append(current).append(next)
                    index += 1
                } else {
                    normalized.append('\uFFFD')
                }
            }
            Character.isLowSurrogate(current) -> normalized.append('\uFFFD')
            else -> normalized.append(current)
        }
        index += 1
    }
    return normalized.toString()
}
