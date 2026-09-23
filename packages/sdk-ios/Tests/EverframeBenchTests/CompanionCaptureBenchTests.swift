// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Phase 06.2-10 Task 1 — XCTest harness for the iOS capture bench.
//
// Runs 50 iterations against `CompanionCaptureBench.captureOnce()` and
// asserts p95 ≤ 1000 ms (SPEC Req 9 / RELAY-04 acceptance). On host macOS
// CI without a target device, the bench measures the pure bench-loop +
// PNG-synthesis overhead — the real acceptance gate is the UAT step that
// runs this same target on iPhone SE 2 + Apple TV 4K (Plan 06.2-10 Task 3).

import XCTest
@testable import EverframeBench

final class CompanionCaptureBenchTests: XCTestCase {

    func testCaptureLatencyP95UnderOneSecond() {
        let result = CompanionCaptureBench.runBench(count: 50)
        // Log the full histogram for the UAT checklist (read out of the
        // xcodebuild test output).
        let histogram = result.samples
            .map { Double($0.durationNanos) / 1_000_000.0 }
            .map { String(format: "%.2f", $0) }
            .joined(separator: ", ")
        print("CompanionCaptureBench histogram (ms): [\(histogram)]")
        print("CompanionCaptureBench p95 (ms): \(result.p95Millis)")

        // SPEC Req 9 acceptance: p95 ≤ 1000 ms on target hardware.
        XCTAssertLessThanOrEqual(
            result.p95Millis, 1000.0,
            "p95 \(result.p95Millis)ms exceeded 1000ms budget"
        )
    }
}
