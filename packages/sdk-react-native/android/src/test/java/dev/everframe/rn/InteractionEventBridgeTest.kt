// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.rn

import android.app.Activity
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import dev.everframe.Everframe
import dev.everframe.capture.InteractionEvents
import dev.everframe.capture.InteractionTextAdapter
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
    private val options = """{"helperTypes":["control_change"],"target":{"name":"Observed"}}"""
    private val text = """{"type":"text_edit","source":"app","observedAt":1,"length":6,"value":"SECRET","phase":"end"}"""
    private val control = """{"type":"control_change","source":"app","observedAt":1,"control":"picker","optionId":"private-choice","value":"SECRET"}"""
    private val scroll = """{"type":"scroll","source":"app","observedAt":1,"axis":"x","direction":"forward"}"""
    private val permission = """{"type":"permission","source":"app","observedAt":1,"permission":"camera","phase":"result","result":"granted"}"""
    private fun drain() { while(queue.isNotEmpty()) queue.removeFirst().invoke() }
    private fun nativeName(view: EditText = field): String? {
        org.robolectric.shadows.ShadowSystemClock.advanceBy(java.time.Duration.ofMillis(1001))
        val before = sharedBreadcrumbBuffer.size
        view.setText("typed")
        assertTrue(InteractionTextAdapter.shared.changed(view))
        InteractionTextAdapter.shared.ended(view)
        assertEquals(before + 1, sharedBreadcrumbBuffer.size)
        return sharedBreadcrumbBuffer.snapshotForReport().last().data!!["target"]?.jsonObject?.get("name")?.jsonPrimitive?.content
    }
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
    @Test fun legacyMaskedControlCannotEmitAfterUnmaskingBeforeTheUiDrain() {
        val view = android.widget.Switch(root.context).apply { id = 3 }
        root.addView(view); host = view
        val lease = bridge.lease()
        assertTrue(bridge.set(3.0, "masked", 1.0, lease, options)); drain()
        view.setTag(dev.everframe.R.id.tx_sensitive, true)
        var accepted = false
        Thread {
            accepted = bridge.record(lease, "masked", 1.0,
                """{"type":"control_change","source":"app","observedAt":1,"control":"switch","checked":true}""")
        }.apply { start(); join() }
        view.setTag(dev.everframe.R.id.tx_sensitive, null)
        drain()
        assertEquals(0, sharedBreadcrumbBuffer.size)
        assertFalse(accepted)
        assertFalse(InteractionEvents.suppresses(view, "control_change"))
        view.isChecked = true
        assertTrue(dev.everframe.capture.InteractionControlAdapter.shared.changed(view))
        val data = sharedBreadcrumbBuffer.snapshotForReport().single().data!!
        assertEquals("native", data["interaction"]!!.jsonObject["source"]!!.jsonPrimitive.content)
        assertEquals("Observed", data["target"]!!.jsonObject["name"]!!.jsonPrimitive.content)
    }
    @Test fun everyKnownLegacyListKeepsOnlyMetadataAndRejectsHostPayloads() {
        val lease = bridge.lease()
        val lists = listOf("[]", "[\"text_edit\"]", "[\"control_change\"]", "[\"scroll\"]",
            "[\"text_edit\",\"control_change\",\"scroll\"]", "[\"scroll\",\"scroll\"]")
        for ((index, list) in lists.withIndex()) {
            val generation = index + 1.0
            assertTrue(bridge.set(2.0, "A", generation, lease, """{"helperTypes":$list,"target":{"name":"Observed"}}""")); drain()
            assertEquals(lease, bridge.lease())
            for (type in listOf("text_edit", "control_change", "scroll")) assertFalse(type, InteractionEvents.suppresses(field, type))
            for (event in listOf(text, control, scroll)) assertFalse(bridge.record(lease, "A", generation, event))
            assertTrue(queue.isEmpty())
            assertEquals("Observed", nativeName())
        }
    }
    @Test fun malformedOrOversizedLegacyListsCannotInstallPartialAnnotations() {
        val lease = bridge.lease()
        for (json in listOf("{", "[]", "x".repeat(8193), """{"helperTypes":["text_edit","unknown","scroll"]}""",
            """{"helperTypes":["text_edit","scroll","scroll","scroll"]}""", """{"helperTypes":["control_change",5]}""",
            """{"helperTypes":"scroll"}""", """{"helperTypes":null}""")) {
            assertFalse(bridge.set(2.0, "A", 1.0, lease, json))
        }
        assertTrue(queue.isEmpty())
        assertNotEquals("Observed", nativeName())
        assertTrue(bridge.set(2.0, "A", 1.0, lease, options)); drain()
        assertEquals("Observed", nativeName())
    }
    @Test fun aThousandLifecycleEventsKeepMailboxAndDrainCallbacksBounded() {
        val lease = bridge.lease()
        var accepted = 0
        repeat(1000) { index ->
            val event = """{"type":"permission","source":"app","observedAt":1,"permission":"permission-$index","phase":"requested"}"""
            if (bridge.record(lease, "", 0.0, event)) accepted++
        }
        assertEquals(64, accepted)
        assertEquals(1, queue.size)
        drain()
        val events = sharedBreadcrumbBuffer.snapshotForReport().map { it.data!!["interaction"]!!.jsonObject }
        assertEquals(10, events.size) // Lifecycle budget still applies to a full mailbox.
        assertEquals("permission-0", events.first()["permission"]!!.jsonPrimitive.content)
        assertEquals("permission-9", events.last()["permission"]!!.jsonPrimitive.content)
        assertTrue(queue.isEmpty())
        org.robolectric.shadows.ShadowSystemClock.advanceBy(java.time.Duration.ofSeconds(10))
        assertTrue(bridge.record(lease, "", 0.0, permission))
        assertEquals(1, queue.size); drain()
        assertEquals("camera", sharedBreadcrumbBuffer.snapshotForReport().last().data!!["interaction"]!!.jsonObject["permission"]!!.jsonPrimitive.content)
    }
    @Test fun repeatedRevocationCannotAccumulateRecordCallbacks() {
        repeat(1000) {
            assertTrue(bridge.record(bridge.lease(),"",0.0,permission))
            sharedBreadcrumbBuffer.clear()
        }
        assertEquals(1,queue.size)
        drain(); assertEquals(0,sharedBreadcrumbBuffer.size)
    }
    @Test fun clearBeforeResolutionAndLateGenerationNeverAttachMetadata() {
        val lease = bridge.lease()
        assertTrue(bridge.set(2.0,"A",1.0,lease,options))
        assertTrue(bridge.clear("A",2.0)); drain()
        assertNotEquals("Observed", nativeName())
        assertFalse(bridge.set(2.0,"A",1.0,lease,options))
    }
    @Test fun annotationsAttachOnResolutionAndCaptureClearRevokesThem() {
        val lease = bridge.lease()
        assertTrue(bridge.set(2.0,"A",1.0,lease,options))
        assertNotEquals("Observed", nativeName()); drain()
        assertEquals("Observed", nativeName())
        sharedBreadcrumbBuffer.clear(); drain()
        assertNotEquals("Observed", nativeName())
        assertFalse(bridge.set(2.0,"B",1.0,lease,options))
        assertFalse(bridge.record(lease,"",0.0,permission))
        assertTrue(bridge.record(bridge.lease(),"",0.0,permission)); drain()
        assertEquals("permission", sharedBreadcrumbBuffer.snapshotForReport().last().data!!["interaction"]!!.jsonObject["type"]!!.jsonPrimitive.content)
    }
    @Test fun nonViewLinkPayloadIsSanitizedAndQueuedLifecycleEventsRemainRevocable() {
        val lease = bridge.lease()
        assertTrue(bridge.record(lease, "", 0.0,
            """{"type":"deep_link","source":"app","observedAt":1,"url":"https://example.com/SECRET?token=SECRET","delivery":"initial"}"""))
        drain()
        assertEquals("https://example.com", sharedBreadcrumbBuffer.snapshotForReport().single().data!!["interaction"]!!.jsonObject["url"]!!.jsonPrimitive.content)
        assertTrue(bridge.record(lease, "", 0.0, permission))
        sharedBreadcrumbBuffer.clear(); drain()
        assertEquals(0, sharedBreadcrumbBuffer.size)
    }
    @Test fun invalidInputAndMissingHostsNeverAttachMetadata() {
        val lease = bridge.lease()
        for (tag in listOf(0.0,-1.0,Double.NaN,1.5)) assertFalse(bridge.set(tag,"A",1.0,lease,options))
        for (json in listOf("{","[]","x".repeat(8193),control)) assertFalse(bridge.record(lease,"",0.0,json))
        host = null; assertTrue(bridge.set(2.0,"A",1.0,lease,options)); drain()
        assertNotEquals("Observed", nativeName())
        assertTrue(bridge.clear("A",2.0)); host = field; bridge.onMount(); drain()
        assertNotEquals("Observed", nativeName())
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
    @Test fun detachAndReattachSameObjectAndTagRequiresNewMetadataGeneration() {
        val lease = bridge.lease(); assertTrue(bridge.set(2.0,"A",1.0,lease,options)); drain()
        assertEquals("Observed", nativeName())
        root.removeView(field); root.addView(field)
        assertNotEquals("Observed", nativeName())
        assertFalse(bridge.set(2.0,"A",1.0,lease,options))
        assertTrue(bridge.set(2.0,"A",2.0,lease,options)); drain()
        assertEquals("Observed", nativeName())
    }
    @Test fun mountRetryCannotAttachAfterRevocationOrAdoptReusedTag() {
        val lease = bridge.lease(); host = null
        assertTrue(bridge.set(2.0,"A",1.0,lease,options)); drain()
        sharedBreadcrumbBuffer.clear(); host = field; bridge.onMount(); drain()
        assertNotEquals("Observed", nativeName())
        val next = bridge.lease(); assertTrue(bridge.set(2.0,"A",2.0,next,options)); drain()
        assertEquals("Observed", nativeName())
        root.removeView(field)
        val replacement = EditText(root.context).also { it.id=2; root.addView(it) }; host = replacement
        bridge.onMount(); drain()
        assertNotEquals("Observed", nativeName(replacement))
    }
}
