// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

import android.content.Context
import android.view.View
import android.widget.Button
import android.widget.FrameLayout
import androidx.test.core.app.ApplicationProvider
import dev.everframe.R
import kotlinx.serialization.json.*
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class) @Config(manifest=Config.NONE)
class InteractionTargetRegistryTest {
    private val context:Context get()=ApplicationProvider.getApplicationContext()
    @Before fun setup() { InteractionTargetRegistry.reset() }
    @After fun cleanup() { InteractionTargetRegistry.reset() }
    @Test fun reporterAnnotationTagsTheActualTargetAndRetainsOnlySafeMetadataWhenMasked() {
        val root = FrameLayout(context)
        val button = Button(context).apply { text = "PRIVATE" }; root.addView(button)
        InteractionTargetRegistry.set(button,"report",1,mapOf("reporterTrigger" to "menu", "name" to "PRIVATE"))
        val plain = InteractionTargetResolver.resolve(button)
        assertEquals(JsonPrimitive("reporter"), plain.data["origin"])
        assertEquals(JsonPrimitive("menu"), plain.data["trigger"])
        button.setTag(R.id.tx_sensitive,true)
        val masked = InteractionTargetResolver.resolve(button)
        assertEquals(JsonPrimitive("reporter"), masked.data["origin"])
        assertEquals(JsonPrimitive("menu"), masked.data["trigger"])
        assertFalse(masked.data.toString().contains("PRIVATE"))
        assertNull(InteractionTargetResolver.resolve(root).data["origin"])
        InteractionTargetRegistry.clear("report",2)
        assertNull(InteractionTargetResolver.resolve(button).data["origin"])
    }
    @Test fun invalidReporterTriggerCannotAnnotateAControl() {
        for ((index,trigger) in listOf("shake","companion","Menu","button ",42).withIndex()) {
            val view = Button(context)
            InteractionTargetRegistry.set(view,"invalid-$index",1,mapOf("reporterTrigger" to trigger,"name" to "control"))
            assertEquals(JsonPrimitive("control"),InteractionTargetRegistry.lookup(view)?.get("name"))
            assertNull(InteractionTargetResolver.resolve(view).data["origin"])
        }
    }
    @Test fun internalDevtoolsAnnotationTagsMaskedDescendantsAndClearRevokesIt() {
        val root = FrameLayout(context).apply { contentDescription = "PRIVATE"; setTag(R.id.tx_sensitive,true) }
        val child = Button(context).apply { text = "PRIVATE" }; root.addView(child)
        InteractionTargetRegistry.set(root,"tools",1,mapOf("devtoolsOrigin" to true,"name" to "PRIVATE"))
        InteractionTargetRegistry.set(child,"report",1,mapOf("reporterTrigger" to "button"))
        val snapshot = InteractionTargetResolver.resolve(child)
        assertEquals(JsonPrimitive("devtools"),snapshot.data["origin"])
        assertNull(snapshot.data["trigger"])
        assertEquals("[masked]",snapshot.label)
        assertFalse(snapshot.data.toString().contains("PRIVATE"))
        InteractionTargetRegistry.clear("tools",2)
        assertEquals(JsonPrimitive("reporter"),InteractionTargetResolver.resolve(child).data["origin"])
        InteractionTargetRegistry.set(root,"tools",3,mapOf("devtoolsOrigin" to true))
        root.contentDescription = "recycled"
        assertEquals(JsonPrimitive("reporter"),InteractionTargetResolver.resolve(child).data["origin"])
    }
    @Test fun devtoolsAnnotationAcceptsOnlyTrueBoolean() {
        for ((index,value) in listOf(false,"true",1).withIndex()) {
            val button = Button(context)
            InteractionTargetRegistry.set(button,"invalid-tools-$index",1,mapOf("devtoolsOrigin" to value,"name" to "ordinary"))
            assertEquals(JsonPrimitive("ordinary"),InteractionTargetRegistry.lookup(button)?.get("name"))
            assertNull(InteractionTargetResolver.resolve(button).data["origin"])
        }
    }
    @Test fun oldCleanupCannotRemoveNewOwner() {
        val view=Button(context)
        InteractionTargetRegistry.set(view,"A",1,mapOf("name" to "Old"))
        InteractionTargetRegistry.set(view,"B",2,mapOf("name" to "Current"))
        InteractionTargetRegistry.clear("A",3)
        assertEquals(JsonPrimitive("Current"),InteractionTargetRegistry.lookup(view)?.get("name"))
    }
    @Test fun lateSetCannotOverwriteNewGenerationOrResurrectClearedOwner() {
        val view=Button(context)
        InteractionTargetRegistry.set(view,"A",2,mapOf("name" to "Current"))
        InteractionTargetRegistry.set(view,"A",1,mapOf("name" to "Old"))
        assertEquals(JsonPrimitive("Current"),InteractionTargetRegistry.lookup(view)?.get("name"))
        InteractionTargetRegistry.clear("A",3)
        InteractionTargetRegistry.set(view,"A",2,mapOf("name" to "Old"))
        assertNull(InteractionTargetRegistry.lookup(view))
    }
    @Test fun reusedNumericIdDoesNotTransferMetadata() {
        val old=Button(context).apply { id=123 }
        InteractionTargetRegistry.set(old,"A",1,mapOf("name" to "Old"))
        val replacement=Button(context).apply { id=123 }
        assertNull(InteractionTargetRegistry.lookup(replacement))
    }
    @Test fun changedHostIdentityInvalidatesButSiblingClippingPreservesAnnotation() {
        val root=FrameLayout(context)
        val view=Button(context).apply { contentDescription="A" }; root.addView(view)
        InteractionTargetRegistry.set(view,"A",1,mapOf("container" to mapOf("index" to 0,"count" to 2)))
        view.contentDescription="B"
        assertNull(InteractionTargetRegistry.lookup(view))
        InteractionTargetRegistry.set(view,"A",2,mapOf("container" to mapOf("index" to 0,"count" to 2)))
        root.addView(View(context),0)
        assertNotNull(InteractionTargetRegistry.lookup(view))
        root.removeView(view); root.addView(view)
        assertNotNull(InteractionTargetRegistry.lookup(view))
    }
    @Test fun annotationOverridesAreNormalizedAndContainerReplacesAutomaticGroup() {
        val root=FrameLayout(context).apply { contentDescription="Automatic" }
        val card=Button(context).apply { text="Auto name" }; root.addView(card)
        val close=InteractionTargetViewAdapters.register { if(it===root) InteractionTargetViewHints(role="list",testId="automatic-id") else null }
        try {
            InteractionTargetRegistry.set(card,"A",1,mapOf("name" to "Explicit", "container" to mapOf("name" to "Annotated","index" to 4,"count" to 4)))
            val target=InteractionTargetResolver.resolve(card).data["target"]!!.jsonObject
            assertEquals(JsonPrimitive("Explicit"),target["name"])
            assertEquals(JsonPrimitive("annotation"),target["nameFrom"])
            assertEquals(Json.parseToJsonElement("""{"name":"Annotated"}"""),target["container"])
        } finally { close.close() }
    }
    @Test fun maskingDominatesExplicitOverridesEverywhere() {
        val view=Button(context).apply { setTag(R.id.tx_sensitive,true) }
        InteractionTargetRegistry.set(view,"A",1,mapOf("name" to "SECRET","testId" to "SECRET","container" to mapOf("name" to "SECRET")))
        val snapshot=InteractionTargetResolver.resolve(view)
        assertEquals("[masked]",snapshot.label)
        assertFalse(snapshot.data.toString().contains("SECRET"))
    }
    @Test fun clearIsSafeWithoutUIThreadViewAccessAndResetDropsMetadata() {
        val view=Button(context)
        InteractionTargetRegistry.set(view,"A",1,mapOf("name" to "Current"))
        val thread=Thread { InteractionTargetRegistry.clear("A",2) }; thread.start(); thread.join()
        assertNull(InteractionTargetRegistry.lookup(view))
        InteractionTargetRegistry.set(view,"B",3,mapOf("name" to "Current"))
        InteractionTargetRegistry.reset(); assertNull(InteractionTargetRegistry.lookup(view))
    }
    @Test fun pendingSetImmediatelyInvalidatesOldValueAndResetCancelsCompletion() {
        val view=Button(context)
        InteractionTargetRegistry.set(view,"A",1,mapOf("name" to "Old"))
        assertTrue(InteractionTargetRegistry.beginSet("A",2))
        assertNull(InteractionTargetRegistry.lookup(view))
        InteractionTargetRegistry.reset()
        InteractionTargetRegistry.completeSet(view,"A",2,mapOf("name" to "Obsolete"))
        assertNull(InteractionTargetRegistry.lookup(view))
    }
    @Test fun temporaryWindowDetachDoesNotRevokeMountedRefOwnership() {
        val activity=org.robolectric.Robolectric.buildActivity(android.app.Activity::class.java).setup().get()
        val root=FrameLayout(activity); activity.setContentView(root)
        val view=Button(activity); root.addView(view)
        InteractionTargetRegistry.set(view,"A",1,mapOf("name" to "Current"))
        root.removeView(view); root.addView(view)
        assertEquals(JsonPrimitive("Current"),InteractionTargetRegistry.lookup(view)?.get("name"))
        InteractionTargetRegistry.clear("A",2)
        assertNull(InteractionTargetRegistry.lookup(view))
    }

}
