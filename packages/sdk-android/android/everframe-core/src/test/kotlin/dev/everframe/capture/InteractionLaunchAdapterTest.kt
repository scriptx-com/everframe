// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class) @Config(manifest = Config.NONE)
class InteractionLaunchAdapterTest {
    @Test fun processTransitionsClassifyOnceWithoutProviderOrActivityColdDuplicates() {
        val f = InteractionAdapterFixture(); val adapter = InteractionLaunchAdapter(f.recorder)
        adapter.seed(alreadyForeground = false)
        adapter.foreground(); adapter.foreground(); adapter.seed(alreadyForeground = true)
        assertEquals(1, f.buffer.size); assertEquals("cold", f.events().single()["start"]!!.jsonPrimitive.content)
        assertFalse(f.events().single().containsKey("trigger"))
        adapter.background(); adapter.foreground()
        assertEquals(2, f.buffer.size); assertEquals("warm", f.events().last()["start"]!!.jsonPrimitive.content)
    }
    @Test fun lateInstallationDoesNotInventColdHistory() {
        val f = InteractionAdapterFixture(); val adapter = InteractionLaunchAdapter(f.recorder)
        adapter.seed(alreadyForeground = true); adapter.foreground(); assertEquals(0, f.buffer.size)
        adapter.background(); adapter.foreground(); assertEquals("warm", f.events().single()["start"]!!.jsonPrimitive.content)
    }
}
