// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
@RunWith(RobolectricTestRunner::class) @Config(manifest = Config.NONE)
class InteractionProcessInitializerTest {
    @Test fun onlyAnEarlyProcessObserverCanAuthorizeColdClassification() {
        val owner = object : LifecycleOwner { override val lifecycle = LifecycleRegistry(this) }
        owner.lifecycle.currentState = Lifecycle.State.CREATED
        val history = InteractionProcessHistory()
        assertFalse(history.beforeFirstForeground())
        history.install(owner.lifecycle)
        assertTrue(history.beforeFirstForeground())
        owner.lifecycle.currentState = Lifecycle.State.STARTED
        owner.lifecycle.currentState = Lifecycle.State.CREATED
        assertFalse(history.beforeFirstForeground())
        history.install(owner.lifecycle)
        assertFalse(history.beforeFirstForeground())
    }
}
