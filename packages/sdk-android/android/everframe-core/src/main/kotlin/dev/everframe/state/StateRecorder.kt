// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.state
import dev.everframe.capture.EvidenceSequence
import dev.everframe.protocol.generated.*
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

internal class StateRecorder(private val now: () -> Double = { System.currentTimeMillis().toDouble() }, private val sequence: EvidenceSequence = EvidenceSequence.shared) {
    private val lock = ReentrantLock()
    private var state: ReportState? = null
    private var frozen: ReportState? = null
    private val customKeys = mutableSetOf<String>()
    private val automaticKeys = mutableSetOf<String>()
    private inline fun <reified T> bytes(value: T): Int = Json.encodeToString(value).toByteArray(Charsets.UTF_8).size
    fun reset(initial: StateSnapshot, startedAt: Double) = lock.withLock {
        frozen = null; customKeys.clear(); automaticKeys.clear()
        var safe = StateSnapshot(emptyMap(), emptyMap())
        for ((namespace, entries) in listOf(StateNamespace.Custom to initial.custom, StateNamespace.Automatic to initial.automatic)) {
            for ((key, raw) in entries.toSortedMap()) {
                if (!StateSanitizer.validKey(key)) continue
                val value = StateSanitizer.value(raw, key) ?: continue
                val next = applying(safe, namespace, key, value)
                if (next.custom.size <= 50 && next.automatic.size <= 32 && bytes(next) <= 8192) safe = next
            }
        }
        customKeys.addAll(safe.custom.keys); automaticKeys.addAll(safe.automatic.keys)
        state = ReportState(startedAt, emptyList(), null, safe, 0, safe, startedAt)
    }
    fun set(key: String, value: StateValue, namespace: StateNamespace = StateNamespace.Custom): Boolean {
        if (!StateSanitizer.validKey(key)) return false
        return change(key, StateSanitizer.value(value, key) ?: return false, namespace)
    }
    fun clear(key: String, namespace: StateNamespace = StateNamespace.Custom): Boolean =
        if (StateSanitizer.validKey(key)) change(key, null, namespace) else false
    private fun applying(base: StateSnapshot, namespace: StateNamespace, key: String, value: StateValue?): StateSnapshot {
        val map = (if (namespace == StateNamespace.Custom) base.custom else base.automatic).toMutableMap()
        if (value == null) map.remove(key) else map[key] = value
        return if (namespace == StateNamespace.Custom) base.copy(custom = map.toMap()) else base.copy(automatic = map.toMap())
    }
    private fun change(key: String, value: StateValue?, namespace: StateNamespace): Boolean = lock.withLock {
        val old = state ?: return false
        val previous = (if (namespace == StateNamespace.Custom) old.current.custom else old.current.automatic)[key]
        if (previous == value) return false
        val known = if (namespace == StateNamespace.Custom) customKeys else automaticKeys
        if (value != null && key !in known && known.size >= if (namespace == StateNamespace.Custom) 50 else 32) return false
        val current = applying(old.current, namespace, key, value)
        if (bytes(current.custom) > 8192) return false
        val t = now()
        val entry = StateChange(key, namespace, if (value == null) StateOperation.Clear else StateOperation.Set, sequence.next(), t, value)
        var candidate = old.copy(capturedAt = t, changes = old.changes + entry, current = current)
        while (candidate.changes.size > 100 || bytes(candidate) > 32512) {
            val first = candidate.changes.firstOrNull() ?: return false
            val values = applying(candidate.checkpoint?.values ?: candidate.initial, first.namespace, first.key, first.value)
            candidate = candidate.copy(changes = candidate.changes.drop(1), checkpoint = StateCheckpoint(first.t, first.seq, values), droppedChanges = candidate.droppedChanges + 1)
        }
        state = candidate; known.add(key); true
    }
    fun snapshot(capturedAt: Double): ReportState? = lock.withLock { state?.copy(capturedAt = capturedAt) }
    fun freeze(capturedAt: Double) = lock.withLock { if (frozen == null) frozen = state?.copy(capturedAt = capturedAt) }
    fun discardFrozen() = lock.withLock { frozen = null }
    fun takeFrozen(): ReportState? = lock.withLock { frozen.also { frozen = null } }
    fun erase() = lock.withLock { state = null; frozen = null; customKeys.clear(); automaticKeys.clear() }
}
