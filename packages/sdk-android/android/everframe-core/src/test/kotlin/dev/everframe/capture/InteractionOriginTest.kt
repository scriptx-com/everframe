// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

import android.app.Activity
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import com.facebook.react.devsupport.RedBoxContentView
import dev.everframe.R
import dev.everframe.shared.SharedData
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class) @Config(manifest=Config.NONE)
class InteractionOriginTest {
    @Test fun expoDeveloperActivityIdentitySurvivesThemedContextWrapping() {
        val activity = Robolectric.buildActivity(expo.modules.devmenu.DevMenuActivity::class.java).setup().get()
        val button = Button(android.view.ContextThemeWrapper(activity,android.R.style.Theme_Material))
        assertEquals(JsonPrimitive("devtools"),InteractionTargetResolver.resolve(button).data["origin"])
    }
    @Test fun nativeFrameworkAncestryTagsDevtoolsWithoutMatchingLabels() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val root = FrameLayout(activity); activity.setContentView(root)
        val app = Button(activity).apply { text = "Dismiss LogBox developer menu" }; root.addView(app)
        assertNull(InteractionTargetResolver.resolve(app).data["origin"])
        val tools = RedBoxContentView(activity); root.addView(tools)
        val child = Button(activity).apply { text = "Ordinary action" }; tools.addView(child)
        assertEquals(JsonPrimitive("devtools"),InteractionTargetResolver.resolve(child).data["origin"])
        child.setTag(R.id.tx_sensitive,true)
        val masked = InteractionTargetResolver.resolve(child)
        assertEquals(JsonPrimitive("devtools"),masked.data["origin"])
        assertFalse(masked.data.toString().contains("Ordinary"))
    }
    @Test fun devtoolsOriginSurvivesObservedTextControlAndScrollStorage() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        SharedData.init(activity)
        val root = RedBoxContentView(activity); activity.setContentView(root)
        val buffer = BreadcrumbRingBuffer(100,false)
        val recorder = InteractionEventRecorder(buffer, schedule={ _, _ -> })
        for (json in listOf(
            """{"type":"text_edit","source":"native","observedAt":1,"length":4,"reason":"end"}""",
            """{"type":"control_change","source":"native","observedAt":2,"control":"switch","checked":true}""",
            """{"type":"scroll","source":"native","observedAt":3,"axis":"y","direction":"forward"}""",
        )) {
            val field = EditText(activity); root.addView(field)
            assertTrue(recorder.observe(InteractionObservation(recorder.owner(field)!!,Json.parseToJsonElement(json).jsonObject,"end")))
        }
        assertEquals(3,buffer.size)
        buffer.snapshotForReport().forEach { assertEquals(JsonPrimitive("devtools"),it.data!!["origin"]) }
    }
}
