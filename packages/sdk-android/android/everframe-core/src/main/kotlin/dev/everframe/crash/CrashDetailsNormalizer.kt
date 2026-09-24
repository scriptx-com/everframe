// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import dev.everframe.CaptureExceptionOptions
import dev.everframe.ErrorSeverity
import dev.everframe.envelope.EnvelopeBuilder
import dev.everframe.envelope.RedactionEngine
import dev.everframe.protocol.generated.CrashDetails
import dev.everframe.vitals.wire.esNumberText
import java.util.IdentityHashMap
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

private const val MAX_DETAILS_BYTES = 8_192
private const val MAX_CONTEXT_UNITS = 256
private const val MAX_KEY_UNITS = 128
private const val MAX_STRING_UNITS = 1_024
private const val MAX_SCAN_UNITS = 4_096
private const val MAX_NODES = 128
private const val MAX_CONTAINER_LEVELS = 4
private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
private const val REDACTED = "[REDACTED]"

private val SENSITIVE_KEY_PARTS = arrayOf(
    "password",
    "passwd",
    "secret",
    "token",
    "authorization",
    "cookie",
    "apikey",
)

private class ProjectionState(
    val redact: (String) -> String,
) {
    var nodes: Int = 0
    var truncated: Boolean = false
    val path = IdentityHashMap<Any, Boolean>()
}

private sealed interface Projected {
    data class Value(val value: JsonElement) : Projected
    data object Unsupported : Projected
}

private data class ProjectedText(
    val supported: Boolean,
    val value: String = "",
    val truncated: Boolean,
)

internal fun normalizeCrashDetails(
    options: CaptureExceptionOptions?,
    redact: (String) -> String = RedactionEngine::redact,
): CrashDetails = normalizeCrashDetails(options, redact, inheritedTruncated = false)

internal fun normalizeCrashDetails(
    options: CaptureExceptionOptions?,
    redact: (String) -> String,
    inheritedTruncated: Boolean,
): CrashDetails {
    val source = options ?: CaptureExceptionOptions()
    val state = ProjectionState(redact).apply { truncated = inheritedTruncated }

    val context = source.context?.let { input ->
        val projected = redactText(input, MAX_CONTEXT_UNITS, state.redact)
        if (projected.truncated) state.truncated = true
        if (projected.supported) projected.value else {
            state.truncated = true
            null
        }
    }

    val metadata = source.metadata?.let { input ->
        state.nodes = 1
        when (val projected = projectContainer(input, 1, state)) {
            is Projected.Value -> projected.value as JsonObject
            Projected.Unsupported -> {
                state.truncated = true
                null
            }
        }
    }

    val details = CrashDetails(
        context = context,
        metadata = metadata,
        severity = source.severity.toWireSeverity(),
        truncated = true.takeIf { state.truncated },
    )
    return fitMetadataToBytes(details)
}

private fun ErrorSeverity.toWireSeverity(): dev.everframe.protocol.generated.ErrorSeverity = when (this) {
    ErrorSeverity.INFO -> dev.everframe.protocol.generated.ErrorSeverity.Info
    ErrorSeverity.WARNING -> dev.everframe.protocol.generated.ErrorSeverity.Warning
    ErrorSeverity.ERROR -> dev.everframe.protocol.generated.ErrorSeverity.Error
}

private fun projectConsumedValue(
    value: Any?,
    containerLevel: Int,
    state: ProjectionState,
): Projected = when (value) {
    null -> Projected.Value(JsonNull)
    is String -> {
        val projected = redactText(value, MAX_STRING_UNITS, state.redact)
        if (projected.truncated) state.truncated = true
        if (projected.supported) Projected.Value(JsonPrimitive(projected.value)) else Projected.Unsupported
    }
    is Boolean -> Projected.Value(JsonPrimitive(value))
    is Byte -> Projected.Value(JsonPrimitive(value))
    is Short -> Projected.Value(JsonPrimitive(value))
    is Int -> Projected.Value(JsonPrimitive(value))
    is Long -> if (value in -MAX_SAFE_INTEGER..MAX_SAFE_INTEGER) {
        Projected.Value(JsonPrimitive(value))
    } else {
        Projected.Unsupported
    }
    is Float -> if (value.isFinite()) Projected.Value(JsonPrimitive(value)) else Projected.Unsupported
    is Double -> if (value.isFinite()) Projected.Value(JsonPrimitive(value)) else Projected.Unsupported
    is Map<*, *>,
    is List<*>,
    is Array<*>,
    is BooleanArray,
    is ByteArray,
    is ShortArray,
    is IntArray,
    is LongArray,
    is FloatArray,
    is DoubleArray,
    -> projectContainer(value, containerLevel, state)
    else -> Projected.Unsupported
}

