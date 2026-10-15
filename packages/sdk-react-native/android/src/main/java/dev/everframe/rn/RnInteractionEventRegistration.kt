// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.rn

import android.view.View
import dev.everframe.capture.InteractionEvents
import dev.everframe.capture.PreparedInteraction
import java.lang.ref.WeakReference
import kotlinx.serialization.json.*

/** Queued work owns the original lease. A new runtime cannot renew old refs or callbacks. */
internal class RnInteractionEventRegistration(
    private val resolve: (Int) -> View?,
    private val dispatch: (() -> Unit) -> Unit,
) : AutoCloseable {
    private class Request(val tag: Int, val generation: Long, val lease: String, val types: Set<String>) {
        var view: WeakReference<View>? = null
        var resolved = false
        var listener: View.OnAttachStateChangeListener? = null
    }
    val runtime = InteractionEvents.openRuntime()
    private val namespace = "$runtime:"
    private val requests = mutableMapOf<String, Request>()
    private class PendingRecord(val item: PreparedInteraction, val id: String, val generation: Long)
    private val records = ArrayDeque<PendingRecord>()
    private var recordDrainScheduled = false
    @Volatile private var closed = false
    fun active(): Boolean = !closed && InteractionEvents.ownsRuntime(runtime)
    fun lease(): String = if (active()) InteractionEvents.lease() ?: "" else ""
    private fun integer(value: Double, max: Double) = value.isFinite() && value >= 0 && value <= max && value == value.toLong().toDouble()
    private fun validId(id: String) = id.isNotEmpty() && id.length <= 128 && id.none { it.code < 32 || it.code == 127 }
    @Synchronized fun set(tag: Double, id: String, generation: Double, lease: String, json: String): Boolean {
        if (!active() || !validId(id) || tag <= 0 || !integer(tag,Int.MAX_VALUE.toDouble()) || !integer(generation,9007199254740990.0) || lease.isEmpty() || lease != lease()) return false
        if (json.toByteArray(Charsets.UTF_8).size > 8192) return false
        val options = runCatching { Json.parseToJsonElement(json) as? JsonObject }.getOrNull() ?: return false
        val list = options["helperTypes"] as? JsonArray ?: return false
        if (list.size > 3) return false
        val types = list.map { (it as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return false }.toSet()
        if (!setOf("text_edit","control_change","scroll").containsAll(types)) return false
        // JS callbacks have no immutable native privacy proof at observation.
        // Keep annotations while leaving all native automatic observation active.
        requests.filterValues { it.lease != lease }.values.forEach(::detachListener)
        requests.entries.removeAll { it.value.lease != lease }
        if (requests.size >= 4096 && !requests.containsKey(id)) return false
        if (!InteractionEvents.beginRegistration(namespace+id,generation.toLong(),lease,json)) return false
        val request = Request(tag.toInt(),generation.toLong(),lease,emptySet())
        requests.put(id,request)?.let(::detachListener); enqueue(id,request)
        return true
    }
    private fun enqueue(id: String, request: Request) {
        dispatch {
            synchronized(this) {
                if (!active() || request.lease != lease() || requests[id] !== request || request.resolved) return@dispatch
                val view = runCatching { resolve(request.tag) }.getOrNull() ?: return@dispatch
                if (!view.isAttachedToWindow || view.id != request.tag) return@dispatch
                request.view = WeakReference(view); request.resolved = true
                if (InteractionEvents.completeRegistration(view,namespace+id,request.generation,request.lease,request.types)) {
                    val owner = WeakReference(this)
                    val nativeId = namespace+id
                    val listener = object : View.OnAttachStateChangeListener {
                        override fun onViewAttachedToWindow(view: View) = Unit
                        override fun onViewDetachedFromWindow(view: View) {
                            view.removeOnAttachStateChangeListener(this)
                            InteractionEvents.cancelRegistration(nativeId,request.generation)
                            owner.get()?.let { bridge -> synchronized(bridge) { if (bridge.requests[id] === request) bridge.requests.remove(id) } }
                        }
                    }
                    request.listener = listener; view.addOnAttachStateChangeListener(listener)
                }
            }
        }
    }
    private fun detachListener(request: Request) {
        dispatch { request.listener?.let { request.view?.get()?.removeOnAttachStateChangeListener(it) }; request.listener = null }
    }
    @Synchronized fun onMount() {
        if (!active()) return
        requests.filterValues { it.lease != lease() }.values.forEach(::detachListener)
        requests.entries.removeAll { it.value.lease != lease() }
        requests.filterValues { !it.resolved }.forEach { (id,request) -> enqueue(id,request) }
    }
    @Synchronized fun clear(id: String, generation: Double): Boolean {
        if (!active() || !validId(id) || !integer(generation,9007199254740991.0)) return false
        if (!InteractionEvents.clearRegistration(namespace+id,generation.toLong())) return false
        requests.remove(id)?.let(::detachListener); return true
    }
    @Synchronized fun record(lease: String, id: String, generation: Double, json: String): Boolean {
        if (!active() || !integer(generation,9007199254740991.0) || (id.isNotEmpty() && !validId(id))) return false
        val prepared = InteractionEvents.prepare(lease,if (id.isEmpty()) "" else namespace+id,generation.toLong(),json) ?: return false
        // Native coalescing/revocation can empty a prepared cell before main runs.
        // Bound those cells too, and enqueue only one callback for the mailbox.
        if (records.size == 64) InteractionEvents.discardPrepared(records.removeFirst().item)
        records.addLast(PendingRecord(prepared,id,generation.toLong()))
        if (!recordDrainScheduled) { recordDrainScheduled = true; scheduleRecordDrain() }
        return true
    }
    private fun scheduleRecordDrain() {
        val owner = WeakReference(this)
        dispatch { owner.get()?.drainRecords() }
    }
    private fun drainRecords() {
        // Yield after a bounded batch even if producers keep refilling the mailbox.
        repeat(64) {
            synchronized(this) {
                if (records.isEmpty()) return@repeat
                val pending = records.removeFirst()
                try {
                    if (!active()) return@repeat
                    if (pending.id.isNotEmpty()) {
                        val request = requests[pending.id] ?: return@repeat
                        val view = request.view?.get() ?: return@repeat
                        if (request.generation != pending.generation || resolve(request.tag) !== view) return@repeat
                    }
                    InteractionEvents.recordPrepared(pending.item)
                } finally { InteractionEvents.discardPrepared(pending.item) }
            }
        }
        synchronized(this) {
            if (records.isEmpty()) recordDrainScheduled = false else scheduleRecordDrain()
        }
    }
    @Synchronized override fun close() {
        closed = true
        records.forEach { InteractionEvents.discardPrepared(it.item) }; records.clear()
        requests.values.forEach(::detachListener); requests.clear(); InteractionEvents.closeRuntime(runtime)
    }
}
