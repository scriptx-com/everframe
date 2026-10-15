// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.rn

import android.app.Activity
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import dev.everframe.Everframe
import dev.everframe.capture.InteractionEvents
import dev.everframe.capture.sharedBreadcrumbBuffer
import dev.everframe.shared.SharedData
import kotlinx.serialization.json.*
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class) @Config(sdk=[29])
class InteractionEventBridgeTest {
    private lateinit var root: LinearLayout
    private lateinit var field: EditText
    private var host: View? = null
    private lateinit var bridge: RnInteractionEventRegistration
    private val queue = ArrayDeque<()->Unit>()
    private val options = """{"helperTypes":["control_change"]}"""
    private val text = """{"type":"text_edit","source":"app","observedAt":1,"length":6,"value":"SECRET","phase":"end"}"""
    private val control = """{"type":"control_change","source":"app","observedAt":1,"control":"picker","optionId":"safe-option","value":"SECRET"}"""
    private val permission = """{"type":"permission","source":"app","observedAt":1,"permission":"camera","phase":"result","result":"granted"}"""
    private fun drain() { while(queue.isNotEmpty()) queue.removeFirst().invoke() }
    @Before fun setup() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        root = LinearLayout(activity); activity.setContentView(root)
        field = EditText(activity).apply { id = 2 }; root.addView(field); host = field
        SharedData.init(activity)
        Everframe::class.java.getDeclaredField("captureGate").apply { isAccessible=true }.setBoolean(null,true)
        sharedBreadcrumbBuffer.applyConfig(null); sharedBreadcrumbBuffer.clear()
        bridge = RnInteractionEventRegistration({ host }, { queue.add(it) })
    }
    @After fun cleanup() {
        bridge.close(); drain(); sharedBreadcrumbBuffer.clear()
        Everframe::class.java.getDeclaredField("captureGate").apply { isAccessible=true }.setBoolean(null,false)
    }
    @Test fun reservedTextIsExcludedAfterValidatingMixedAndDuplicateTypes() {
        val lease = bridge.lease()
        assertFalse(bridge.set(2.0, "A", 1.0, lease, """{"helperTypes":["text_edit","unknown","scroll"]}"""))
        assertFalse(bridge.set(2.0, "A", 1.0, lease, """{"helperTypes":["text_edit","scroll","scroll","scroll"]}"""))
        assertTrue(bridge.set(2.0, "A", 1.0, lease, """{"helperTypes":["text_edit","control_change","scroll"]}""")); drain()
        assertFalse(InteractionEvents.suppresses(field, "text_edit"))
        assertTrue(InteractionEvents.suppresses(field, "control_change"))
        assertTrue(InteractionEvents.suppresses(field, "scroll"))
        assertFalse(bridge.record(lease, "A", 1.0, text))
        assertTrue(bridge.record(lease, "A", 1.0, """{"type":"control_change","source":"app","observedAt":1,"control":"switch","checked":true}"""))
        assertTrue(bridge.record(lease, "A", 1.0, """{"type":"scroll","source":"app","observedAt":1,"axis":"x","direction":"forward"}"""))
        drain()
        assertEquals(listOf("control_change", "scroll"), sharedBreadcrumbBuffer.snapshotForReport().map { it.data!!["interaction"]!!.jsonObject["type"]!!.jsonPrimitive.content })
        assertTrue(bridge.set(2.0, "A", 2.0, lease, """{"helperTypes":["text_edit","scroll","scroll"]}""")); drain()
        assertFalse(InteractionEvents.suppresses(field, "text_edit"))
        assertFalse(InteractionEvents.suppresses(field, "control_change"))
        assertTrue(InteractionEvents.suppresses(field, "scroll"))
    }
    @Test fun textOnlyRegistrationKeepsMetadataAndNativeFallbackWithoutQueuingText() {
        val lease = bridge.lease()
        assertTrue(bridge.set(2.0, "text", 1.0, lease,
            """{"helperTypes":["text_edit"],"target":{"name":"Search"}}""")); drain()
        assertEquals(lease, bridge.lease())
        for (type in listOf("text_edit", "control_change", "scroll")) assertFalse(InteractionEvents.suppresses(field, type))
        assertFalse(bridge.record(lease, "text", 1.0, text))
        assertTrue(queue.isEmpty())
        field.setText("typed")
        assertTrue(dev.everframe.capture.InteractionTextAdapter.shared.changed(field))
        dev.everframe.capture.InteractionTextAdapter.shared.ended(field)
        val data = sharedBreadcrumbBuffer.snapshotForReport().single().data!!
        assertEquals("native", data["interaction"]!!.jsonObject["source"]!!.jsonPrimitive.content)
        assertEquals("Search", data["target"]!!.jsonObject["name"]!!.jsonPrimitive.content)
    }
    @Test fun aThousandSupportedControlsKeepMailboxAndDrainCallbacksBounded() {
        val lease = bridge.lease(); assertTrue(bridge.set(2.0,"A",1.0,lease,options)); drain()
        var accepted = 0
        repeat(1000) { index ->
            val change = """{"type":"control_change","source":"app","observedAt":1,"control":"picker","optionId":"option-$index"}"""
            if (bridge.record(lease,"A",1.0,change)) accepted++
        }
        assertEquals(64, accepted)
        assertEquals(1, queue.size)
        drain()
        val events = sharedBreadcrumbBuffer.snapshotForReport().map { it.data!!["interaction"]!!.jsonObject }
        assertEquals(20, events.size) // The semantic budget still applies to a full mailbox.
        assertEquals("option-0", events.first()["optionId"]!!.jsonPrimitive.content)
        assertEquals("option-19", events.last()["optionId"]!!.jsonPrimitive.content)
        assertTrue(queue.isEmpty())
        org.robolectric.shadows.ShadowSystemClock.advanceBy(java.time.Duration.ofSeconds(10))
        assertTrue(bridge.record(lease,"A",1.0,control))
        assertEquals(1, queue.size)
        drain()
        assertEquals("safe-option", sharedBreadcrumbBuffer.snapshotForReport().last().data!!["interaction"]!!.jsonObject["optionId"]!!.jsonPrimitive.content)
    }
    @Test fun repeatedRevocationCannotAccumulateRecordCallbacks() {
        repeat(1000) {
            assertTrue(bridge.record(bridge.lease(),"",0.0,permission))
            sharedBreadcrumbBuffer.clear()
        }
        assertEquals(1,queue.size)
        drain(); assertEquals(0,sharedBreadcrumbBuffer.size)
    }
    @Test fun clearBeforeResolutionAndLateGenerationNeverAttach() {
        val lease = bridge.lease()
        assertTrue(bridge.set(2.0,"A",1.0,lease,options))
        assertTrue(bridge.clear("A",2.0)); drain()
        assertFalse(InteractionEvents.suppresses(field,"control_change"))
        assertFalse(bridge.set(2.0,"A",1.0,lease,options))
    }
    @Test fun onlyAttachedHelperTypesSuppressAndQueuedEventsAreRevocable() {
        val lease = bridge.lease()
        assertTrue(bridge.set(2.0,"A",1.0,lease,options))
        assertFalse(InteractionEvents.suppresses(field,"control_change")); drain()
        assertTrue(InteractionEvents.suppresses(field,"control_change"))
        assertFalse(InteractionEvents.suppresses(field,"scroll"))
        assertTrue(bridge.record(lease,"A",1.0,control))
        sharedBreadcrumbBuffer.clear(); drain(); assertEquals(0,sharedBreadcrumbBuffer.size)
        assertFalse(bridge.record(lease,"A",1.0,control))
        assertFalse(bridge.set(2.0,"B",1.0,lease,options))
        assertFalse(bridge.record(lease,"",0.0,permission))
        assertTrue(bridge.record(bridge.lease(),"",0.0,permission)); drain(); assertEquals(1,sharedBreadcrumbBuffer.size)
    }
    @Test fun valuesAreStrippedBeforeQueueAndFinalHostMustStillMatch() {
        val lease = bridge.lease(); assertTrue(bridge.set(2.0,"A",1.0,lease,options)); drain()
        assertTrue(bridge.record(lease,"A",1.0,control)); drain()
        assertFalse(sharedBreadcrumbBuffer.snapshotForReport().toString().contains("SECRET"))
        sharedBreadcrumbBuffer.clear()
        val next = bridge.lease(); assertTrue(bridge.set(2.0,"A",2.0,next,options)); drain()
        assertTrue(bridge.record(next,"A",2.0,control)); root.removeView(field); drain()
        assertEquals(0,sharedBreadcrumbBuffer.size)
    }
    @Test fun invalidInputAndMissingHostsNeverSuppress() {
        val lease = bridge.lease()
        for (tag in listOf(0.0,-1.0,Double.NaN,1.5)) assertFalse(bridge.set(tag,"A",1.0,lease,options))
        for (json in listOf("{", "[]", "x".repeat(8193), """{"helperTypes":["unknown"]}""")) assertFalse(bridge.set(2.0,"A",1.0,lease,json))
        for (json in listOf("{","[]","x".repeat(8193),control)) assertFalse(bridge.record(lease,"",0.0,json))
        host = null; assertTrue(bridge.set(2.0,"A",1.0,lease,options)); drain()
        assertFalse(InteractionEvents.suppresses(field,"control_change"))
        assertTrue(bridge.clear("A",2.0)); host = field; bridge.onMount(); drain()
        assertFalse(InteractionEvents.suppresses(field,"control_change"))
    }
    @Test fun newerModuleOwnsRuntimeAndOldInvalidationCannotRevokeIt() {
        val old = bridge.lease()
        val newer = RnInteractionEventRegistration({host},{queue.add(it)})
        val lease = newer.lease(); assertNotEquals(old,lease)
        assertEquals("",bridge.lease()); bridge.close()
        assertEquals(lease,newer.lease())
        assertFalse(bridge.record(old,"",0.0,permission))
        assertTrue(newer.record(lease,"",0.0,permission)); drain(); assertEquals(1,sharedBreadcrumbBuffer.size)
        newer.close()
    }
    @Test fun detachAndReattachSameObjectAndTagRequiresNewGeneration() {
        val lease = bridge.lease(); assertTrue(bridge.set(2.0,"A",1.0,lease,options)); drain()
        root.removeView(field); root.addView(field)
        assertFalse(InteractionEvents.suppresses(field,"control_change"))
        assertFalse(bridge.record(lease,"A",1.0,control))
        assertTrue(bridge.set(2.0,"A",2.0,lease,options)); drain()
        assertTrue(InteractionEvents.suppresses(field,"control_change"))
    }
    @Test fun mountRetryCannotAttachAfterRevocationOrAdoptReusedTag() {
        val lease = bridge.lease(); host = null
        assertTrue(bridge.set(2.0,"A",1.0,lease,options)); drain()
        sharedBreadcrumbBuffer.clear(); host = field; bridge.onMount(); drain()
        assertFalse(InteractionEvents.suppresses(field,"control_change"))
        val next = bridge.lease(); assertTrue(bridge.set(2.0,"A",2.0,next,options)); drain()
        root.removeView(field); host = EditText(root.context).also { it.id=2; root.addView(it) }
        assertFalse(bridge.record(next,"A",2.0,control)); bridge.onMount(); drain()
        assertEquals(0,sharedBreadcrumbBuffer.size)
        assertFalse(InteractionEvents.suppresses(host!!,"control_change"))
    }
}
