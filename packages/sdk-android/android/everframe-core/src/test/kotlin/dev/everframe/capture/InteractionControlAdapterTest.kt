// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

import android.widget.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class) @Config(manifest = Config.NONE)
class InteractionControlAdapterTest {
    @Test fun observedNativeChangeKeepsExistingListenerAndReadsFinalValue() {
        val f = InteractionAdapterFixture(); val adapter = InteractionControlAdapter(f.recorder)
        val view = Switch(f.activity).also { f.root.addView(it) }; var calls = 0
        view.setOnCheckedChangeListener { _, _ -> calls++ }
        view.isChecked = true
        assertEquals(0, f.buffer.size); assertEquals(1, calls)
        adapter.changed(view)
        assertEquals(true, f.events().single()["checked"]!!.jsonPrimitive.boolean)
        assertFalse(adapter.changed(Spinner(f.activity)))
        view.isChecked = false; assertEquals(2, calls)
    }
    @Test fun stateReadAfterAppCallbackCannotAcquireFreshOwnership() {
        val f = InteractionAdapterFixture(); val adapter = InteractionControlAdapter(f.recorder)
        val view = CheckBox(f.activity).also { f.root.addView(it) }
        val observation = adapter.begin(view)!!
        view.setOnCheckedChangeListener { _, _ -> f.buffer.clear() }
        view.isChecked = true
        assertFalse(adapter.complete(observation)); assertEquals(0, f.buffer.size)
    }
}
