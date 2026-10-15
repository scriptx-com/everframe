// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

import android.view.View
import java.lang.ref.WeakReference
import kotlinx.serialization.json.JsonObject

/** Optional metadata only. clear/reset never inspect views, so ref cleanup can invalidate synchronously. */
object InteractionTargetRegistry {
    private data class Entry(val view: WeakReference<View>, val generation: Long, val annotation: JsonObject, val identity: List<Any?>)
    private val entries = mutableMapOf<String, Entry>()
    private val generations = mutableMapOf<String, Long>()
    private val pending = mutableMapOf<String, Long>()
    private var overflowed = false

    @Synchronized fun set(view: View, registrationId: String, generation: Long, annotation: Map<String, Any?>) {
        if (beginSet(registrationId, generation)) completeSet(view, registrationId, generation, annotation)
    }

    /** Called synchronously from the JS ref lifecycle; no view access or UI wait. */
    @Synchronized fun beginSet(registrationId: String, generation: Long): Boolean {
        if (!advance(registrationId, generation)) return false
        entries.remove(registrationId)
        pending[registrationId] = generation
        return true
    }

    /** Called on UI only after resolving the mounted view; reset/clear revoke pending work. */
    @Synchronized fun completeSet(view: View, registrationId: String, generation: Long, annotation: Map<String, Any?>) {
        if (pending[registrationId] != generation) return
        pending.remove(registrationId)
        val value = normalize(annotation)
        entries.remove(registrationId)
        if (value == null) return
        entries.entries.removeAll { it.value.view.get() == null || it.value.view.get() === view }
        entries[registrationId] = Entry(WeakReference(view), generation, value, identity(view))
    }

    @Synchronized fun clear(registrationId: String, generation: Long) {
        if (advance(registrationId, generation)) { entries.remove(registrationId); pending.remove(registrationId) }
    }

    @Synchronized fun reset() { entries.clear(); generations.clear(); pending.clear(); overflowed = false }

    @Synchronized internal fun lookup(view: View): JsonObject? {
        val item = entries.entries.firstOrNull { it.value.view.get() === view } ?: return null
        if (item.value.identity != identity(view)) { entries.remove(item.key); return null }
        return item.value.annotation
    }

    private fun advance(id: String, generation: Long): Boolean {
        if (overflowed || id.isEmpty() || id.length > 256 || generation < 0 || generation > 9007199254740991L) return false
        if (generation <= (generations[id] ?: -1L)) return false
        // Never evict a tombstone and accidentally permit delayed work to resurrect it.
        if (id !in generations && generations.size >= 4096) {
            overflowed = true; entries.clear(); generations.clear(); pending.clear(); return false
        }
        generations[id] = generation
        return true
    }

    private fun identity(view: View): List<Any?> {
        val hints = InteractionTargetViewAdapters.describe(view)
        // Native clipping/reordering does not revoke a React ref. Ownership is
        // cancelled synchronously by clear before host recycling; only this
        // host's semantic identity is a defensive fallback here.
        return listOf(view.id, hints?.testId, hints?.role, view.contentDescription?.toString())
    }

    private fun normalize(input: Map<String, Any?>): JsonObject? {
        fun fields(map: Map<*, *>): MutableMap<String, Any?> {
            val result = linkedMapOf<String, Any?>()
            for (key in listOf("testId", "name", "role")) targetText(map[key] as? String, if (key == "role") 64 else 256)?.let { result[key] = it }
            return result
        }
        fun position(value: Any?): Long? {
            val number = (value as? Number)?.toDouble() ?: return null
            return if (number.isFinite() && number >= 0 && number <= 9007199254740991.0 && number == number.toLong().toDouble()) number.toLong() else null
        }
        val result = fields(input)
        if (input["devtoolsOrigin"] == true) result["devtoolsOrigin"] = true
        (input["reporterTrigger"] as? String)?.takeIf { it == "button" || it == "menu" }
            ?.let { result["reporterTrigger"] = it }
        (input["container"] as? Map<*, *>)?.let { container ->
            val nested = fields(container)
            val index = position(container["index"]); val count = position(container["count"])
            if (index == null || count == null || index < count) {
                if (index != null) nested["index"] = index
                if (count != null) nested["count"] = count
            }
            if (nested.isNotEmpty()) result["container"] = nested
        }
        return if (result.isEmpty()) null else BreadcrumbRingBuffer.coerceHostData(result)
    }
}
