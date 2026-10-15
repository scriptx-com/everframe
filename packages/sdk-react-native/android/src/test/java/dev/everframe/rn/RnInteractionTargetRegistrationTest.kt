// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.rn

import android.view.View
import com.facebook.react.uimanager.ReactAccessibilityDelegate.AccessibilityRole
import dev.everframe.capture.InteractionTargetRegistry
import kotlinx.serialization.json.*
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class) @Config(sdk=[29])
class RnInteractionTargetRegistrationTest {
    @Before fun setup() {
        InteractionTargetRegistry.reset()
        com.facebook.react.internal.featureflags.ReactNativeFeatureFlagsForTests.setUp()
    }
    @After fun cleanup() { InteractionTargetRegistry.reset() }
    @Test fun devtoolsIdentityUsesActualReactRootModuleAndNeverAccessibilityNames() {
        val context = RuntimeEnvironment.getApplication()
        val ordinary = View(context).apply { contentDescription = "LogBox Dismiss DevMenu" }
        assertFalse(RnInteractionTargetAdapter.describe(ordinary)!!.devtools)
        for (name in listOf("LogBox","DevMenu")) {
            val root = object : com.facebook.react.ReactRootView(context) { override fun getJSModuleName(): String = name }
            assertTrue(RnInteractionTargetAdapter.describe(root)!!.devtools)
        }
        val appRoot = object : com.facebook.react.ReactRootView(context) { override fun getJSModuleName(): String = "ShoppingApp" }
        assertFalse(RnInteractionTargetAdapter.describe(appRoot)!!.devtools)
    }
    private fun metadata(view:View): JsonObject? = InteractionTargetRegistry.javaClass.declaredMethods
        .single { it.name.startsWith("lookup") }.apply { isAccessible=true }.invoke(InteractionTargetRegistry,view) as? JsonObject
    @Test fun readsRealReactNativeTestIdAndRoleTags() {
        val view=View(RuntimeEnvironment.getApplication())
        view.setTag(com.facebook.react.R.id.react_test_id,"tab-home")
        view.setTag(com.facebook.react.R.id.accessibility_role,AccessibilityRole.TAB)
        val hints=RnInteractionTargetAdapter.describe(view)!!
        assertEquals("tab-home",hints.testId); assertEquals("tab",hints.role)
        view.setTag(com.facebook.react.R.id.accessibility_role,AccessibilityRole.SWITCH)
        assertEquals("switch",RnInteractionTargetAdapter.describe(view)?.role)
    }
    @Test fun synchronousClearCancelsQueuedRegistrationBeforeUIResolution() {
        val view=View(RuntimeEnvironment.getApplication())
        val queue=ArrayDeque<()->Unit>()
        val registration=RnInteractionTargetRegistration({view},{queue.add(it)})
        assertTrue(registration.set(1.0,"A",1.0,mapOf("name" to "Old")))
        assertTrue(registration.clear("A",2.0))
        queue.removeFirst().invoke()
        assertNull(metadata(view))
        registration.close()
    }
    @Test fun updatesWithoutLayoutAndLateDisposalCannotClearOtherModule() {
        val view=View(RuntimeEnvironment.getApplication())
        val first=RnInteractionTargetRegistration({view},{it()})
        first.set(1.0,"A",1.0,mapOf("name" to "First"))
        first.set(1.0,"A",2.0,mapOf("name" to "Updated"))
        assertEquals(JsonPrimitive("Updated"),metadata(view)?.get("name"))
        val second=RnInteractionTargetRegistration({view},{it()})
        second.set(1.0,"A",1.0,mapOf("name" to "Second"))
        first.close()
        assertEquals(JsonPrimitive("Second"),metadata(view)?.get("name"))
        second.close(); assertNull(metadata(view))
    }
    @Test fun invalidTagsAndMissingViewsDoNotThrowOrRegister() {
        val registration=RnInteractionTargetRegistration({null},{it()})
        for(tag in listOf(Double.NaN,Double.POSITIVE_INFINITY,0.0,-1.0,1.5)) assertFalse(registration.set(tag,"A",1.0,mapOf("name" to "Invalid")))
        assertTrue(registration.set(1.0,"A",1.0,mapOf("name" to "Missing")))
        registration.close()
    }
    @Test fun sdkStartReinstallsOnlyCurrentMountedRequests() {
        val view=View(RuntimeEnvironment.getApplication())
        val registration=RnInteractionTargetRegistration({view},{it()})
        registration.set(1.0,"A",1.0,mapOf("name" to "Current"))
        InteractionTargetRegistry.reset()
        registration.onStarted()
        assertEquals(JsonPrimitive("Current"),metadata(view)?.get("name"))
        registration.clear("A",2.0)
        InteractionTargetRegistry.reset(); registration.onStarted()
        assertNull(metadata(view))
        registration.close()
    }
    @Test fun queuedOlderUpdateCannotReplaceNewerMetadata() {
        val view=View(RuntimeEnvironment.getApplication())
        val queue=ArrayDeque<()->Unit>()
        val registration=RnInteractionTargetRegistration({view},{queue.add(it)})
        registration.set(1.0,"A",1.0,mapOf("name" to "Old"))
        registration.set(1.0,"A",2.0,mapOf("name" to "New"))
        queue.removeLast().invoke(); queue.removeFirst().invoke()
        assertEquals(JsonPrimitive("New"),metadata(view)?.get("name"))
        registration.close()
    }
    @Test fun canonicalSliderAndExactAriaListItemRoles() {
        val view=View(RuntimeEnvironment.getApplication())
        view.setTag(com.facebook.react.R.id.accessibility_role,AccessibilityRole.ADJUSTABLE)
        assertEquals("slider",RnInteractionTargetAdapter.describe(view)?.role)
        view.setTag(com.facebook.react.R.id.role,com.facebook.react.uimanager.ReactAccessibilityDelegate.Role.LISTITEM)
        assertEquals("listitem",RnInteractionTargetAdapter.describe(view)?.role)
    }

    @Test fun refBeforeNativeMountRetriesOnlyStillOwnedRequest() {
        var host: View?=null
        val registration=RnInteractionTargetRegistration({host},{it()})
        registration.set(1.0,"A",1.0,mapOf("name" to "Current"))
        host=View(RuntimeEnvironment.getApplication())
        registration.onMount()
        assertEquals(JsonPrimitive("Current"),metadata(host!!)?.get("name"))
        val current=host!!
        host=null
        registration.set(2.0,"B",2.0,mapOf("name" to "Cancelled"))
        registration.clear("B",3.0)
        host=current
        registration.onMount()
        assertEquals(JsonPrimitive("Current"),metadata(current)?.get("name"))
        registration.close()
    }

}
