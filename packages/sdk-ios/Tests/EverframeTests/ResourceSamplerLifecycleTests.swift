// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Report EverframeResource Window (spec 2026-09-05) — fix round 1, IMPORTANT 1.
// `testBaselineResetProducesNoSampleForTheFrozenGap` (ResourceRingBufferTests.swift,
// task-10-brief.md verbatim) only pins that `noteResumed` STORES a baseline
// when called directly — it never opens a real suspend gap and never
// invokes the actual foreground-resume notification handler. Worse: that
// handler's observer registration lives inside `ResourceWindowSampler.start()`,
// which is `#if canImport(UIKit)`-gated (`ResourceWindowSampler.swift`) — not
// compiled at all under `swift test` on the macOS host, so no host test can
// ever reach it regardless of what it asserts.
//
// UIKIT-ONLY (false pass on macOS): this whole file is gated the same way,
// matching the established convention (see
// `ReporterSubmissionMultiShotTests.swift`, `BreadcrumbAdaptersTests.swift`,
// `CompanionLifecycleNotificationTests.swift`). A macOS
// `swift test --filter ResourceSamplerLifecycleTests` run reports "0 tests,
// 0 failures" — green, but proves nothing. Real evidence comes from the iOS
// Simulator suite:
//
//   cd packages/sdk-ios && xcodegen generate
//   SIM_UDID=$(xcrun simctl list devices available -j | python3 -c \
//     'import json,sys; ds=json.load(sys.stdin)["devices"]; print(next((d["udid"] \
//     for rt in sorted(ds) if "iOS" in rt for d in ds[rt] if d.get("isAvailable") \
//     and d["name"].startswith("iPhone")), ""))')
//   xcodebuild test -scheme Everframe-Package -destination "id=$SIM_UDID" \
//     -only-testing:EverframeTests/ResourceSamplerLifecycleTests
#if canImport(UIKit)
import XCTest
import UIKit
@testable import EverframeKit

final class ResourceSamplerLifecycleTests: XCTestCase {
    /// Drives the REAL production observer registered by `start()` — posts
    /// the exact notification `UIApplication` sends on resume, exactly like
    /// `CompanionLifecycleNotificationTests.swift`/`BreadcrumbAdaptersTests.swift`
    /// already do for their own lifecycle observers. `queue: nil` at
    /// registration (`ResourceWindowSampler.swift`) means the handler runs
    /// SYNCHRONOUSLY on the posting thread — no `await`/sleep needed for
    /// delivery.
    ///
    /// Deliberately does NOT try to predict the exact fraction a subsequent
    /// tick would compute (the real mach cpu-time/wall-clock magnitudes at
    /// the moment this test happens to run are unknowable and would make
    /// any threshold either flaky or accidentally satisfied by the BUGGY
    /// behaviour too — a stale (0, 0) baseline's fraction is
    /// `realCpuTimeUsed / realProcessUptime`, which is typically ALSO small,
    /// so asserting "the fraction is small" would not reliably distinguish
    /// fixed from broken). Instead this bounds the baseline's WALL-CLOCK
    /// INSTANT tightly between two real `ProcessInfo.systemUptime` reads
    /// taken immediately before/after posting the notification — a
    /// deterministic, non-vacuous proof that `resumeFromForeground()` moved
    /// the baseline to NOW, discarding whatever arbitrary anchor preceded
    /// it, rather than leaving the frozen gap in place to be reported as
    /// usage by the next tick.
    func testWillEnterForegroundNotificationResetsTheBaselineToNow() throws {
        let sampler = ResourceWindowSampler(windowProvider: { 60 })
        sampler.start()
        defer { sampler.stop() }

        // Deliberately ancient/wrong anchor — simulates whatever the
        // sampler last recorded long before backgrounding (the same stale-
        // baseline shape `testBaselineResetProducesNoSampleForTheFrozenGap`
        // pins directly; here it is overwritten through the REAL
        // notification path instead of a second direct `noteResumed` call).
        // Must run AFTER `start()`: `start()` itself resets `hasBaseline`
        // to false, so seeding before it would be immediately erased.
        sampler.noteResumed(atWallSec: 0, cpuSec: 0)

        let beforePost = ProcessInfo.processInfo.systemUptime
        NotificationCenter.default.post(name: UIApplication.willEnterForegroundNotification, object: nil)
        let afterPost = ProcessInfo.processInfo.systemUptime

        let resetWall = try XCTUnwrap(
            sampler.baselineWallSecForTesting,
            "no baseline at all after the foreground notification fired — the observer either never ran or its mach cpu-time read failed"
        )
        XCTAssertGreaterThanOrEqual(
            resetWall, beforePost,
            """
            the baseline must be reset to NOW on foreground resume (\(resetWall) is not >= \(beforePost)) — \
            an unreset baseline still anchored at the old (0, 0) value would report the ENTIRE elapsed \
            wall-clock age of the process as usage on the very next sample
            """
        )
        XCTAssertLessThanOrEqual(
            resetWall, afterPost,
            "the reset baseline's wall instant must not be AFTER the notification finished posting"
        )
    }
}
#endif
