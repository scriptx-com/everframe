// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.rn

import android.view.View
import dev.everframe.capture.InteractionTargetRegistry
import java.lang.ref.WeakReference
import java.util.UUID

/** Synchronous ownership cancellation, UI-only host resolution. Never waits for the UI thread. */
internal class RnInteractionTargetRegistration(
    private val resolve: (Int) -> View?,
    private val dispatch: (() -> Unit) -> Unit,
) : AutoCloseable {
    private class Request(val tag: Int, val generation: Long, val annotation: Map<String, Any?>) {
        var view: WeakReference<View>? = null
    }
    private val namespace = UUID.randomUUID().toString() + ":"
    private val requests = mutableMapOf<String, Request>()
    private var destroyed = false
    private fun integer(value: Double, maximum: Double) = value.isFinite() && value >= 0 && value <= maximum && value == value.toLong().toDouble()

    @Synchronized fun set(tag: Double, id: String, generation: Double, annotation: Map<String, Any?>): Boolean {
        if (destroyed || tag <= 0 || !integer(tag, Int.MAX_VALUE.toDouble()) || !integer(generation, 9007199254740990.0)) return false
        val key = namespace + id
        if (!InteractionTargetRegistry.beginSet(key, generation.toLong())) return false
        val request = Request(tag.toInt(), generation.toLong(), annotation)
        requests[id] = request
        enqueue(id, request)
        return true
    }
    private fun enqueue(id: String, request: Request) {
        try { dispatch {
            synchronized(this) {
                if (!destroyed && requests[id] === request) {
                    val view = runCatching { resolve(request.tag) }.getOrNull()
                    // A resolved host cannot migrate to a replacement using the same numeric tag.
                    if (view != null && (request.view == null || request.view?.get() === view)) {
                        request.view = WeakReference(view)
                        InteractionTargetRegistry.completeSet(view, namespace + id, request.generation, request.annotation)
                    }
                }
            }
        } } catch (_: Throwable) { InteractionTargetRegistry.clear(namespace + id, request.generation + 1) }
    }
    @Synchronized fun clear(id: String, generation: Double): Boolean {
        if (destroyed || !integer(generation, 9007199254740991.0)) return false
        val current = requests[id]
        if (current == null || generation > current.generation) requests.remove(id)
        InteractionTargetRegistry.clear(namespace + id, generation.toLong())
        return true
    }
    /** Provider configure may run after child ref attachment. Core start clears its registry. */
    @Synchronized fun onStarted() {
        if (!destroyed) requests.forEach { (id, request) ->
            if (InteractionTargetRegistry.beginSet(namespace + id, request.generation)) enqueue(id, request)
        }
    }
    @Synchronized override fun close() {
        destroyed = true
        requests.forEach { (id, request) -> InteractionTargetRegistry.clear(namespace + id, request.generation + 1) }
        requests.clear()
    }
}
