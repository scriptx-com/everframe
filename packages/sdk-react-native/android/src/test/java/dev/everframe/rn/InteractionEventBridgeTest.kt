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
    private val options = """{"helperTypes":["text_edit"]}"""
    private val text = """{"type":"text_edit","source":"app","observedAt":1,"length":6,"value":"SECRET","phase":"end"}"""
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
    @Test fun aThousandSupersededChangesQueueOneDrainAndKeepTheLatestSummary() {
        val lease = bridge.lease(); assertTrue(bridge.set(2.0,"A",1.0,lease,options)); drain()
        repeat(1000) { index ->
            val change = """{"type":"text_edit","source":"app","observedAt":1,"length":${index+1},"phase":"change"}"""
            assertTrue(bridge.record(lease,"A",1.0,change))
        }
        assertEquals(1, queue.size)
        drain(); sharedBreadcrumbBuffer.freeze()
        assertTrue(sharedBreadcrumbBuffer.takeFrozen()!!.single().data.toString().contains("1000"))
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
        assertFalse(InteractionEvents.suppresses(field,"text_edit"))
        assertFalse(bridge.set(2.0,"A",1.0,lease,options))
    }
    @Test fun onlyAttachedHelperTypesSuppressAndQueuedEventsAreRevocable() {
        val lease = bridge.lease()
        assertTrue(bridge.set(2.0,"A",1.0,lease,options))
        assertFalse(InteractionEvents.suppresses(field,"text_edit")); drain()
        assertTrue(InteractionEvents.suppresses(field,"text_edit"))
        assertFalse(InteractionEvents.suppresses(field,"scroll"))
        assertTrue(bridge.record(lease,"A",1.0,text))
        sharedBreadcrumbBuffer.clear(); drain(); assertEquals(0,sharedBreadcrumbBuffer.size)
        assertFalse(bridge.record(lease,"A",1.0,text))
        assertFalse(bridge.set(2.0,"B",1.0,lease,options))
        assertFalse(bridge.record(lease,"",0.0,permission))
        assertTrue(bridge.record(bridge.lease(),"",0.0,permission)); drain(); assertEquals(1,sharedBreadcrumbBuffer.size)
    }
    @Test fun valuesAreStrippedBeforeQueueAndFinalHostMustStillMatch() {
        val lease = bridge.lease(); assertTrue(bridge.set(2.0,"A",1.0,lease,options)); drain()
        assertTrue(bridge.record(lease,"A",1.0,text)); drain()
        assertFalse(sharedBreadcrumbBuffer.snapshotForReport().toString().contains("SECRET"))
        sharedBreadcrumbBuffer.clear()
        val next = bridge.lease(); assertTrue(bridge.set(2.0,"A",2.0,next,options)); drain()
        assertTrue(bridge.record(next,"A",2.0,text)); root.removeView(field); drain()
        assertEquals(0,sharedBreadcrumbBuffer.size)
    }
    @Test fun invalidInputAndMissingHostsNeverSuppress() {
        val lease = bridge.lease()
        for (tag in listOf(0.0,-1.0,Double.NaN,1.5)) assertFalse(bridge.set(tag,"A",1.0,lease,options))
        for (json in listOf("{", "[]", "x".repeat(8193), """{"helperTypes":["unknown"]}""")) assertFalse(bridge.set(2.0,"A",1.0,lease,json))
        for (json in listOf("{","[]","x".repeat(8193),text)) assertFalse(bridge.record(lease,"",0.0,json))
        host = null; assertTrue(bridge.set(2.0,"A",1.0,lease,options)); drain()
        assertFalse(InteractionEvents.suppresses(field,"text_edit"))
        assertTrue(bridge.clear("A",2.0)); host = field; bridge.onMount(); drain()
        assertFalse(InteractionEvents.suppresses(field,"text_edit"))
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
        assertFalse(InteractionEvents.suppresses(field,"text_edit"))
        assertFalse(bridge.record(lease,"A",1.0,text))
        assertTrue(bridge.set(2.0,"A",2.0,lease,options)); drain()
        assertTrue(InteractionEvents.suppresses(field,"text_edit"))
    }
    @Test fun mountRetryCannotAttachAfterRevocationOrAdoptReusedTag() {
        val lease = bridge.lease(); host = null
        assertTrue(bridge.set(2.0,"A",1.0,lease,options)); drain()
        sharedBreadcrumbBuffer.clear(); host = field; bridge.onMount(); drain()
        assertFalse(InteractionEvents.suppresses(field,"text_edit"))
        val next = bridge.lease(); assertTrue(bridge.set(2.0,"A",2.0,next,options)); drain()
        root.removeView(field); host = EditText(root.context).also { it.id=2; root.addView(it) }
        assertFalse(bridge.record(next,"A",2.0,text)); bridge.onMount(); drain()
        assertEquals(0,sharedBreadcrumbBuffer.size)
        assertFalse(InteractionEvents.suppresses(host!!,"text_edit"))
    }
}
