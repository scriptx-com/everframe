// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// MAI meter Plan 2b-ii, D3 + opt-out parity. Two contracts:
//
//   1. The identifier rides at most one config read per UTC day. Dedupe is an
//      OPTIMISATION — the server's unique constraint makes repeat sends free
//      and it deduplicates per calendar MONTH, so a lost day costs nothing.
//      Nothing here may retry or queue.
//   2. Opt-out is a CLIENT VETO: when off, nothing is derived, nothing is
//      stored, and nothing is sent. It can never force the identifier on.
//
// The clock is injected in every case — this suite contains no sleeps.
import XCTest
@testable import TraceItXKit

final class InstallIdentifierDailyTests: XCTestCase {
    private let daySec: TimeInterval = 86_400

    private func freshDefaults(_ name: String = #function) -> UserDefaults {
        let suite = "com.traceitx.tests.installid.daily.\(name).\(UUID().uuidString)"
        UserDefaults().removePersistentDomain(forName: suite)
        return UserDefaults(suiteName: suite)!
    }

    func test_yields_the_identifier_on_the_first_call_of_a_day() {
        let defaults = freshDefaults()
        let supplier = InstallIdentifier.makeSupplier(
            enabled: true, defaults: defaults, now: { Date(timeIntervalSince1970: 10 * self.daySec) }
        )
        XCTAssertEqual(supplier(), InstallIdentifier.current(defaults: defaults))
    }

    func test_yields_nothing_on_a_second_call_the_same_day() {
        let defaults = freshDefaults()
        let supplier = InstallIdentifier.makeSupplier(
            enabled: true, defaults: defaults, now: { Date(timeIntervalSince1970: 10 * self.daySec) }
        )
        XCTAssertNotNil(supplier())
        XCTAssertNil(supplier())
        XCTAssertNil(supplier())
    }

    func test_yields_again_once_the_utc_day_rolls_over() {
        let defaults = freshDefaults()
        nonisolated(unsafe) var seconds = 10 * daySec
        let supplier = InstallIdentifier.makeSupplier(
            enabled: true, defaults: defaults, now: { Date(timeIntervalSince1970: seconds) }
        )
        XCTAssertNotNil(supplier())
        seconds = 11 * daySec - 0.001   // last instant of the same UTC day
        XCTAssertNil(supplier())
        seconds = 11 * daySec           // first instant of the next UTC day
        XCTAssertNotNil(supplier())
    }

    func test_the_marker_is_recorded_at_hand_over_not_on_a_successful_response() {
        let defaults = freshDefaults()
        _ = InstallIdentifier.makeSupplier(
            enabled: true, defaults: defaults, now: { Date(timeIntervalSince1970: 10 * self.daySec) }
        )()
        XCTAssertEqual(defaults.string(forKey: InstallIdentifier.defaultsDayKey), "10")
    }

    func test_a_malformed_marker_is_treated_as_not_sent_today() {
        // Over-sending is free — the server's unique constraint absorbs it.
        // Trusting garbage could suppress an install for a whole month.
        let defaults = freshDefaults()
        defaults.set("not-a-number", forKey: InstallIdentifier.defaultsDayKey)
        let supplier = InstallIdentifier.makeSupplier(
            enabled: true, defaults: defaults, now: { Date(timeIntervalSince1970: 10 * self.daySec) }
        )
        XCTAssertNotNil(supplier())
    }

    func test_disabled_yields_nothing_and_writes_nothing_at_all() {
        let defaults = freshDefaults()
        let supplier = InstallIdentifier.makeSupplier(
            enabled: false, defaults: defaults, now: { Date(timeIntervalSince1970: 10 * self.daySec) }
        )
        XCTAssertNil(supplier())
        // Nothing derived, nothing stored: neither the seed nor the marker.
        XCTAssertNil(defaults.string(forKey: InstallIdentifier.defaultsKey))
        XCTAssertNil(defaults.string(forKey: InstallIdentifier.defaultsDayKey))
    }

    func test_the_config_flag_defaults_to_enabled() {
        XCTAssertTrue(TraceItXConfig(appId: "txx_live_" + String(repeating: "x", count: 32))
            .installIdentifierEnabled)
    }

    func test_the_config_flag_can_be_turned_off() {
        let cfg = TraceItXConfig(
            appId: "txx_live_" + String(repeating: "x", count: 32),
            installIdentifierEnabled: false
        )
        XCTAssertFalse(cfg.installIdentifierEnabled)
    }
}
