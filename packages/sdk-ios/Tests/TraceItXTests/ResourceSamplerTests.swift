// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
import TraceItXProtocol
@testable import TraceItXKit

final class ResourceSamplerTests: XCTestCase {
    private let queue = DispatchQueue(label: "test.vitals")
    private var now: Int64 = 1_000_000
    private var cpuNs: UInt64 = 0
    /// The CPU denominator's own clock (round-4, M6). Advanced with `elapse(_:)` below, which is
    /// what a run of the real thing looks like; a test that moves ONLY `now` is modelling a
    /// wall-clock adjustment.
    private var monoNs: UInt64 = 1_000_000_000
    private var samples: [VitalsSample] = []
    private var ticks = 0

    private func sampler(intervalMs: Int64 = 20_000) -> ResourceSampler {
        let box = self
        return ResourceSampler(queue: queue, intervalMs: intervalMs, now: { box.now },
                               readCpuTimeNs: { box.cpuNs }, readMonotonicNs: { box.monoNs }, readMemBytes: { 123 },
                               readAvailableMemory: { 456 }, readThermalState: { 2 },
                               onSample: { s in box.samples.append(s) }, onTick: { box.ticks += 1 })
    }
    private func drain() { queue.sync {} }
    /// Move both clocks forward by the same real interval.
    private func elapse(_ ms: Int64) { now += ms; monoNs += UInt64(ms) * 1_000_000 }

    func testFirstTickHasNoCpuLaterTicksCarryTheFractionOfOneCore() {
        let s = sampler(); s.start()
        s.tickNowForTesting(); drain()
        XCTAssertEqual(samples.count, 1); XCTAssertNil(samples[0].cpu)
        XCTAssertEqual(samples[0].mem, 123)
        XCTAssertEqual(samples[0].extras?["availableMemory"], 456); XCTAssertEqual(samples[0].extras?["thermalState"], 2)
        elapse(20_000); cpuNs += 10_000 * 1_000_000   // 10 s of CPU in 20 s of real time → 0.5
        s.tickNowForTesting(); drain()
        XCTAssertEqual(samples[1].cpu!, 0.5, accuracy: 0.0001)
        XCTAssertEqual(ticks, 2)
        s.stop()
    }
    func testPauseStopsSamplingResumeRestartsWithNoCpuOnTheFirstTickAfterResume() {
        let s = sampler(); s.start()
        s.tickNowForTesting(); drain(); elapse(20_000); cpuNs += 1_000_000_000; s.tickNowForTesting(); drain()
        XCTAssertNotNil(samples[1].cpu)
        s.pause(); s.tickNowForTesting(); drain()
        XCTAssertEqual(samples.count, 2)
        s.resume(); elapse(20_000); cpuNs += 1_000_000_000; s.tickNowForTesting(); drain()
        XCTAssertEqual(samples.count, 3); XCTAssertNil(samples[2].cpu)
        s.stop()
    }
    func testStopCancelsTheTickAndStartAfterStopIsANoOp() {
        let s = sampler(); s.start(); s.stop(); s.start(); s.tickNowForTesting(); drain()
        XCTAssertEqual(samples.count, 0)
    }
    func testAFailingReaderDoesNotKillTheCadence() {
        // A reader cannot throw in Swift; the equivalent hazard is a reader returning garbage.
        let s = ResourceSampler(queue: queue, intervalMs: 20_000, now: { [self] in now }, readCpuTimeNs: { 0 },
                                readMonotonicNs: { [self] in monoNs },
                                readMemBytes: { -5 }, readAvailableMemory: { nil }, readThermalState: { 0 },
                                onSample: { [self] in samples.append($0) }, onTick: {})
        s.start(); s.tickNowForTesting(); drain()
        XCTAssertEqual(samples[0].mem, 0)                       // clamped
        XCTAssertNil(samples[0].extras?["availableMemory"])     // absent, not NaN
        s.stop()
    }
    func testBackwardsCpuClockNeverProducesANegativeFraction() {
        let s = sampler(); s.start()
        cpuNs = 5_000_000_000; s.tickNowForTesting(); drain()
        elapse(20_000); cpuNs = 1_000_000_000; s.tickNowForTesting(); drain()
        XCTAssertEqual(samples[1].cpu, 0)
        s.stop()
    }
    /// Codex round-4, M6 — the CPU fraction's denominator was the entry's own epoch clock, so an
    /// adjustment landing between two ticks rewrote a utilisation the process never had: an
    /// hour's forward jump turned 0.5 into 0.0028, and a backward one dropped the sample.
    func testAWallClockAdjustmentDoesNotDistortTheCpuFraction() {
        let s = sampler(); s.start()
        s.tickNowForTesting(); drain()
        elapse(20_000); cpuNs += 10_000 * 1_000_000
        now += 3_600_000                          // …and the user (or NTP) moves the clock an hour
        s.tickNowForTesting(); drain()
        XCTAssertEqual(samples[1].cpu!, 0.5, accuracy: 0.0001)
        // A BACKWARD adjustment is the other half: it used to make the denominator non-positive,
        // so the sample carried no cpu at all.
        elapse(20_000); cpuNs += 5_000 * 1_000_000
        now -= 7_200_000
        s.tickNowForTesting(); drain()
        XCTAssertEqual(samples[2].cpu!, 0.25, accuracy: 0.0001)
        s.stop()
    }
    func testProcessResourcesReadersReturnPlausibleValuesOnThisHost() {
        XCTAssertGreaterThan(ProcessResources.cpuTimeNs(), 0)
        XCTAssertGreaterThan(ProcessResources.monotonicNs(), 0)
        XCTAssertGreaterThan(ProcessResources.physFootprintBytes(), 1_000_000)
        XCTAssertTrue((0...3).contains(ProcessResources.thermalState()))
    }
}
