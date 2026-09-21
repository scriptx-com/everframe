// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.capture.video

import org.junit.Assert.*
import org.junit.Test

class VideoDiagnosticsTest {
    @Test fun rollingCountersBoundRetentionAndDetachSnapshots() {
        val counter = VideoEncoderTimings.Counter()
        repeat(10000) { counter.add(it.toLong()) }
        val sample = counter.snapshot()
        assertEquals(256, sample.size)
        assertEquals((9744L..9999L).toSet(), sample.toSet())
        sample.fill(-1)
        assertTrue(counter.snapshot().all { it >= 9744 })
        counter.add(-3)
        assertTrue(counter.snapshot().contains(0))
    }
}
