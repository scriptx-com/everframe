// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

enum AsyncTestHelpers {
    /// Polls `predicate` every 10ms until it holds or `timeout` elapses.
    ///
    /// The default is 30s (1s -> 10s -> 30s on 2026-08-10). Because this returns
    /// the instant the predicate holds, the ceiling costs a fast machine
    /// nothing — it only decides how long we are willing to wait on a slow
    /// one. At 1s, `ReplaySessionSupersessionTests`
    /// `supersedingStartTearsDown…` failed on a contended CI simulator with
    /// "Expectation failed: aReachedFetch": session A's initial fetch had
    /// simply not started yet, in a test whose actual subject is teardown
    /// ordering and has no timing claim in it. The whole run took ~50s, so the
    /// machine was plainly loaded.
    ///
    /// No caller expects this to return false — a timeout is always a failed
    /// test, never an assertion — so a generous ceiling cannot slow the suite
    /// in the passing case. Callers that DO mean the duration as the claim
    /// (`StartPerfTests` bounding heavy-init) pass an explicit timeout, and
    /// should keep doing so.
    ///
    /// 10s was still not enough: `ReplaySessionTeardownRaceTests`
    /// `staleInitialFetchCompletingAfterTeardownCannotArmTheGlobalBodyGate`
    /// then failed on "Expectation failed: reachedFetch" — waiting for a
    /// spawned Task to reach a parked fetch, on a simulator busy enough that
    /// the whole 58-test run took 44s. 30s matches the budget the equivalent
    /// Android guard uses (ReplaySessionGenerationRaceTest's
    /// COORDINATION_TIMEOUT_MS), so the two platforms now agree on how patient
    /// an interleaving guard should be.
    static func waitFor(_ predicate: @escaping () -> Bool, timeout: TimeInterval = 30.0) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if predicate() { return true }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return predicate()
    }
}
