// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Report Resource Window (spec 2026-09-05) — ring buffer + sampler
// arithmetic. Test bodies are VERBATIM from task-10-brief.md's CONTROLLER
// RULING section: `snapshot(now:)`/`append(_:now:)` are the real, testable
// seams (entries are stamped t=0..70_000, epoch 1970 — a bare `now()` read
// against the real clock would evict everything and every assertion below
// would be vacuous).
import XCTest
@testable import TraceItXKit

final class ResourceRingBufferTests: XCTestCase {
    func testEvictsSamplesOlderThanWindow() {
        let ring = ResourceRingBuffer(windowSec: 60, honorsKillGate: false)
        ring.append(ResourceSample(t: 0, cpu: 0.1, mem: 1), now: 0)
        ring.append(ResourceSample(t: 30_000, cpu: 0.1, mem: 2), now: 30_000)
        ring.append(ResourceSample(t: 70_000, cpu: 0.1, mem: 3), now: 70_000)
        XCTAssertEqual(ring.snapshot(now: 70_000).map(\.mem), [2, 3])
    }

    func testHardCapKeepsNewest() {
        let ring = ResourceRingBuffer(windowSec: 100_000, honorsKillGate: false)
        for i in 0..<(ResourceRingBuffer.maxSamples + 50) {
            ring.append(ResourceSample(t: Int64(i), cpu: nil, mem: Int64(i)), now: 0)
        }
        let snap = ring.snapshot(now: 0)
        XCTAssertEqual(snap.count, ResourceRingBuffer.maxSamples)
        XCTAssertEqual(snap.last?.mem, Int64(ResourceRingBuffer.maxSamples + 49))
    }

    func testWindowChangeAppliesLive() {
        let ring = ResourceRingBuffer(windowSec: 60, honorsKillGate: false)
        ring.append(ResourceSample(t: 0, cpu: nil, mem: 1), now: 0)
        ring.append(ResourceSample(t: 30_000, cpu: nil, mem: 2), now: 30_000)
        ring.windowSec = 10
        XCTAssertEqual(ring.snapshot(now: 30_000).map(\.mem), [2])
    }

    func testClear() {
        let ring = ResourceRingBuffer(windowSec: 60, honorsKillGate: false)
        ring.append(ResourceSample(t: 0, cpu: nil, mem: 1), now: 0)
        ring.clear()
        XCTAssertTrue(ring.snapshot(now: 0).isEmpty)
    }

    // Fraction of ONE core: a delta of one second of CPU over one second of
    // wall time is 1.0, and two cores fully busy is 2.0.
    func testCPUFractionArithmetic() {
        XCTAssertEqual(ResourceWindowSampler.cpuFraction(cpuDeltaSec: 1.0, wallDeltaSec: 1.0), 1.0, accuracy: 0.001)
        XCTAssertEqual(ResourceWindowSampler.cpuFraction(cpuDeltaSec: 2.0, wallDeltaSec: 1.0), 2.0, accuracy: 0.001)
        XCTAssertEqual(ResourceWindowSampler.cpuFraction(cpuDeltaSec: 0.5, wallDeltaSec: 2.0), 0.25, accuracy: 0.001)
    }

    // A CPU delta across a suspended app reports the whole frozen gap as
    // usage. The baseline must reset on resume so the next sample measures
    // its own interval.
    func testBaselineResetProducesNoSampleForTheFrozenGap() {
        let sampler = ResourceWindowSampler(windowProvider: { 60 })
        sampler.noteResumed(atWallSec: 1000, cpuSec: 5)
        let f = sampler.fractionSinceBaseline(atWallSec: 1002, cpuSec: 6)
        XCTAssertEqual(f, 0.5, accuracy: 0.001)
    }

    // Fix round 1, CRITICAL 2. `TASK_THREAD_TIMES_INFO` aggregates cpu time
    // for LIVE THREADS ONLY — a thread that had accrued time exiting between
    // two samples makes the aggregate DECREASE, so `cpuSec - baselineCpuSec`
    // can legitimately go negative. Shipping that verbatim fails the
    // schema's `cpu: z.number().min(0)...` and rejects the WHOLE report,
    // non-retryably. The safe seam must ship nil (an honest "no valid
    // sample"), never a fabricated negative number.
    func testNegativeCPUDeltaShipsNilNotAFabricatedNumber() {
        let sampler = ResourceWindowSampler(windowProvider: { 60 })
        sampler.noteResumed(atWallSec: 1000, cpuSec: 5)
        // cpuSec DECREASED relative to the baseline.
        let f = sampler.safeFractionSinceBaseline(atWallSec: 1002, cpuSec: 4)
        XCTAssertNil(f, "a negative cpu delta must ship nil, never a fabricated negative fraction")
    }

    // A negative reading must still move the baseline forward — the next
    // sample measures only ITS OWN interval, never compounding the stale
    // reading. Proven by a second call whose expected result (0.5) is only
    // correct if the baseline actually moved to (1002, 4), not (1000, 5).
    func testNegativeCPUDeltaStillRebaselinesForTheNextSample() {
        let sampler = ResourceWindowSampler(windowProvider: { 60 })
        sampler.noteResumed(atWallSec: 1000, cpuSec: 5)
        XCTAssertNil(sampler.safeFractionSinceBaseline(atWallSec: 1002, cpuSec: 4))

        let f = sampler.safeFractionSinceBaseline(atWallSec: 1003, cpuSec: 4.5)
        XCTAssertEqual(f ?? -1, 0.5, accuracy: 0.001)
    }

    // A clock anomaly producing a huge cpu delta over a tiny wall delta
    // (not a real multicore reading) must be clamped to the schema's
    // ceiling, never shipped verbatim past it — an over-ceiling sample
    // rejects the whole report exactly like a negative one.
    func testOverCeilingCPUFractionIsClampedToTheSchemaCeiling() {
        let sampler = ResourceWindowSampler(windowProvider: { 60 })
        sampler.noteResumed(atWallSec: 1000, cpuSec: 0)
        let f = sampler.safeFractionSinceBaseline(atWallSec: 1000.001, cpuSec: 5000)
        XCTAssertEqual(f, ResourceWindowSampler.maxCPUCores)
    }
}
