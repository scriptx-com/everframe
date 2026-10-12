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

/// A phone scanning the QR code, and a dashboard member attaching.
private let qrBond = #"{"type":"pair.bonded","pair_id":"p"}"#
private let memberBond = #"""
    {"type":"pair.bonded","pair_id":"p2","attribution_token":"attr_1","companion_user":{"display_name":"Ada L."}}
    """#

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

    private var upgraded: Bool { Everframe.shared.crashOnlyCoverageState.upgraded }

    private func frameClient() -> RelayWSClient {
        RelayWSClient(endpoint: URL(string: "https://relay.example.com")!, companion: CompanionAPI(),
            sdkKey: nil, deviceLabel: nil, announceTransport: nil)
    }

    @Test(arguments: [qrBond, memberBond])
    func aCompanionBondUpgradesTheCrashOnlySessionUntilTheNextStartOrKill(bond: String) async throws {
        try await withGlobalCaptureStateLock {
            defer { Self.stop() }
            let client = frameClient()

            client.handleControl(bond)
            #expect(!upgraded, "a bond before start() upgrades nothing")

            try Everframe.shared.start(config: Self.config(reporterEnabled: false))
            #expect(!upgraded)
            client.handleControl(bond)
            #expect(upgraded)

            // A detach does not downgrade, and the reporter stays off after an upgrade.
            client.handleControl(#"{"type":"phone.disconnected","pair_id":"p"}"#)
            client.handleControl(#"{"type":"pair.expired","pair_id":"p","reason":"inactivity"}"#)
            #expect(upgraded)
            await #expect(throws: EverframeReporterError.reporterDisabled) {
                try await Everframe.shared.report.open()
            }

            // The next start() is a new crash-only session.
            try Everframe.shared.start(config: Self.config(reporterEnabled: false))
            #expect(!upgraded)
            client.handleControl(bond)
            #expect(upgraded)

            Everframe.shared.kill()
            #expect(!upgraded)
            client.handleControl(bond)
            #expect(!upgraded, "a bond after kill() upgrades nothing")
        }
    }

    @Test func aBondInAReportSessionChangesNothing() async throws {
        try await withGlobalCaptureStateLock {
            defer { Self.stop() }
            try Everframe.shared.start(config: Self.config(reporterEnabled: true))
            frameClient().handleControl(qrBond)
            #expect(!upgraded)
        }
    }

    @Test func theReporterDisabledErrorSaysWhichSettingTurnedItOff() {
        #expect(EverframeReporterError.reporterDisabled.localizedDescription
            == "The reporter is turned off for this session (reporterEnabled: false).")
    }
}
