// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.vitals

import android.os.Handler
import android.os.Looper
import dev.everframe.vitals.wire.VitalsSample
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ResourceSamplerTest {
    private val handler = Handler(Looper.getMainLooper())
    private val looper get() = shadowOf(Looper.getMainLooper())
    private var now = 100_000L
    private var cpuMs = 0L
    private var pss = 50L * 1024 * 1024
    private val samples = ArrayList<VitalsSample>()
    private var ticks = 0

    private fun sampler() = ResourceSampler(
        handler = handler, intervalMs = 20_000, now = { now }, readCpuTimeMs = { cpuMs }, readPssBytes = { pss },
        readJavaHeap = { 1_000 }, readNativeHeap = { 2_000 }, onSample = { samples.add(it) }, onTick = { ticks++ },
    )

    private fun advance(ms: Long) { now += ms; looper.idleFor(java.time.Duration.ofMillis(ms)) }

    @Test
    fun `first tick has no cpu, later ticks carry the fraction of one core`() {
        val s = sampler(); s.start()
        advance(20_000)
        assertEquals(1, samples.size); assertNull(samples[0].cpu); assertEquals(pss, samples[0].mem)
        assertEquals(mapOf("javaHeap" to 1_000.0, "nativeHeap" to 2_000.0), samples[0].extras)
        cpuMs += 5_000
        advance(20_000)
        assertEquals(0.25, samples[1].cpu!!, 0.001)
        assertEquals(2, ticks)
        s.stop()
    }

    @Test
    fun `pause stops sampling, resume restarts with no cpu on the first tick after resume`() {
        val s = sampler(); s.start()
        advance(20_000); s.pause()
        advance(60_000)
        assertEquals(1, samples.size)
        cpuMs += 100_000
        s.resume(); advance(20_000)
        assertEquals(2, samples.size); assertNull(samples[1].cpu)
        s.stop()
    }

    @Test
    fun `stop cancels the tick and start after stop is a no-op`() {
        val s = sampler(); s.start(); s.stop()
        advance(60_000)
        assertEquals(0, samples.size)
        s.start(); advance(20_000)
        assertEquals(0, samples.size)
    }

    @Test
    fun `pausing from inside onTick does not race the repost`() {
        lateinit var s: ResourceSampler
        s = ResourceSampler(
            handler = handler, intervalMs = 20_000, now = { now }, readCpuTimeMs = { cpuMs }, readPssBytes = { pss },
            readJavaHeap = { 1_000 }, readNativeHeap = { 2_000 }, onSample = { samples.add(it) },
            onTick = { ticks++; if (ticks == 1) s.pause() },
        )
        s.start()
        advance(60_000)
        assertEquals(1, samples.size)
        s.stop()
    }

    @Test
    fun `a throwing reader does not kill the cadence`() {
        var boom = true
        val s = ResourceSampler(handler = handler, intervalMs = 20_000, now = { now }, readCpuTimeMs = { cpuMs },
            readPssBytes = { if (boom) error("x") else pss }, readJavaHeap = { 0 }, readNativeHeap = { 0 }, onSample = { samples.add(it) }, onTick = {})
        s.start(); advance(20_000); boom = false; advance(20_000)
        assertEquals(1, samples.size)
        s.stop()
    }
}
