// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
@file:Suppress("INVISIBLE_REFERENCE", "INVISIBLE_MEMBER")
package dev.everframe.rn

import android.app.Activity
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.LinearLayout
import com.facebook.react.bridge.*
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.events.*
import com.facebook.react.views.textinput.ReactEditText
import com.facebook.react.views.textinput.ReactTextInputManager
import com.facebook.react.views.switchview.ReactSwitchManager
import com.facebook.react.views.switchview.ReactSwitch
import com.facebook.react.views.scroll.ReactScrollView
import com.facebook.react.views.scroll.ReactScrollViewHelper
import dev.everframe.Everframe
import dev.everframe.capture.sharedBreadcrumbBuffer
import dev.everframe.capture.InteractionEvents
import dev.everframe.shared.SharedData
import kotlinx.serialization.json.*
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class) @Config(sdk = [29])
class RnInteractionEventObserverTest {
    private class Dispatcher : EventDispatcher {
        val listeners = mutableListOf<EventDispatcherListener>()
        var calls = 0
        override fun dispatchEvent(event: Event<*>) { calls++; listeners.toList().forEach { it.onEventDispatch(event) } }
        override fun dispatchAllEvents() = Unit
        override fun addListener(listener: EventDispatcherListener) { listeners.add(listener) }
        override fun removeListener(listener: EventDispatcherListener) { listeners.remove(listener) }
        override fun addBatchEventDispatchedListener(listener: BatchEventDispatchedListener) = Unit
        override fun removeBatchEventDispatchedListener(listener: BatchEventDispatchedListener) = Unit
        override fun onCatalystInstanceDestroyed() = Unit
    }
    private class Context(activity: Activity, val dispatcher: Dispatcher) : BridgeReactContext(activity), EventDispatcherProvider {
        override fun getEventDispatcher(): EventDispatcher = dispatcher
        override fun isBridgeless(): Boolean = true
    }
    private class TextManager : ReactTextInputManager() {
        fun attach(context: ThemedReactContext, view: ReactEditText) { addEventEmitters(context, view) }
    }
    private class NamedEvent(surface: Int, val name: String) : Event<NamedEvent>(surface, 2) {
        override fun getEventName() = name
        override fun getEventData(): WritableMap = throw AssertionError("Payload must not be inspected")
    }
    private lateinit var root: LinearLayout
    private lateinit var context: ThemedReactContext
    private lateinit var dispatcher: Dispatcher
    private lateinit var observer: RnInteractionEventObserver
    private val views = mutableMapOf<Int, View>()
    @Before fun setup() {
        val local = Class.forName("com.facebook.react.internal.featureflags.ReactNativeFeatureFlagsLocalAccessor").getDeclaredConstructor().apply { isAccessible = true }.newInstance()
        Class.forName("com.facebook.react.internal.featureflags.ReactNativeFeatureFlags").getDeclaredField("accessor").apply { isAccessible = true }.set(null, local)
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        com.facebook.react.uimanager.DisplayMetricsHolder.initDisplayMetrics(activity)
        root = LinearLayout(activity); activity.setContentView(root)
        SharedData.init(activity)
        Everframe::class.java.getDeclaredField("captureGate").apply { isAccessible = true }.setBoolean(null, true)
        sharedBreadcrumbBuffer.applyConfig(null); sharedBreadcrumbBuffer.clear()
        dispatcher = Dispatcher(); context = ThemedReactContext(Context(activity, dispatcher), activity, "test", 42)
        observer = RnInteractionEventObserver({ tag, _ -> views[tag] })
        observer.attach(dispatcher)
    }
    @After fun cleanup() {
        observer.close(); sharedBreadcrumbBuffer.clear()
        Everframe::class.java.getDeclaredField("captureGate").apply { isAccessible = true }.setBoolean(null, false)
    }
    @Test fun realTextManagerEmitsUserEditsButExcludesJsControlledUpdates() {
        val manager = TextManager(); val view = ReactEditText(context).apply { id = 2 }
        root.addView(view); views[2] = view; manager.attach(context, view)
        manager.receiveCommand(view, "setTextAndSelection", JavaOnlyArray.of(0, "programmatic", 0, 0))
        sharedBreadcrumbBuffer.freeze(); assertEquals(0, sharedBreadcrumbBuffer.takeFrozen()!!.size)
        view.text!!.replace(0, view.text!!.length, "typed")
        sharedBreadcrumbBuffer.freeze()
        val events = sharedBreadcrumbBuffer.takeFrozen()!!
        assertEquals(1, events.size); assertFalse(events.toString().contains("typed"))
        assertTrue(dispatcher.calls > 0)
    }
    @Test fun mixedHelperRegistrationPreservesAutomaticNativeTypingAndTargetMetadata() {
        val manager = TextManager(); val view = ReactEditText(context).apply { id = 2 }
        root.addView(view); views[2] = view; manager.attach(context, view)
        val bridge = RnInteractionEventRegistration({ views[it] }, { it() })
        try {
            val lease = bridge.lease()
            assertTrue(bridge.set(2.0, "mixed", 1.0, lease,
                """{"helperTypes":["text_edit","control_change","scroll"],"target":{"name":"Search","testId":"search"}}"""))
            assertEquals(lease, bridge.lease())
            assertFalse(InteractionEvents.suppresses(view, "text_edit"))
            assertFalse(InteractionEvents.suppresses(view, "control_change"))
            assertFalse(InteractionEvents.suppresses(view, "scroll"))
            assertFalse(bridge.record(lease, "mixed", 1.0,
                """{"type":"text_edit","source":"app","observedAt":1,"length":31,"value":"SECRET","phase":"end"}"""))
            view.text!!.replace(0, view.text!!.length, "typed")
            sharedBreadcrumbBuffer.freeze()
            val event = sharedBreadcrumbBuffer.takeFrozen()!!.single().data!!
            assertEquals("text_edit", event["interaction"]!!.jsonObject["type"]!!.jsonPrimitive.content)
            assertEquals("native", event["interaction"]!!.jsonObject["source"]!!.jsonPrimitive.content)
            assertEquals(5, event["interaction"]!!.jsonObject["length"]!!.jsonPrimitive.int)
            assertEquals("Search", event["target"]!!.jsonObject["name"]!!.jsonPrimitive.content)
            assertFalse(event.toString().contains("SECRET"))
            assertTrue(dispatcher.calls > 0)
        } finally { bridge.close() }
    }
    @Test fun realSwitchManagerPreservesUserListenerAndExcludesPropChanges() {
        val manager = ReactSwitchManager()
        val view = manager.createView(4, context, null, null, null) as ReactSwitch
        root.addView(view); views[4] = view
        manager.setOn(view, true)
        assertEquals(0, sharedBreadcrumbBuffer.size)
        view.isChecked = false
        assertEquals(1, sharedBreadcrumbBuffer.size)
        assertTrue(dispatcher.calls > 0)
    }
    @Test fun legacyHelperRegistrationPreservesRealSwitchUserEventsAndAnnotations() {
        val manager = ReactSwitchManager()
        val view = manager.createView(4, context, null, null, null) as ReactSwitch
        root.addView(view); views[4] = view
        val bridge = legacyRegistration(4, "Notifications")
        try {
            manager.setOn(view, true)
            assertEquals(0, sharedBreadcrumbBuffer.size)
            view.isChecked = false
            sharedBreadcrumbBuffer.freeze()
            val event = sharedBreadcrumbBuffer.takeFrozen()!!.single().data!!
            assertEquals("control_change", event["interaction"]!!.jsonObject["type"]!!.jsonPrimitive.content)
            assertEquals("native", event["interaction"]!!.jsonObject["source"]!!.jsonPrimitive.content)
            assertFalse(event["interaction"]!!.jsonObject["checked"]!!.jsonPrimitive.boolean)
            assertEquals("Notifications", event["target"]!!.jsonObject["name"]!!.jsonPrimitive.content)
            assertTrue(dispatcher.calls > 0)
        } finally { bridge.close() }
    }
    @Test fun legacyHelperRegistrationPreservesRealScrollGestureAndAnnotations() {
        val view = ReactScrollView(context).apply { id = 2 }
        val child = View(context)
        view.addView(child, android.widget.FrameLayout.LayoutParams(200, 2000))
        root.addView(view, LinearLayout.LayoutParams(200, 200)); views[2] = view
        view.measure(View.MeasureSpec.makeMeasureSpec(200, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(200, View.MeasureSpec.EXACTLY))
        view.layout(0, 0, 200, 200); child.layout(0, 0, 200, 2000)
        val bridge = legacyRegistration(2, "Results")
        try {
            view.scrollTo(0, 50); ReactScrollViewHelper.emitScrollEvent(view, 0f, 0f)
            assertEquals(0, sharedBreadcrumbBuffer.size)
            ReactScrollViewHelper.emitScrollBeginDragEvent(view)
            view.scrollTo(0, 150); ReactScrollViewHelper.emitScrollEvent(view, 0f, 0f)
            ReactScrollViewHelper.emitScrollEndDragEvent(view, 0f, 0f)
            ReactScrollViewHelper.emitScrollMomentumEndEvent(view)
            sharedBreadcrumbBuffer.freeze()
            val event = sharedBreadcrumbBuffer.takeFrozen()!!.single().data!!
            assertEquals("scroll", event["interaction"]!!.jsonObject["type"]!!.jsonPrimitive.content)
            assertEquals("native", event["interaction"]!!.jsonObject["source"]!!.jsonPrimitive.content)
            assertEquals("forward", event["interaction"]!!.jsonObject["direction"]!!.jsonPrimitive.content)
            assertEquals("Results", event["target"]!!.jsonObject["name"]!!.jsonPrimitive.content)
            assertTrue(dispatcher.calls > 0)
        } finally { bridge.close() }
    }
    private fun legacyRegistration(tag: Int, name: String): RnInteractionEventRegistration {
        val bridge = RnInteractionEventRegistration({ views[it] }, { it() })
        assertTrue(bridge.set(tag.toDouble(), "legacy", 1.0, bridge.lease(),
            """{"helperTypes":["text_edit","control_change","scroll"],"target":{"name":"$name"}}"""))
        listOf("text_edit", "control_change", "scroll").forEach { assertFalse(InteractionEvents.suppresses(views[tag]!!, it)) }
        return bridge
    }
    @Test fun realInputConnectionCanCommitCompositionWithoutAnotherChangeEvent() {
        val manager = TextManager(); val view = ReactEditText(context).apply { id = 2 }
        root.addView(view); views[2] = view; manager.attach(context, view)
        val input = view.onCreateInputConnection(EditorInfo())!!
        input.setComposingText("draft", 1)
        val changes = dispatcher.calls
        input.finishComposingText()
        assertEquals(changes, dispatcher.calls)
        dispatcher.dispatchEvent(NamedEvent(42, "topSubmitEditing"))
        sharedBreadcrumbBuffer.freeze()
        val events = sharedBreadcrumbBuffer.takeFrozen()!!
        assertEquals(1, events.size)
        assertFalse(events.toString().contains("draft"))
    }
    @Test fun wrongSurfaceUnknownEventsAndDisposedObserverCannotAddEvidence() {
        val view = ReactEditText(context).apply { id = 2 }; root.addView(view); views[2] = view
        fun event(surface: Int, name: String) = NamedEvent(surface, name)
        view.setText("PRIVATE")
        dispatcher.dispatchEvent(event(99, "topChange"))
        dispatcher.dispatchEvent(event(42, "topSelectionChange"))
        observer.close(); dispatcher.dispatchEvent(event(42, "topChange"))
        sharedBreadcrumbBuffer.freeze(); assertEquals(0, sharedBreadcrumbBuffer.takeFrozen()!!.size)
        assertTrue(dispatcher.listeners.isEmpty())
    }
}
