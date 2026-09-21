// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Report Resource Window (spec 2026-09-05), Task 12. Pure JVM unit tests —
// no Robolectric needed, mirrors LogRingBufferTest: ResourceRingBuffer touches
// no Android APIs.
package com.traceitx.capture

import com.traceitx.TraceItX
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ResourceRingBufferTest {

    @Test fun `evicts entries older than the window`() {
        val ring = ResourceRingBuffer(windowSec = 60, honorsKillGate = false)
        ring.push(ResourceRingBuffer.Entry(0, 0.1, 1), now = 0)
        ring.push(ResourceRingBuffer.Entry(30_000, 0.1, 2), now = 30_000)
        ring.push(ResourceRingBuffer.Entry(70_000, 0.1, 3), now = 70_000)
        assertEquals(listOf(2L, 3L), ring.snapshot(now = 70_000).map { it.mem })
    }

    @Test fun `hard cap keeps the newest`() {
        val ring = ResourceRingBuffer(windowSec = 100_000, honorsKillGate = false)
        repeat(ResourceRingBuffer.MAX_SAMPLES + 50) { i ->
            ring.push(ResourceRingBuffer.Entry(i.toLong(), null, i.toLong()), now = 0)
        }
        val snap = ring.snapshot(now = 0)
        assertEquals(ResourceRingBuffer.MAX_SAMPLES, snap.size)
        assertEquals((ResourceRingBuffer.MAX_SAMPLES + 49).toLong(), snap.last().mem)
    }

    @Test fun `window change applies live`() {
        val ring = ResourceRingBuffer(windowSec = 60, honorsKillGate = false)
        ring.push(ResourceRingBuffer.Entry(0, null, 1), now = 0)
        ring.push(ResourceRingBuffer.Entry(30_000, null, 2), now = 30_000)
        ring.windowSec = 10
        assertEquals(listOf(2L), ring.snapshot(now = 30_000).map { it.mem })
    }

    // ==================== Round-review Finding 3 (2026-09-05) — kill-gate on push ====================
    //
    // Mirrors NetworkRingBufferTest's "Round-2 review Finding F11" section:
    // a production (honorsKillGate=true, the public constructor's default)
    // buffer must refuse to record while `TraceItX.captureGate` is closed —
    // this is what makes "no post-kill sample can enter the ring" a
    // structural invariant of the ring itself, rather than something that
    // only holds if `TraceItX.kill()` happens to clear this buffer before
    // tearing down the sampler that feeds it.

    @Test fun `push is a no-op when captureGate is closed`() {
        TraceItX.captureGate = false
        val ring = ResourceRingBuffer(windowSec = 60)
        ring.push(ResourceRingBuffer.Entry(0, 0.1, 1), now = 0)
        assertTrue(
            "a production (honorsKillGate=true) ring must refuse to record while the gate is closed",
            ring.snapshot(now = 0).isEmpty(),
        )
    }

    @Test fun `push records once captureGate reopens`() {
        TraceItX.captureGate = false
        val ring = ResourceRingBuffer(windowSec = 60)
        ring.push(ResourceRingBuffer.Entry(0, 0.1, 1), now = 0)
        assertTrue(ring.snapshot(now = 0).isEmpty())
        TraceItX.captureGate = true
        try {
            ring.push(ResourceRingBuffer.Entry(1, 0.2, 2), now = 1)
            assertEquals(listOf(2L), ring.snapshot(now = 1).map { it.mem })
        } finally {
            TraceItX.captureGate = false
        }
    }

    @Test fun `honorsKillGate=false bypasses the gate for isolated eviction tests`() {
        TraceItX.captureGate = false
        val ring = ResourceRingBuffer(windowSec = 60, honorsKillGate = false)
        ring.push(ResourceRingBuffer.Entry(0, 0.1, 1), now = 0)
        assertEquals(1, ring.snapshot(now = 0).size)
    }

    // Fields 14/15 are utime/stime in clock ticks. Field 2 (comm) may contain
    // spaces and parentheses — "(my app)" — so a naive split on ' ' picks the
    // wrong fields. Parse from the LAST ')' forward.
    @Test fun `parses utime and stime from a proc self stat line`() {
        val line = "1234 (my app) R 1 1234 1234 0 -1 4194560 " +
            (0..3).joinToString(" ") { "0" } + " 111 222 " + (0..30).joinToString(" ") { "0" }
        val parsed = ResourceSampler.parseProcSelfStat(line)!!
        assertEquals(111L, parsed.utime)
        assertEquals(222L, parsed.stime)
    }

    // Round-1 review, "ALSO" item: a comm field containing its OWN
    // parentheses — "(my (weird) app)" — is the actual reason `lastIndexOf`
    // is required over `indexOf`: the first ')' in the line closes the
    // INNER "(weird)", not the field-2 delimiter, so `indexOf` would shift
    // every field afterward by one and misread utime/stime. The prior test
    // above (spaces only, no nested parens) would pass under EITHER
    // `indexOf` or `lastIndexOf` and so didn't actually pin the reason for
    // the choice.
    @Test fun `parses utime and stime when comm contains its own parentheses`() {
        val line = "1234 (my (weird) app) R 1 1234 1234 0 -1 4194560 " +
            (0..3).joinToString(" ") { "0" } + " 111 222 " + (0..30).joinToString(" ") { "0" }
        val parsed = ResourceSampler.parseProcSelfStat(line)!!
        assertEquals(111L, parsed.utime)
        assertEquals(222L, parsed.stime)
    }

    @Test fun `returns null for a malformed stat line rather than throwing`() {
        assertNull(ResourceSampler.parseProcSelfStat("garbage"))
        assertNull(ResourceSampler.parseProcSelfStat(""))
    }

    @Test fun `cpu fraction is per single core`() {
        assertEquals(1.0, ResourceSampler.cpuFraction(100, 1.0, 100), 0.001)
        assertEquals(2.0, ResourceSampler.cpuFraction(200, 1.0, 100), 0.001)
        assertEquals(0.25, ResourceSampler.cpuFraction(50, 2.0, 100), 0.001)
    }

    // --- Report Resource Window (spec 2026-09-05) — gap class 4: clamp/negative-delta handling ---

    @Test fun `safe cpu fraction ships null on a negative ticks delta rather than a fabricated number`() {
        assertNull(ResourceSampler.safeCpuFraction(-1, 2.0, 100))
    }

    @Test fun `safe cpu fraction clamps an over-ceiling result to MAX_CPU_CORES`() {
        // 2_000_000 ticks / 100 ticks-per-sec / 0.001s wall = 20_000 cores —
        // a clock anomaly, not a real multicore reading.
        assertEquals(
            ResourceSampler.MAX_CPU_CORES,
            ResourceSampler.safeCpuFraction(2_000_000, 0.001, 100)!!,
            0.001,
        )
    }

    @Test fun `safe cpu fraction passes an ordinary in-range result through unchanged`() {
        assertEquals(1.0, ResourceSampler.safeCpuFraction(100, 1.0, 100)!!, 0.001)
    }
}
