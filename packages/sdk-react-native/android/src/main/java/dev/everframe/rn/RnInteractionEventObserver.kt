// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.rn

import android.os.Looper
import android.view.View
import android.widget.CompoundButton
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.events.Event
import com.facebook.react.uimanager.events.EventDispatcher
import com.facebook.react.uimanager.events.EventDispatcherListener
import com.facebook.react.views.textinput.ReactEditText
import dev.everframe.capture.InteractionTextAdapter
import dev.everframe.capture.InteractionControlAdapter
import dev.everframe.capture.InteractionScrollAdapter

/** Observes before JS dispatch. Never reads protected event payloads or replaces app callbacks. */
internal class RnInteractionEventObserver(private val resolve: (Int, Int) -> View?, private val active: () -> Boolean = { true }) : EventDispatcherListener, AutoCloseable {
    private var dispatcher: EventDispatcher? = null
    @Volatile private var closed = false
    fun attach(value: EventDispatcher) {
        if (closed || dispatcher === value) return
        dispatcher?.removeListener(this); dispatcher = value; value.addListener(this)
    }
    fun refresh(context: ReactApplicationContext) {
        UiThreadUtil.runOnUiThread { runCatching { UIManagerHelper.getEventDispatcher(context)?.let(::attach) } }
    }
    override fun onEventDispatch(event: Event<*>) {
        // Queuing an event would acquire ownership after a possible clear and retain raw payload.
        if (closed || !active() || Looper.myLooper() != Looper.getMainLooper()) return
        runCatching {
            val name = event.getEventName()
            if (name !in names) return
            val view = resolve(event.viewTag, event.surfaceId) ?: return
            if (!view.isAttachedToWindow || UIManagerHelper.getSurfaceId(view) != event.surfaceId) return
            when {
                view is ReactEditText -> when (name) {
                    "topChange" -> InteractionTextAdapter.shared.changed(view)
                    "topEndEditing" -> InteractionTextAdapter.shared.ended(view)
                    "topSubmitEditing" -> InteractionTextAdapter.shared.ended(view, submit = true)
                    else -> Unit
                }
                view is CompoundButton && view.javaClass.name == "com.facebook.react.views.switchview.ReactSwitch" && name == "topChange" -> InteractionControlAdapter.shared.changed(view)
                view.javaClass.name in scrollHosts -> when (name) {
                    "topScrollBeginDrag" -> InteractionScrollAdapter.shared.began(view, if (view is android.widget.HorizontalScrollView) "x" else "y")
                    "topScroll" -> InteractionScrollAdapter.shared.moved(view)
                    "topScrollEndDrag" -> InteractionScrollAdapter.shared.endDrag(view)
                    "topMomentumScrollEnd" -> InteractionScrollAdapter.shared.finished(view)
                    else -> Unit
                }
            }
        }
    }
    override fun close() {
        closed = true
        dispatcher?.removeListener(this); dispatcher = null
    }
    companion object {
        private val names = setOf("topChange", "topEndEditing", "topSubmitEditing", "topScrollBeginDrag", "topScroll", "topScrollEndDrag", "topMomentumScrollEnd")
        private val scrollHosts = setOf("com.facebook.react.views.scroll.ReactScrollView", "com.facebook.react.views.scroll.ReactHorizontalScrollView")
        fun install(context: ReactApplicationContext, active: () -> Boolean): RnInteractionEventObserver {
            val observer = RnInteractionEventObserver({ tag, _ -> UIManagerHelper.getUIManagerForReactTag(context, tag)?.resolveView(tag) }, active)
            observer.refresh(context)
            return observer
        }
    }
}
