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
    @Test fun lateBackgroundInstallationIsWarm() {
        val f = InteractionAdapterFixture(); val adapter = InteractionLaunchAdapter(f.recorder)
        adapter.seed(false); adapter.foreground(); f.recorder.flushReadyForFreeze()
        assertEquals("warm", f.events().single().string("start"))
    }
    @Test fun contextEnrichesOnlyPendingNativeLaunchAndCannotReplayAfterFreezeOrClear() {
        val f = InteractionAdapterFixture(); val adapter = InteractionLaunchAdapter(f.recorder)
        f.recorder.configure(InteractionEventPolicy.parse("""{"launchArgumentKeys":["campaign","url"]}"""))
        adapter.seed(false); adapter.launched(); adapter.foreground()
        val lease = f.recorder.lease()!!
        val json = """{"type":"launch_context","source":"app","observedAt":1,"trigger":"notification","arguments":{"campaign":"safe","url":"https://secret/token","secret":"SECRET"}}"""
        assertEquals(0, f.buffer.size)
        assertNotNull(f.recorder.prepare(lease,"",0,json))
        f.recorder.flushReadyForFreeze()
        val event = f.events().single()
        assertEquals("cold",event.string("start")); assertEquals("native",event.string("source")); assertEquals("notification",event.string("trigger"))
        assertEquals("safe",event["arguments"]!!.jsonObject.string("campaign")); assertFalse(event.toString().contains("SECRET")); assertFalse(event.toString().contains("secret/token"))
        assertNull(f.recorder.prepare(lease,"",0,json)); assertEquals(1,f.buffer.size)
        adapter.background(); adapter.foreground(); f.buffer.clear()
        assertNull(f.recorder.prepare(lease,"",0,json)); f.recorder.flushReadyForFreeze(); assertEquals(0,f.buffer.size)
    }

    @Test fun processTransitionsClassifyOnceWithoutProviderOrActivityColdDuplicates() {
        val f = InteractionAdapterFixture(); val adapter = InteractionLaunchAdapter(f.recorder)
        adapter.seed(alreadyForeground = false); adapter.launched()
        adapter.foreground(); adapter.foreground(); adapter.seed(alreadyForeground = true)
        f.recorder.flushReadyForFreeze(); assertEquals(1, f.buffer.size); assertEquals("cold", f.events().single()["start"]!!.jsonPrimitive.content)
        assertFalse(f.events().single().containsKey("trigger"))
        adapter.background(); adapter.foreground()
        f.recorder.flushReadyForFreeze(); assertEquals(2, f.buffer.size); assertEquals("warm", f.events().last()["start"]!!.jsonPrimitive.content)
    }
    @Test fun lateInstallationDoesNotInventColdHistory() {
        val f = InteractionAdapterFixture(); val adapter = InteractionLaunchAdapter(f.recorder)
        adapter.seed(alreadyForeground = true); adapter.foreground(); assertEquals(0, f.buffer.size)
        adapter.background(); adapter.foreground(); f.recorder.flushReadyForFreeze(); assertEquals("warm", f.events().single()["start"]!!.jsonPrimitive.content)
    }
}
