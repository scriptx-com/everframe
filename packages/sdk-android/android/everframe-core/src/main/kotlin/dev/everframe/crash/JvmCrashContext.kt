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

/** Capture the bounded JVM-only context that complements the outer crash fields. */
internal fun captureJvmContext(throwable: Throwable, mappingId: String?): JVMCrashMetadata {
    val causes = ArrayList<JVMCause>(MAX_CAUSES)
    val visited = Collections.newSetFromMap(IdentityHashMap<Throwable, Boolean>())
    visited.add(throwable)

    var causesTruncated = false
    var current = try {
        throwable.cause
    } catch (_: Throwable) {
        causesTruncated = true
        null
    }

    while (current != null) {
        if (causes.size == MAX_CAUSES || !visited.add(current)) {
            causesTruncated = true
            break
        }

        val exceptionType = redactAndCap(current.javaClass.name, 256)
        val message = try {
            current.message ?: current.javaClass.name
        } catch (_: Throwable) {
            current.javaClass.name
        }

        val stack = try {
            current.stackTrace
        } catch (_: Throwable) {
            null
        }
        val frames = stack?.take(MAX_CAUSE_FRAMES)?.map(::captureFrame).orEmpty()
        causes += JVMCause(
            exceptionType = exceptionType,
            message = redactAndCap(message, 4096),
            frames = frames,
            framesTruncated = stack == null || stack.size > MAX_CAUSE_FRAMES,
        )

        current = try {
            current.cause
        } catch (_: Throwable) {
            causesTruncated = true
            null
        }
    }

    return JVMCrashMetadata(
        causes = causes,
        causesTruncated = causesTruncated,
        mappingID = mappingId?.takeIf { R8_MAPPING_ID.matches(it) },
    )
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
