// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

import android.view.View
import android.widget.*
import dev.everframe.R
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class) @Config(manifest = Config.NONE)
class InteractionPreparedPrivacyTest {
    private data class Sample(val kind: String, val state: String, val host: (InteractionAdapterFixture) -> View)
    private val samples = listOf(
        Sample("control_change", "\"control\":\"switch\",\"checked\":true", { Switch(it.activity) }),
        Sample("control_change", "\"control\":\"checkbox\",\"checked\":true", { CheckBox(it.activity) }),
        Sample("control_change", "\"control\":\"slider\",\"position\":0.75", { SeekBar(it.activity) }),
        Sample("control_change", "\"control\":\"picker\",\"optionId\":\"private-choice\"", { Spinner(it.activity) }),
        Sample("scroll", "\"axis\":\"y\",\"direction\":\"forward\"", { ScrollView(it.activity) }),
    )
    private fun input(sample: Sample) = """{"type":"${sample.kind}","source":"app","observedAt":1,${sample.state}}"""
    private fun rejected(masked: Boolean, offMain: Boolean) {
        for (sample in samples) {
            val f = InteractionAdapterFixture()
            val host = sample.host(f).also { f.root.addView(it) }
            val lease = f.recorder.lease()!!
            assertTrue(f.recorder.register(host, "helper", 1, lease, setOf(sample.kind)))
            if (masked) host.setTag(R.id.tx_sensitive, true)
            var prepared: PreparedInteraction? = null
            val prepare = { prepared = f.recorder.prepare(lease, "helper", 1, input(sample)) }
            if (offMain) Thread { prepare() }.apply { start(); join() } else prepare()
            host.setTag(R.id.tx_sensitive, null)
            prepared?.let { f.recorder.recordPrepared(it) }
            assertEquals("${sample.state} observed without original privacy proof", 0, f.buffer.size)
            assertNull("Rejected host state must not be retained", prepared)
        }
    }
    @Test fun maskedMainThreadHostStateCannotBeAuthorizedByLaterUnmasking() = rejected(masked = true, offMain = false)
    @Test fun maskedOffMainHostStateCannotBeAuthorizedByLaterUnmasking() = rejected(masked = true, offMain = true)
    @Test fun offMainHostStateWithoutOriginalPrivacyProofIsNotRetained() = rejected(masked = false, offMain = true)
    @Test fun safeMainThreadNativeHelpersStillEmitTheirObservedState() {
        for (sample in samples) {
            val f = InteractionAdapterFixture()
            val host = sample.host(f).also { f.root.addView(it) }
            val lease = f.recorder.lease()!!
            assertTrue(f.recorder.register(host, "helper", 1, lease, setOf(sample.kind)))
            val prepared = f.recorder.prepare(lease, "helper", 1, input(sample))
            assertNotNull(sample.state, prepared)
            assertTrue(f.recorder.recordPrepared(prepared!!))
            val actual = f.events().single()
            assertEquals(sample.kind, actual.string("type"))
            for ((key, expected) in interactionJson("{${sample.state}}")) assertEquals(key, expected, actual[key])
        }
    }
    @Test fun preparedNativeControlStillRechecksRevocationAndHostIdentityAtAdmission() {
        for (revoke in listOf(false, true)) {
            val f = InteractionAdapterFixture()
            val sample = samples[3]
            val host = sample.host(f).also { it.id = 123; f.root.addView(it) }
            val lease = f.recorder.lease()!!
            assertTrue(f.recorder.register(host, "helper", 1, lease, setOf(sample.kind)))
            val json = input(sample).dropLast(1) + ",\"value\":\"SECRET\"}"
            val prepared = f.recorder.prepare(lease, "helper", 1, json)!!
            assertFalse(prepared.observation!!.event.toString().contains("SECRET"))
            if (revoke) f.buffer.clear() else host.id = 124
            assertFalse(f.recorder.recordPrepared(prepared))
            assertEquals(0, f.buffer.size)
        }
    }
}
