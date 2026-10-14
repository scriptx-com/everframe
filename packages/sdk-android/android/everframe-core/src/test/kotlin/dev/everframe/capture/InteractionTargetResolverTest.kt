// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

import android.content.Context
import android.view.View
import android.view.KeyEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.*
import androidx.test.core.app.ApplicationProvider
import dev.everframe.Everframe
import dev.everframe.R
import dev.everframe.shared.SharedData
import kotlinx.serialization.json.*
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class InteractionTargetResolverTest {
    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private var adapter: AutoCloseable? = null
    @Before fun setup() {
        SharedData.init(context)
        Everframe.captureGate = true
        sharedBreadcrumbBuffer.applyConfig(null)
        sharedBreadcrumbBuffer.clear()
        InteractionTargetScreenState.reset()
        PressCrumbRateLimiter.__resetForTesting()
    }
    @After fun cleanup() {
        adapter?.close()
        Everframe.captureGate = false
        sharedBreadcrumbBuffer.clear()
        InteractionTargetScreenState.reset()
    }
    private fun target(view: View) = InteractionTargetResolver.resolve(view).data["target"]!!.jsonObject
    private fun hint(view: View, id: String? = null, role: String? = null) {
        adapter = InteractionTargetViewAdapters.register { candidate ->
            if (candidate === view) InteractionTargetViewHints(testId = id, role = role) else null
        }
    }
    @Test fun imageTapResolvesPosterOwnerInsteadOfImageClass() {
        val parent = FrameLayout(context).apply { isClickable = true; contentDescription = "Low Orbit" }
        val image = ImageView(context); parent.addView(image)
        hint(parent, "poster-low-orbit", "button")
        InteractionTargetScreenState.recordExplicit("Home")
        assertEquals(Json.parseToJsonElement("""{"testId":"poster-low-orbit","role":"button","name":"Low Orbit","nameFrom":"accessibility","screen":"Home"}"""), target(image))
    }
    @Test fun sensitiveLeafCannotLeakItsPublicParentsIdentity() {
        val parent = FrameLayout(context).apply { isClickable = true; contentDescription = "SECRET-PARENT" }
        val leaf = ImageView(context).apply { setTag(R.id.tx_sensitive, true) }; parent.addView(leaf)
        hint(parent, "SECRET-ID", "button")
        InteractionTargetScreenState.recordExplicit("SECRET-SCREEN")
        val snapshot = InteractionTargetResolver.resolve(leaf)
        assertEquals("[masked]", snapshot.label)
        assertEquals(Json.parseToJsonElement("""{"role":"button","masked":true}"""), snapshot.data["target"])
        assertFalse(snapshot.data.toString().contains("SECRET"))
        assertFalse(snapshot.data.containsKey("view"))
    }
    @Test fun sensitiveAncestorAboveSearchBudgetStillMasks() {
        val root = FrameLayout(context).apply { setTag(R.id.tx_sensitive, true) }
        var last = root
        repeat(40) { val child=FrameLayout(context); last.addView(child); last=child }
        last.contentDescription = "SECRET"
        assertEquals(JsonPrimitive(true), target(last)["masked"])
    }
    @Test fun textInsideControlWinsButHiddenSensitiveAndEditableTextDoNot() {
        val parent=FrameLayout(context).apply { isClickable=true }
        parent.addView(TextView(context).apply { text="HIDDEN"; visibility=View.GONE })
        parent.addView(TextView(context).apply { text="PRIVATE"; setTag(R.id.tx_sensitive,true) })
        parent.addView(EditText(context).apply { setText("PASSWORD") })
        parent.addView(TextView(context).apply { text="Home" })
        hint(parent,"tab-home","tab")
        assertEquals(JsonPrimitive("Home"),target(parent)["name"])
        assertEquals(JsonPrimitive("text"),target(parent)["nameFrom"])
        assertEquals(JsonPrimitive("tab"),target(parent)["role"])
    }
    @Test fun unknownRoleIsAbsentAndEditableValueIsNeverName() {
        assertFalse(target(View(context)).containsKey("role"))
        val input=EditText(context).apply { setText("PRIVATE VALUE") }
        assertFalse(target(input).toString().contains("PRIVATE VALUE"))
        assertEquals(JsonPrimitive("textfield"),target(input)["role"])
    }
    @Test fun descendantTextHasVisitAndDepthBudgets() {
        val parent=FrameLayout(context).apply { isClickable=true }
        repeat(64) { parent.addView(View(context)) }
        parent.addView(TextView(context).apply { text="TOO FAR" })
        assertFalse(target(parent).toString().contains("TOO FAR"))
        var last=FrameLayout(context); val root=last.apply { isClickable=true }
        repeat(7) { val next=FrameLayout(context); last.addView(next); last=next }
        last.addView(TextView(context).apply { text="TOO DEEP" })
        assertFalse(target(root).toString().contains("TOO DEEP"))
    }
    @Test fun containerDoesNotInventCountFromMountedViews() {
        val list=FrameLayout(context).apply { contentDescription="Originals" }
        val card=Button(context).apply { text="Low Orbit" }; list.addView(card)
        repeat(2) { list.addView(Button(context)) }
        hint(list, "originals", "list")
        val collection=target(card)["container"]!!.jsonObject
        assertEquals(JsonPrimitive("Originals"),collection["name"])
        assertFalse(collection.containsKey("count"))
        assertEquals(JsonPrimitive("Low Orbit"),target(card)["name"])
    }
    @Test fun truthfulCollectionCountsAndItemIndexSurviveBuffer() {
        val list=FrameLayout(context).apply {
            accessibilityDelegate=object: View.AccessibilityDelegate() {
                override fun onInitializeAccessibilityNodeInfo(host:View,info:AccessibilityNodeInfo) {
                    super.onInitializeAccessibilityNodeInfo(host,info)
                    info.collectionInfo=AccessibilityNodeInfo.CollectionInfo.obtain(1,12,false)
                }
            }
        }
        val card=Button(context).apply {
            text="Low Orbit"
            accessibilityDelegate=object: View.AccessibilityDelegate() {
                override fun onInitializeAccessibilityNodeInfo(host:View,info:AccessibilityNodeInfo) {
                    super.onInitializeAccessibilityNodeInfo(host,info)
                    info.collectionItemInfo=AccessibilityNodeInfo.CollectionItemInfo.obtain(0,1,4,1,false)
                }
            }
        }; list.addView(card)
        TapBreadcrumbAdapter.recordTap(card)
        sharedBreadcrumbBuffer.freeze()
        val collection=sharedBreadcrumbBuffer.takeFrozen()!!.last().data!!["target"]!!.jsonObject["container"]!!.jsonObject
        assertEquals(JsonPrimitive(4),collection["index"])
        assertEquals(JsonPrimitive(12),collection["count"])
    }
    @Test fun remoteRetainsStableIdAndNoFocusStillRecordsButton() {
        val card=Button(context).apply { text="Low Orbit" }; hint(card,"poster-low-orbit","button")
        TapBreadcrumbAdapter.recordRemotePress(KeyEvent.KEYCODE_DPAD_CENTER,card)
        TapBreadcrumbAdapter.recordRemotePress(KeyEvent.KEYCODE_DPAD_LEFT,null)
        sharedBreadcrumbBuffer.freeze(); val crumbs=sharedBreadcrumbBuffer.takeFrozen()!!
        assertEquals(JsonPrimitive("poster-low-orbit"),crumbs[0].data!!["id"])
        assertEquals(JsonPrimitive("poster-low-orbit"),crumbs[0].data!!["target"]!!.jsonObject["testId"])
        assertEquals(JsonPrimitive("left"),crumbs[1].data!!["button"])
    }
    @Test fun snapshotDoesNotChangeAfterNavigationOrViewMutation() {
        val card=Button(context).apply { text="Low Orbit" }
        InteractionTargetScreenState.recordExplicit("Home")
        val snapshot=InteractionTargetResolver.resolve(card)
        card.text="Next"; InteractionTargetScreenState.recordExplicit("Detail")
        assertEquals(JsonPrimitive("Home"),snapshot.data["target"]!!.jsonObject["screen"])
        assertEquals(JsonPrimitive("Low Orbit"),snapshot.data["target"]!!.jsonObject["name"])
    }
    @Test fun nativeScreenCannotOverwriteExplicitScreenAndResetClearsBoth() {
        InteractionTargetScreenState.recordNative("MainActivity")
        assertEquals("MainActivity",InteractionTargetScreenState.current())
        InteractionTargetScreenState.recordExplicit("Home")
        InteractionTargetScreenState.recordNative("MainActivity")
        assertEquals("Home",InteractionTargetScreenState.current())
        InteractionTargetScreenState.reset(); assertNull(InteractionTargetScreenState.current())
    }
    @Test fun boundedLabelsPreserveSurrogatePairs() {
        val view=Button(context).apply { contentDescription="a".repeat(255)+"😀" }
        assertEquals(JsonPrimitive("a".repeat(255)),target(view)["name"])
    }
    @Test fun disabledNavigationStillTracksExplicitScreenWithoutNavigationCrumbs() {
        sharedBreadcrumbBuffer.applyConfig(dev.everframe.config.BreadcrumbsConfigWire(true,listOf("tap"),100,65536,1024))
        Everframe.recordScreen("Home")
        TapBreadcrumbAdapter.recordTap(Button(context).apply { text="Play" })
        sharedBreadcrumbBuffer.freeze(); val crumbs=sharedBreadcrumbBuffer.takeFrozen()!!
        assertEquals(1,crumbs.size)
        assertEquals(JsonPrimitive("Home"),crumbs.single().data!!["target"]!!.jsonObject["screen"])
    }
    @Test fun windowDispatchSnapshotsBeforeDelegateNavigatesAndAlwaysDeliversInput() {
        val activity=org.robolectric.Robolectric.buildActivity(android.app.Activity::class.java).setup().get()
        val button=Button(context).apply { text="Low Orbit" }
        activity.setContentView(button)
        val decor=activity.window.decorView
        decor.measure(View.MeasureSpec.makeMeasureSpec(400,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(800,View.MeasureSpec.EXACTLY))
        decor.layout(0,0,400,800)
        val point=IntArray(2); button.getLocationInWindow(point)
        var delivered=0
        val delegate=object: android.view.Window.Callback by activity.window.callback {
            override fun dispatchTouchEvent(event:android.view.MotionEvent):Boolean {
                delivered++
                Everframe.recordScreen("Detail")
                (button.parent as? android.view.ViewGroup)?.removeView(button)
                return true
            }
        }
        Everframe.recordScreen("Home")
        val callback=TXWindowCallbackWrapper(delegate,activity)
        val event=android.view.MotionEvent.obtain(0,0,android.view.MotionEvent.ACTION_UP,point[0]+5f,point[1]+5f,0)
        assertTrue(callback.dispatchTouchEvent(event)); event.recycle()
        assertEquals(1,delivered)
        sharedBreadcrumbBuffer.freeze()
        val tap=sharedBreadcrumbBuffer.takeFrozen()!!.first { it.kind==dev.everframe.protocol.generated.BreadcrumbKind.Tap }
        assertEquals(JsonPrimitive("Home"),tap.data!!["target"]!!.jsonObject["screen"])
        assertEquals(JsonPrimitive("Low Orbit"),tap.data!!["target"]!!.jsonObject["name"])
    }
}