private fun projectContainer(
    input: Any,
    containerLevel: Int,
    state: ProjectionState,
): Projected {
    if (containerLevel > MAX_CONTAINER_LEVELS || state.path.containsKey(input)) return Projected.Unsupported
    state.path[input] = true
    return try {
        when (input) {
            is Map<*, *> -> projectMap(input, containerLevel, state)
            is List<*> -> projectList(input, containerLevel, state)
            is Array<*> -> projectIndexed(input.size, containerLevel, state) { input[it] }
            is BooleanArray -> projectIndexed(input.size, containerLevel, state) { input[it] }
            is ByteArray -> projectIndexed(input.size, containerLevel, state) { input[it] }
            is ShortArray -> projectIndexed(input.size, containerLevel, state) { input[it] }
            is IntArray -> projectIndexed(input.size, containerLevel, state) { input[it] }
            is LongArray -> projectIndexed(input.size, containerLevel, state) { input[it] }
            is FloatArray -> projectIndexed(input.size, containerLevel, state) { input[it] }
            is DoubleArray -> projectIndexed(input.size, containerLevel, state) { input[it] }
            else -> Projected.Unsupported
        }
    } finally {
        state.path.remove(input)
    }
}

private fun projectMap(
    input: Map<*, *>,
    containerLevel: Int,
    state: ProjectionState,
): Projected {
    val iterator = try {
        input.entries.iterator()
    } catch (_: Throwable) {
        return Projected.Unsupported
    }
    val output = LinkedHashMap<String, JsonElement>()

    while (true) {
        val hasNext = try {
            iterator.hasNext()
        } catch (_: Throwable) {
            state.truncated = true
            break
        }
        if (!hasNext) break
        if (!consumeChild(state)) break

        val entry = try {
            iterator.next()
        } catch (_: Throwable) {
            state.truncated = true
            break
        }
        val key = try {
            entry.key as? String
        } catch (_: Throwable) {
            state.truncated = true
            continue
        }
        if (key == null) {
            state.truncated = true
            continue
        }
        if (key.length > MAX_SCAN_UNITS) {
            state.truncated = true
            continue
        }

        val projectedKey = redactText(key, MAX_KEY_UNITS, state.redact)
        if (projectedKey.truncated) state.truncated = true
        if (!projectedKey.supported) {
            state.truncated = true
            continue
        }
        val outputKey = projectedKey.value
        if (output.containsKey(outputKey)) {
            state.truncated = true
            continue
        }
        if (isSensitiveKey(key)) {
            output[outputKey] = JsonPrimitive(REDACTED)
            continue
        }

        val child = try {
            entry.value
        } catch (_: Throwable) {
            state.truncated = true
            continue
        }
        val childLevel = if (isSupportedContainer(child)) containerLevel + 1 else containerLevel
        when (val projected = projectConsumedValue(child, childLevel, state)) {
            is Projected.Value -> output[outputKey] = projected.value
            Projected.Unsupported -> state.truncated = true
        }
    }
    return Projected.Value(JsonObject(output))
}

