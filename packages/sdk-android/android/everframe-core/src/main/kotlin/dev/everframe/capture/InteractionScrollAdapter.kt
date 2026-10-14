// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.View
import android.view.ViewTreeObserver
import java.lang.ref.WeakReference
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicReference
import kotlinx.serialization.json.*

/** Gesture origin is mandatory. Offset/layout notifications alone cannot create an interaction. */
class InteractionScrollAdapter internal constructor(
    private val recorder: InteractionEventRecorder,
    private val clock: () -> Long = SystemClock::elapsedRealtime,
) {
    companion object { val shared by lazy { InteractionScrollAdapter(sharedInteractionRecorder) } }
    private class Gesture(owner: InteractionOwner, val axis: String, val start: Int, var last: Int, var time: Long) {
        val host = owner.host!!
        val owner = AtomicReference<InteractionOwner?>(owner)
        var moved = false
        var listener: ViewTreeObserver.OnScrollChangedListener? = null
    }
    private val gestures = CopyOnWriteArrayList<Gesture>()
    internal val retainedHosts: Int get() = gestures.size
    init {
        recorder.onRevoked {
            val old = gestures.toList(); gestures.clear()
            // Drop metadata immediately on the purge thread; UI cleanup carries weak hosts only.
            old.forEach { it.owner.set(null) }
            Handler(Looper.getMainLooper()).post { old.forEach { detach(it) } }
        }
    }
    fun began(view: View, axis: String) {
        if (axis !in setOf("x", "y") || recorder.suppresses(view, "scroll")) return
        finished(view)
        val owner = recorder.owner(view) ?: return
        if (gestures.size >= 32) gestures.firstOrNull()?.let { remove(it, cancel = true) }
        val position = if (axis == "x") view.scrollX else view.scrollY
        val gesture = Gesture(owner, axis, position, position, clock())
        recorder.retainIfCurrent(owner) { gestures.add(gesture) }
    }
    /** Additive native offset listener, used for remote-driven smooth scrolling. */
    fun remoteBegan(view: View, axis: String) {
        if (gestures.any { it.host.get() === view && clock() - it.time < 200 }) return
        began(view, axis)
        val gesture = gestures.lastOrNull { it.host.get() === view } ?: return
        val weak = WeakReference(view)
        val listener = ViewTreeObserver.OnScrollChangedListener { weak.get()?.let { moved(it) } }
        gesture.listener = listener; view.viewTreeObserver.addOnScrollChangedListener(listener)
        // One cleanup chain per remote gesture, retaining no strong view reference.
        fun cleanup() {
            if (gesture !in gestures) return
            if (clock() - gesture.time >= 200) remove(gesture, cancel = false)
            else Handler(Looper.getMainLooper()).postDelayed({ cleanup() }, 200)
        }
        Handler(Looper.getMainLooper()).postDelayed({ cleanup() }, 200)
    }
    fun moved(view: View) {
        val gesture = gestures.firstOrNull { it.host.get() === view } ?: return
        if (!view.isAttachedToWindow || recorder.suppresses(view, "scroll")) { remove(gesture, cancel = true); return }
        if (gesture.moved && clock() - gesture.time >= 200) { remove(gesture, cancel = false); return }
        val position = if (gesture.axis == "x") view.scrollX else view.scrollY
        if (position == gesture.last) return
        gesture.last = position; gesture.time = clock(); gesture.moved = true
        if (position == gesture.start) { recorder.cancel(view, "scroll"); return }
        val event = nativeInteractionEvent("scroll", JsonObject(mapOf("axis" to JsonPrimitive(gesture.axis),
            "direction" to JsonPrimitive(if (position > gesture.start) "forward" else "backward"))))
        val owner = gesture.owner.get() ?: return
        recorder.observe(InteractionObservation(owner, event))
    }
    fun endDrag(view: View) {
        moved(view)
        // A drag that never changed the offset cannot have momentum. End its
        // ownership now so a later app scroll cannot become a user gesture.
        gestures.firstOrNull { it.host.get() === view && !it.moved }?.let { remove(it, cancel = true) }
    }
    fun finished(view: View) {
        val gesture = gestures.firstOrNull { it.host.get() === view } ?: return
        if (gesture.moved) recorder.complete(view, "scroll", "end")
        remove(gesture, cancel = false)
    }
    fun dispose() { gestures.toList().forEach { remove(it, cancel = true) } }
    private fun remove(gesture: Gesture, cancel: Boolean) {
        gestures.remove(gesture)
        gesture.owner.set(null)
        detach(gesture)
        if (cancel) gesture.host.get()?.let { recorder.cancel(it, "scroll") }
    }
    private fun detach(gesture: Gesture) {
        gesture.host.get()?.let { view ->
            gesture.listener?.let { if (view.viewTreeObserver.isAlive) view.viewTreeObserver.removeOnScrollChangedListener(it) }
        }
    }
}
