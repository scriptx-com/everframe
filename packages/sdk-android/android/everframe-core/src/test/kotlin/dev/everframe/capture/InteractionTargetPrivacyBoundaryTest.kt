// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

import android.app.Activity
import android.view.KeyEvent
import android.view.Window
import android.widget.Button
import android.widget.LinearLayout
import androidx.test.core.app.ApplicationProvider
import dev.everframe.Everframe
import dev.everframe.shared.SharedData
import org.junit.Test
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, qualifiers = "television")
class InteractionTargetPrivacyBoundaryTest {
    @Test fun reporterAnnotationOnlyTagsTheMatchingRemoteActivation() {
        SharedData.init(ApplicationProvider.getApplicationContext())
        Everframe.captureGate = true
        sharedBreadcrumbBuffer.applyConfig(null); sharedBreadcrumbBuffer.clear()
        PressCrumbRateLimiter.__resetForTesting()
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val button = Button(activity)
        try {
            InteractionTargetRegistry.set(button,"report",1,mapOf("reporterTrigger" to "button"))
            TapBreadcrumbAdapter.recordRemotePress(KeyEvent.KEYCODE_DPAD_RIGHT,button)
            TapBreadcrumbAdapter.recordRemotePress(KeyEvent.KEYCODE_DPAD_CENTER,button)
            InteractionTargetRegistry.set(button,"report",2,mapOf("reporterTrigger" to "menu"))
            TapBreadcrumbAdapter.recordRemotePress(KeyEvent.KEYCODE_BACK,button)
            TapBreadcrumbAdapter.recordRemotePress(KeyEvent.KEYCODE_MENU,button)
            val data = sharedBreadcrumbBuffer.snapshotForReport().map { it.data!! }
            assertNull(data[0]["origin"]); assertNull(data[0]["trigger"])
            assertEquals(kotlinx.serialization.json.JsonPrimitive("reporter"),data[1]["origin"])
            assertNull(data[2]["origin"])
            assertEquals(kotlinx.serialization.json.JsonPrimitive("menu"),data[3]["trigger"])
        } finally {
            Everframe.captureGate = false
            InteractionTargetRegistry.reset(); sharedBreadcrumbBuffer.clear()
        }
    }
    @Test fun snapshotCannotRestorePriorUserMetadataAfterSignOut() {
        SharedData.init(ApplicationProvider.getApplicationContext())
        Everframe.captureGate = true
        sharedBreadcrumbBuffer.applyConfig(null)
        sharedBreadcrumbBuffer.clear()
        PressCrumbRateLimiter.__resetForTesting()
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        try {
            val root = LinearLayout(activity)
            val old = Button(activity).apply { text = "PRIOR_USER_PRIVATE"; isFocusableInTouchMode = true }
            val current = Button(activity).apply { text = "Sign in"; isFocusableInTouchMode = true }
            root.addView(old); root.addView(current); activity.setContentView(root); old.requestFocus()
            assertSame(old, activity.window.currentFocus)
            InteractionTargetScreenState.recordExplicit("PRIOR_USER_SCREEN")
            InteractionTargetRegistry.set(old, "review", 1, mapOf("container" to mapOf("name" to "PRIOR_USER_LIST")))
            val delegate = object : Window.Callback by activity.window.callback {
                override fun dispatchKeyEvent(event: KeyEvent) = true
            }
            val callback = TXWindowCallbackWrapper(delegate, activity)
            callback.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_RIGHT))
            Everframe.setIdentityToken(null)
            assertNull(InteractionTargetRegistry.lookup(old))
            assertNull(InteractionTargetScreenState.current())
            sharedBreadcrumbBuffer.freeze()
            assertTrue(sharedBreadcrumbBuffer.takeFrozen()!!.isEmpty())
            current.requestFocus()
            callback.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_RIGHT))
            sharedBreadcrumbBuffer.freeze()
            assertTrue("Pending input must be revoked by sign-out", sharedBreadcrumbBuffer.takeFrozen()!!.isEmpty())
            callback.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_RIGHT))
            callback.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DPAD_RIGHT))
            sharedBreadcrumbBuffer.freeze()
            val currentCrumbs = sharedBreadcrumbBuffer.takeFrozen()!!
            assertEquals(1, currentCrumbs.size)
            assertEquals("press right — Sign in", currentCrumbs.single().message)
        } finally {
            Everframe.captureGate = false
            InteractionTargetRegistry.reset(); InteractionTargetScreenState.reset(); sharedBreadcrumbBuffer.clear()
        }
    }
}