private fun projectList(
    input: List<*>,
    containerLevel: Int,
    state: ProjectionState,
): Projected {
    val iterator = try {
        input.iterator()
    } catch (_: Throwable) {
        return Projected.Unsupported
    }
    val output = ArrayList<JsonElement>()
    while (true) {
        val hasNext = try {
            iterator.hasNext()
        } catch (_: Throwable) {
            state.truncated = true
            break
        }
        if (!hasNext) break
        if (!consumeChild(state)) break
        val child = try {
            iterator.next()
        } catch (_: Throwable) {
            state.truncated = true
            output += JsonNull
            break
        }
        val childLevel = if (isSupportedContainer(child)) containerLevel + 1 else containerLevel
        when (val projected = projectConsumedValue(child, childLevel, state)) {
            is Projected.Value -> output += projected.value
            Projected.Unsupported -> {
                state.truncated = true
                output += JsonNull
            }
        }
    }
    return Projected.Value(JsonArray(output))
}

private inline fun projectIndexed(
    size: Int,
    containerLevel: Int,
    state: ProjectionState,
    read: (Int) -> Any?,
): Projected {
    val output = ArrayList<JsonElement>(minOf(size, MAX_NODES))
    var index = 0
    while (index < size) {
        if (!consumeChild(state)) break
        val child = read(index)
        val childLevel = if (isSupportedContainer(child)) containerLevel + 1 else containerLevel
        when (val projected = projectConsumedValue(child, childLevel, state)) {
            is Projected.Value -> output += projected.value
            Projected.Unsupported -> {
                state.truncated = true
                output += JsonNull
            }
        }
        index += 1
    }
    if (index < size) state.truncated = true
    return Projected.Value(JsonArray(output))
}

private fun consumeChild(state: ProjectionState): Boolean {
    if (state.nodes >= MAX_NODES) {
        state.truncated = true
        return false
    }
    state.nodes += 1
    return true
}

private fun isSupportedContainer(value: Any?): Boolean = when (value) {
    is Map<*, *>,
    is List<*>,
    is Array<*>,
    is BooleanArray,
    is ByteArray,
    is ShortArray,
    is IntArray,
    is LongArray,
    is FloatArray,
    is DoubleArray,
    -> true
    else -> false
}

private fun redactText(
    input: String,
    outputLimit: Int,
    redact: (String) -> String,
): ProjectedText {
    val scanned = normalizeTextUnits(input, MAX_SCAN_UNITS)
    val redacted = try {
        redact(scanned.value)
    } catch (_: Throwable) {
        return ProjectedText(supported = false, truncated = true)
    }
    val normalized = normalizeTextUnits(redacted, outputLimit)
    return ProjectedText(
        supported = true,
        value = normalized.value,
        truncated = scanned.changed || normalized.changed,
    )
}

private data class NormalizedText(val value: String, val changed: Boolean)

private fun normalizeTextUnits(input: String, limit: Int): NormalizedText {
    val output = StringBuilder(minOf(input.length, limit))
    var index = 0
    var changed = false
    while (index < input.length && index < limit) {
        val current = input[index]
        when {
            current == '\u0000' -> {
                output.append('\uFFFD')
                changed = true
                index += 1
            }
            current.isHighSurrogate() -> {
                val next = input.getOrNull(index + 1)
                if (next != null && next.isLowSurrogate()) {
                    if (index + 1 >= limit) {
                        changed = true
                        break
                    }
                    output.append(current).append(next)
                    index += 2
                } else {
                    output.append('\uFFFD')
                    changed = true
                    index += 1
                }
            }
            current.isLowSurrogate() -> {
                output.append('\uFFFD')
                changed = true
                index += 1
            }
            else -> {
                output.append(current)
                index += 1
            }
        }
    }
    if (index < input.length) changed = true
    return NormalizedText(output.toString(), changed)
}

private fun isSensitiveKey(key: String): Boolean {
    val canonicalKey = buildString {
        for (character in key) when (character) {
            in '0'..'9', in 'a'..'z' -> append(character)
            in 'A'..'Z' -> append((character.code + 32).toChar())
        }
    }
    return SENSITIVE_KEY_PARTS.any(canonicalKey::contains)
}

