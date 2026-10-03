// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.ui

import android.app.Activity
import android.app.Application
import org.junit.Assert.*
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class ActivityRegistryTest {
    @Before fun before() = resetReporterTestState()
    @After fun after() = resetReporterTestState()

    @Test fun oldLifecycleCallbacksDoNotClearReplacement() {
        val old = Robolectric.buildActivity(Activity::class.java).setup().get()
        val next = Robolectric.buildActivity(Activity::class.java).setup().get()
        ActivityRegistry.seed(old.application, old)
        ActivityRegistry.seed(next.application, next)
        ActivityRegistry.onActivityPaused(old)
        ActivityRegistry.onActivityDestroyed(old)
        assertSame(next, ActivityRegistry.activeActivity())
        ActivityRegistry.onActivityPaused(next)
        assertNull(ActivityRegistry.activeActivity())
    }
    @Test fun refusesWrongApplicationAndDestroyedActivity() {
        val controller = Robolectric.buildActivity(Activity::class.java).setup()
        val activity = controller.get()
        assertFalse(ActivityRegistry.seed(Application(), activity))
        assertTrue(ActivityRegistry.seed(activity.application, activity))
        controller.pause().stop().destroy()
        assertFalse(ActivityRegistry.seed(activity.application, activity))
        assertNull(ActivityRegistry.activeActivity())
    }
}
