// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

import android.app.Activity
import android.text.InputType
import android.widget.EditText
import android.widget.LinearLayout
import androidx.test.core.app.ApplicationProvider
import dev.everframe.Everframe
import dev.everframe.R
import dev.everframe.config.BreadcrumbsConfigWire
import dev.everframe.protocol.generated.BreadcrumbKind
import dev.everframe.shared.SharedData
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Before
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class InteractionEventRecorderTest {
    private lateinit var root: LinearLayout
    private lateinit var buffer: BreadcrumbRingBuffer
    private lateinit var recorder: InteractionEventRecorder
    private var now = 0L
    @Before fun setup() {
        SharedData.init(ApplicationProvider.getApplicationContext())
        Everframe.captureGate = true
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        root = LinearLayout(activity); activity.setContentView(root)
        buffer = BreadcrumbRingBuffer(100, true)
        recorder = InteractionEventRecorder(buffer, clock = { now }, schedule = { _, _ -> })
    }
    @After fun cleanup() { Everframe.captureGate = false; InteractionTargetRegistry.reset() }
    private fun field() = EditText(root.context).also { root.addView(it) }
    private fun text() = eventJson("text_edit", """"length":6,"value":"SECRET","reason":"idle"""")
    private fun observe(view: EditText, phase: String = "change", composing: Boolean = false) = recorder.observe(
        InteractionObservation(recorder.owner(view)!!, text(), phase, composing))

    @Test fun preparedAndDelayedSummariesShareThe32HostBound() {
        val lease = recorder.lease()!!
        repeat(17) { observe(field()) }
        val cells = (0 until 16).map { index ->
            val view = field(); val id = "queued-$index"
            assertTrue(recorder.register(view,id,1,lease,setOf("text_edit")))
            recorder.prepare(lease,id,1,"""{"type":"text_edit","source":"app","observedAt":1,"length":6}""")!!
        }
        assertEquals(32,recorder.pendingCount + cells.count { it.observation != null })
    }
    @Test fun bridgeCannotRetainValuesWithoutCurrentMainThreadPrivacyProof() {
        val view = field()
        // Resource IDs provide native identity without relying on annotation normalization.
        view.id = android.R.id.input
        recorder.configure(InteractionEventPolicy.parse("""{"valueTestIds":["input"]}""")); val lease = recorder.lease()!!
        assertTrue(recorder.register(view,"A",1,lease,setOf("text_edit")))
        val json = """{"type":"text_edit","source":"app","observedAt":1,"length":6,"value":"SECRET","phase":"end"}"""
        var queued: PreparedInteraction? = null
        val thread = Thread { queued = recorder.prepare(lease,"A",1,json) }; thread.start(); thread.join()
        assertFalse(queued?.observation?.event.toString().contains("SECRET"))
        view.transformationMethod = android.text.method.PasswordTransformationMethod.getInstance()
        val secure = recorder.prepare(lease,"A",1,json)
        assertFalse(secure?.observation?.event.toString().contains("SECRET"))
        if (secure != null) assertFalse(recorder.recordPrepared(secure))
    }
    @Test fun helperCannotFlushNativeComposingTextAndQueuedChangesKeepLatest() {
        val view = field(); val lease = recorder.lease()!!
        assertTrue(recorder.register(view,"A",1,lease,setOf("text_edit")))
        view.setText("composing")
        view.text.setSpan(Any(),0,view.text.length,android.text.Spanned.SPAN_COMPOSING)
        val json = """{"type":"text_edit","source":"app","observedAt":1,"length":9,"phase":"end"}"""
        assertTrue(recorder.recordPrepared(recorder.prepare(lease,"A",1,json)!!))
        recorder.flushReadyForFreeze(); assertEquals(0,buffer.size)
        view.text.clearSpans()
        repeat(1000) { index -> recorder.prepare(lease,"A",1,"""{"type":"text_edit","source":"app","observedAt":1,"length":$index}""") }
        val last = recorder.prepare(lease,"A",1,"""{"type":"text_edit","source":"app","observedAt":1,"length":1000}""")
        assertNotNull(last); assertTrue(recorder.recordPrepared(last!!)); now = 750; recorder.flushDue()
        assertEquals(1000,buffer.snapshotForReport().single().data!!["interaction"]!!.jsonObject["length"]!!.jsonPrimitive.int)
    }
    @Test fun bridgeCapturesSourceAtCallAndClearErasesQueueCell() {
        val view = field(); val lease = recorder.lease()!!
        InteractionTargetScreenState.recordExplicit("Mounted")
        assertTrue(recorder.register(view,"A",1,lease,setOf("text_edit")))
        InteractionTargetScreenState.recordExplicit("Source")
        val json = """{"type":"text_edit","source":"app","observedAt":1,"length":6,"phase":"end"}"""
        val item = recorder.prepare(lease,"A",1,json)!!
        InteractionTargetScreenState.recordExplicit("Destination")
        assertTrue(recorder.recordPrepared(item))
        assertEquals(JsonPrimitive("Source"),(buffer.snapshotForReport().last().data!!["target"] as JsonObject)["screen"])
        val queued = recorder.prepare(lease,"A",1,json)!!
        assertTrue(recorder.clearRegistration("A",2)); assertNull(queued.observation)
        InteractionTargetScreenState.reset()
    }
    @Test fun observerMetadataHasSeparateOwnershipAndCannotGrantValuePermission() {
        val view = field(); recorder.configure(InteractionEventPolicy.parse("""{"valueTestIds":["allowed"]}""")); val lease = recorder.lease()!!
        val options = """{"target":{"name":"Search control","testId":"allowed","screen":"forged"},"helperTypes":[]}"""
        assertTrue(recorder.beginRegistration("A",1,lease,options))
        assertTrue(recorder.completeRegistration(view,"A",1,lease,emptySet()))
        val owner = recorder.owner(view)!!
        assertEquals(JsonPrimitive("Search control"),owner.target!!["name"])
        assertNotEquals(JsonPrimitive("forged"),owner.target["screen"])
        assertFalse(recorder.allowsValue(owner,"text_edit"))
        assertTrue(recorder.clearRegistration("A",2))
        assertNotEquals(JsonPrimitive("Search control"),recorder.owner(view)!!.target!!["name"])
    }
    @Test fun thirtyThirdPendingHostEvictsWithoutEmission() {
        repeat(33) { observe(field()) }
        assertEquals(32, recorder.pendingCount)
        assertEquals(0, buffer.size)
        now = 750; recorder.flushDue()
        assertEquals(20, buffer.size)
        assertEquals(0, recorder.pendingCount)
    }

    @Test fun semanticAndLifecycleBudgetsLeaveExistingTapAndErrorAdmissionAlone() {
        repeat(21) { observe(field(), "end") }
        repeat(11) {
            recorder.observe(InteractionObservation(recorder.owner()!!, eventJson("permission", """"permission":"camera","phase":"requested"""")))
        }
        assertEquals(30, buffer.size)
        buffer.add(BreadcrumbKind.Tap, "tap"); buffer.add(BreadcrumbKind.Error, "error")
        assertEquals(32, buffer.size)
        now = 10_000
        observe(field(), "end")
        assertEquals(33, buffer.size)
    }

    @Test fun hostBudgetCombinesTextAndScrollAndAllowsOnePerSecond() {
        val view = field()
        observe(view, "end")
        val scroll = eventJson("scroll", """"axis":"y","direction":"forward"""")
        recorder.observe(InteractionObservation(recorder.owner(view)!!, scroll, "end"))
        assertEquals(1, buffer.size)
        now = 1000
        recorder.observe(InteractionObservation(recorder.owner(view)!!, scroll, "end"))
        assertEquals(2, buffer.size)
    }

    @Test fun secureMaskedDetachedAndComposingTextCannotBeFlushed() {
        val secure = field().apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }
        assertNull(recorder.owner(secure))
        val masked = field(); observe(masked); masked.setTag(R.id.tx_sensitive, true)
        val detached = field(); observe(detached); root.removeView(detached)
        val composing = field(); observe(composing, composing = true)
        now = 1000; recorder.flushReadyForFreeze()
        assertEquals(0, buffer.size)
        assertFalse(recorder.pendingDebugSnapshot().toString().contains("SECRET"))
    }

    @Test fun bufferFreezeSamplesSafePendingTextWithoutWaitingForJs() {
        observe(field())
        buffer.freeze()
        val event = buffer.takeFrozen()!!.single().data!!["interaction"]!!.jsonObject
        assertEquals("freeze", event["reason"]!!.jsonPrimitive.content)
        assertFalse(event.containsKey("value"))
    }

    @Test fun clearAndDisablePurgePendingAndPermanentlyRevokeOldOwners() {
        for (clear in listOf<() -> Unit>(
            { buffer.clear() },
            { buffer.applyConfig(BreadcrumbsConfigWire(false, listOf("custom"), 100, 65536, 1024)) },
            { recorder.revoke() },
            { buffer.rotate(2) },
        )) {
            buffer.applyConfig(null)
            val view = field(); val owner = recorder.owner(view)!!
            recorder.observe(InteractionObservation(owner, text()))
            clear()
            assertEquals(0, recorder.pendingCount)
            buffer.applyConfig(null)
            assertNotEquals(owner.lease, recorder.lease())
            assertFalse(recorder.observe(InteractionObservation(owner, text(), "end")))
            assertEquals(0, buffer.size)
        }
    }

    @Test fun liveKindDisableDropsPendingInsteadOfReplayingWhenReenabled() {
        observe(field())
        buffer.applyConfig(BreadcrumbsConfigWire(true, listOf("tap"), 100, 65536, 1024))
        buffer.applyConfig(null)
        now = 1000; recorder.flushDue()
        assertEquals(0, buffer.size)
    }

    @Test fun signoutRevokesSharedRecorderAndNewLeaseCannotBlessOldObservation() {
        sharedBreadcrumbBuffer.applyConfig(null); sharedBreadcrumbBuffer.clear()
        val owner = sharedInteractionRecorder.owner(field())!!
        sharedInteractionRecorder.observe(InteractionObservation(owner, text()))
        Everframe.setIdentityToken(null)
        assertEquals(0, sharedInteractionRecorder.pendingCount)
        assertNotEquals(owner.lease, sharedInteractionRecorder.lease())
        assertFalse(sharedInteractionRecorder.observe(InteractionObservation(owner, text(), "end")))
        assertEquals(0, sharedBreadcrumbBuffer.size)
    }

    @Test fun sustainedTypingArmsOneTimerAndClearDoesNotLetOldTimerFlushNewWork() {
        val timers = mutableListOf<() -> Unit>()
        recorder = InteractionEventRecorder(buffer, clock = { now }, schedule = { _, action -> timers.add(action) })
        val view = field()
        repeat(1000) { observe(view); now++ }
        assertEquals(1, timers.size)
        buffer.clear()
        observe(view)
        now += 1000
        timers.first().invoke()
        assertEquals(0, buffer.size)
        timers.last().invoke()
        assertEquals(1, buffer.size)
    }

    @Test fun registrationGenerationCannotResurrectOrSuppressAfterClear() {
        val view = field()
        val lease = recorder.lease()!!
        assertTrue(recorder.register(view, "ref", 1, lease, setOf("text_edit")))
        val owner = recorder.registeredOwner("ref", 1, lease)!!
        assertTrue(recorder.suppresses(view, "text_edit"))
        recorder.observe(InteractionObservation(owner, text()))
        recorder.clearRegistration("ref", 2)
        assertEquals(0, recorder.pendingCount)
        assertFalse(recorder.suppresses(view, "text_edit"))
        assertFalse(recorder.register(view, "ref", 1, lease, setOf("text_edit")))
        assertFalse(recorder.observe(InteractionObservation(owner, text(), "end")))
        assertTrue(recorder.register(view, "ref", 3, lease, setOf("text_edit")))
        buffer.clear()
        assertFalse(recorder.suppresses(view, "text_edit"))
        assertNull(recorder.registeredOwner("ref", 3, lease))
        assertFalse(recorder.register(view, "ref", 4, lease, setOf("text_edit")))
    }

    @Test fun observerRegistrationDoesNotAllowAnUnknownHostToCarryTextValues() {
        recorder.configure(InteractionEventPolicy.parse("""{"valueTestIds":["search"]}"""))
        val view = android.view.View(root.context).also { root.addView(it) }
        InteractionTargetRegistry.set(view, "metadata", 1, mapOf("testId" to "search"))
        val capture = recorder.owner(view)!!
        assertFalse(recorder.allowsValue(capture, "text_edit"))
        recorder.observe(InteractionObservation(capture, text(), "end"))
        assertFalse(buffer.snapshotForReport().toString().contains("SECRET"))
    }

    @Test fun helperOwnershipCancelsAlreadyPendingAutomaticSummary() {
        val view = field(); observe(view)
        assertTrue(recorder.register(view, "ref", 1, recorder.lease()!!, setOf("text_edit")))
        now = 1000; recorder.flushDue()
        assertEquals(0, buffer.size)
    }

    @Test fun annotationCannotGrantValuePermissionWithoutExactNativeTestId() {
        recorder.configure(InteractionEventPolicy.parse("""{"valueTestIds":["search"]}"""))
        val view = field()
        InteractionTargetRegistry.set(view, "metadata", 1, mapOf("testId" to "search\u0000"))
        assertFalse(recorder.allowsValue(recorder.owner(view)!!, "text_edit"))
        val adapter = InteractionTargetViewAdapters.register { InteractionTargetViewHints(testId = "search") }
        try {
            assertTrue(recorder.allowsValue(recorder.owner(view)!!, "text_edit"))
        } finally { adapter.close() }
    }
}
