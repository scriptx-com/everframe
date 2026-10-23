// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Crash-only sessions (spec 2026-10-12): `EverframeConfig.reporterEnabled == false` turns off
// every on-device way to open the reporter. Host-runnable; the replay half is in
// `CrashOnlyReplayTests`, which needs UIKit.
import Foundation
import Testing
@testable import EverframeKit

private final class ResolverCalls: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func record() { lock.lock(); count += 1; lock.unlock() }
    var value: Int { lock.lock(); defer { lock.unlock() }; return count }
}

@Suite(.serialized)
@MainActor
struct CrashOnlySessionTests {
    /// `kill()` leaves the last config installed; clear it so a later suite's
    /// session never reads this suite's crash-only config.
    private static func stop() {
        Everframe.shared.kill()
        Everframe.__setConfigForTesting(nil)
    }

    private static func config(reporterEnabled: Bool) -> EverframeConfig {
        EverframeConfig(sdkKey: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU", capture: CaptureConfig(logs: false),
            releaseHealth: nil, reporterEnabled: reporterEnabled)
    }

    @Test func openThrowsReporterDisabledInACrashOnlySessionWithoutReachingThePresenter() async throws {
        try await withGlobalCaptureStateLock {
            let saved = ReportAPI.__resolver
            let calls = ResolverCalls()
            ReportAPI.__resolver = { calls.record(); return .cancelled }
            defer { ReportAPI.__resolver = saved; Self.stop() }

            try Everframe.shared.start(config: Self.config(reporterEnabled: false))
            await #expect(throws: EverframeReporterError.reporterDisabled) {
                try await Everframe.shared.report.open()
            }
            #expect(calls.value == 0)

            // A report session opens the presenter exactly as before.
            try Everframe.shared.start(config: Self.config(reporterEnabled: true))
            guard case .cancelled = try await Everframe.shared.report.open() else {
                Issue.record("a report session did not reach the presenter"); return
            }
            #expect(calls.value == 1)
        }
    }

    @Test func theReporterDisabledErrorSaysWhichSettingTurnedItOff() {
        #expect(EverframeReporterError.reporterDisabled.localizedDescription
            == "The reporter is turned off for this session (reporterEnabled: false).")
    }
}