private fun fitMetadataToBytes(initial: CrashDetails): CrashDetails {
    if (fitsByteBudgets(initial)) return initial
    var details = initial.copy(truncated = true)
    while (!fitsByteBudgets(details)) {
        val metadata = details.metadata ?: break
        when (val action = lastTrimAction(metadata, emptyList())) {
            is TrimAction.Remove -> {
                val updated = replaceAtPath(metadata, action.path, null)
                details = details.copy(metadata = updated as? JsonObject)
            }
            is TrimAction.Shorten -> {
                var low = 0
                var high = action.original.length
                var best: JsonObject? = null
                while (low <= high) {
                    val middle = (low + high) / 2
                    val candidateText = normalizeTextUnits(action.original, middle).value
                    val candidate = replaceAtPath(metadata, action.path, JsonPrimitive(candidateText)) as JsonObject
                    if (fitsByteBudgets(details.copy(metadata = candidate))) {
                        best = candidate
                        low = middle + 1
                    } else {
                        high = middle - 1
                    }
                }
                if (best != null) return details.copy(metadata = best)
                details = details.copy(
                    metadata = replaceAtPath(metadata, action.path, JsonPrimitive("")) as JsonObject,
                )
            }
        }
    }
    return details
}

private fun encodedBytes(details: CrashDetails): Int =
    EnvelopeBuilder.JSON.encodeToString(CrashDetails.serializer(), details).toByteArray(Charsets.UTF_8).size

private fun fitsByteBudgets(details: CrashDetails): Boolean =
    encodedBytes(details) <= MAX_DETAILS_BYTES && javascriptEncodedBytes(details) <= MAX_DETAILS_BYTES

private fun javascriptEncodedBytes(details: CrashDetails): Int =
    javascriptEncodedBytes(EnvelopeBuilder.JSON.encodeToJsonElement(CrashDetails.serializer(), details))

private fun javascriptEncodedBytes(value: JsonElement): Int = when (value) {
    is JsonArray -> 2 + value.sumOf(::javascriptEncodedBytes) + maxOf(0, value.size - 1)
    is JsonObject -> 2 + value.entries.sumOf { (key, child) ->
        JsonPrimitive(key).toString().toByteArray(Charsets.UTF_8).size + 1 + javascriptEncodedBytes(child)
    } + maxOf(0, value.size - 1)
    is JsonPrimitive -> when {
        value.isString -> value.toString().toByteArray(Charsets.UTF_8).size
        value is JsonNull -> 4
        value.content == "true" -> 4
        value.content == "false" -> 5
        else -> esNumberText(value.content.toDouble()).toByteArray(Charsets.UTF_8).size
    }
}

private sealed interface PathPart {
    data class Key(val value: String) : PathPart
    data class Index(val value: Int) : PathPart
}

private sealed interface TrimAction {
    val path: List<PathPart>
    data class Remove(override val path: List<PathPart>) : TrimAction
    data class Shorten(override val path: List<PathPart>, val original: String) : TrimAction
}

private fun lastTrimAction(value: JsonElement, path: List<PathPart>): TrimAction = when (value) {
    is JsonArray -> {
        if (value.isEmpty()) TrimAction.Remove(path) else {
            val index = value.lastIndex
            lastTrimAction(value[index], path + PathPart.Index(index))
        }
    }
    is JsonObject -> {
        if (value.isEmpty()) TrimAction.Remove(path) else {
            val key = value.keys.last()
            lastTrimAction(value.getValue(key), path + PathPart.Key(key))
        }
    }
    is JsonPrimitive -> if (value.isString && value.content.isNotEmpty()) {
        TrimAction.Shorten(path, value.content)
    } else {
        TrimAction.Remove(path)
    }
}

private fun replaceAtPath(
    value: JsonElement,
    path: List<PathPart>,
    replacement: JsonElement?,
): JsonElement? {
    if (path.isEmpty()) return replacement
    val tail = path.drop(1)
    return when (val head = path.first()) {
        is PathPart.Key -> {
            val source = value as JsonObject
            val output = LinkedHashMap(source)
            val child = replaceAtPath(source.getValue(head.value), tail, replacement)
            if (child == null) output.remove(head.value) else output[head.value] = child
            JsonObject(output)
        }
        is PathPart.Index -> {
            val source = value as JsonArray
            val output = source.toMutableList()
            val child = replaceAtPath(source[head.value], tail, replacement)
            if (child == null) output.removeAt(head.value) else output[head.value] = child
            JsonArray(output)
        }
    }
}
