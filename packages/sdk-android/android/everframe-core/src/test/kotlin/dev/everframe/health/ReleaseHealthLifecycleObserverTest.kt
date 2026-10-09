// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.health

import android.os.Looper
import android.util.Log
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.testing.TestLifecycleOwner
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLog

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ReleaseHealthLifecycleObserverTest {
    @Test fun `background installation remains inactive until foreground and repeated callbacks coalesce`() {
        val events = mutableListOf<Boolean>()
        val owner = TestLifecycleOwner(Lifecycle.State.CREATED)
        val observer = ReleaseHealthLifecycleObserver({ events += it }, { owner })
        observer.install(); shadowOf(Looper.getMainLooper()).idle()
        assertEquals(listOf(false), events)
        owner.handleLifecycleEvent(Lifecycle.Event.ON_START)
        observer.onStart(owner)
        assertEquals(listOf(false, true), events)
        owner.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
        observer.onStop(owner)
        assertEquals(listOf(false, true, false), events)
        owner.handleLifecycleEvent(Lifecycle.Event.ON_START)
        assertEquals(listOf(false, true, false, true), events)
    }
    @Test fun `uninstall fences queued installation and stale callbacks`() {
        val owner = TestLifecycleOwner(Lifecycle.State.STARTED)
        val events = mutableListOf<Boolean>()
        val observer = ReleaseHealthLifecycleObserver({ events += it }, { owner })
        observer.install(); observer.uninstall()
        shadowOf(Looper.getMainLooper()).idle()
        observer.onStart(owner); observer.onStop(owner)
        assertTrue(events.isEmpty()); assertEquals(0, owner.observerCount)
    }
    @Test fun `an unattached process lifecycle warns instead of staying silently background`() {
        ShadowLog.clear()
        fun warnings() = ShadowLog.getLogsForTag("Everframe").filter { it.type == Log.WARN }.map { it.msg }
        val attached = TestLifecycleOwner(Lifecycle.State.CREATED)
        ReleaseHealthLifecycleObserver({}, { attached }).install()
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(warnings().isEmpty())
        // App Startup never attached this owner (provider removed, or a non-default process).
        val events = mutableListOf<Boolean>()
        val unattached = TestLifecycleOwner(Lifecycle.State.INITIALIZED)
        ReleaseHealthLifecycleObserver({ events += it }, { unattached }).install()
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(listOf(false), events)
        assertTrue(warnings().single().contains("process-lifecycle-unavailable"))
    }
}
