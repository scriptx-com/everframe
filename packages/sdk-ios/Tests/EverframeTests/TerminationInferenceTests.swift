// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
import CryptoKit
import EverframeProtocol
@testable import EverframeKit

final class TerminationInferenceTests: XCTestCase {
    private let base = Date(timeIntervalSince1970: 1_760_000_000)
    private let identity = TerminationStateFileTests.identity
    private func record(_ edit: (inout TerminationRunRecord) -> Void = { _ in }) -> TerminationRunRecord {
        var value = TerminationRunRecord(launchID: UUID(), identity: identity, startedAt: base)
        value.appState = .active; value.stateChangedAt = base.addingTimeInterval(10); value.armed = true; value.contextID = UUID()
        value.sampledAt = base.addingTimeInterval(60); value.footprintBytes = 300 << 20; value.availableBytes = 900 << 20
        edit(&value); return value
    }
    private func verdict(_ value: TerminationRunRecord, current: TerminationIdentity? = nil, after: TimeInterval = 120) -> TerminationInference.Verdict {
        TerminationInference.evaluate(value, current: current ?? identity, now: base.addingTimeInterval(after))
    }

    func testActiveArmedRunWithoutEvidenceIsUnexplained() { XCTAssertEqual(verdict(record()), .inferred(.unexplained)) }
    func testRecentMemoryWarningIsLowMemory() { XCTAssertEqual(verdict(record { $0.memoryWarnings = 1; $0.lastWarningAt = self.base.addingTimeInterval(30) }), .inferred(.lowMemory)) }
    func testWarningOlderThanSixtySecondsBeforeLastSeenDoesNotCount() { XCTAssertEqual(verdict(record { $0.memoryWarnings = 1; $0.lastWarningAt = self.base.addingTimeInterval(-1) }), .inferred(.unexplained)) }
    func testRecentCriticalPressureIsLowMemory() { XCTAssertEqual(verdict(record { $0.pressure = .critical; $0.pressureChangedAt = self.base.addingTimeInterval(50) }), .inferred(.lowMemory)) }
    func testWarningPressureAloneIsNotMemoryEvidence() { XCTAssertEqual(verdict(record { $0.pressure = .warning; $0.pressureChangedAt = self.base.addingTimeInterval(50) }), .inferred(.unexplained)) }
    func testHeadroomAtTwentyPercentIsLowMemoryAndAboveIsNot() {
        XCTAssertEqual(verdict(record { $0.footprintBytes = 800; $0.availableBytes = 200 }), .inferred(.lowMemory))
        XCTAssertEqual(verdict(record { $0.footprintBytes = 799; $0.availableBytes = 201 }), .inferred(.unexplained))
        XCTAssertEqual(verdict(record { $0.footprintBytes = 900; $0.availableBytes = nil }), .inferred(.unexplained))
        XCTAssertEqual(verdict(record { $0.footprintBytes = 900; $0.availableBytes = 0 }), .inferred(.lowMemory))
        XCTAssertEqual(verdict(record { $0.footprintBytes = 0; $0.availableBytes = 0 }), .inferred(.unexplained))
    }
    func testStallWithoutMemoryEvidenceIsUnresponsive() { XCTAssertEqual(verdict(record { $0.mainStallMs = 5000 }), .inferred(.unresponsive)) }
    func testMemoryEvidenceWinsOverStall() { XCTAssertEqual(verdict(record { $0.mainStallMs = 9000; $0.footprintBytes = 900; $0.availableBytes = 100 }), .inferred(.lowMemory)) }
    func testInactiveOrLaunchingNeedsAStall() {
        for state in [TerminationAppState.inactive, .launching] {
            XCTAssertEqual(verdict(record { $0.appState = state }), .skip(.notForeground))   // app switcher force-quit
            XCTAssertEqual(verdict(record { $0.appState = state; $0.mainStallMs = 4999 }), .skip(.notForeground))
            XCTAssertEqual(verdict(record { $0.appState = state; $0.mainStallMs = 5000 }), .inferred(.unresponsive))
        }
    }
    func testBackgroundAndUnknownAreSkipped() {
        XCTAssertEqual(verdict(record { $0.appState = .background; $0.mainStallMs = 9000 }), .skip(.notForeground))
        XCTAssertEqual(verdict(record { $0.appState = .unknown }), .skip(.notForeground))
    }
    func testExitAndTerminateAreCleanExits() {
        XCTAssertEqual(verdict(record { $0.exitCalled = true }), .skip(.cleanExit))
        XCTAssertEqual(verdict(record { $0.terminateNotified = true }), .skip(.cleanExit))
    }
    func testDebuggerSeenIsSkipped() { XCTAssertEqual(verdict(record { $0.debuggerSeen = true }), .skip(.debugger)) }
    func testNotArmedIsSkipped() { XCTAssertEqual(verdict(record { $0.armed = false }), .skip(.notArmed)) }
    func testArmedWithoutContextIsSkipped() { XCTAssertEqual(verdict(record { $0.contextID = nil }), .skip(.notArmed)) }
    func testAnyAppIdentityChangeIsSkipped() {
        for edit: (inout TerminationIdentity) -> Void in [{ $0.appVersion = "1.2.4" }, { $0.appBuild = "46" }, { $0.executableUUID = UUID() }] {
            var current = identity; edit(&current)
            XCTAssertEqual(verdict(record(), current: current), .skip(.appChanged))
        }
        var missing = identity; missing.executableUUID = nil
        XCTAssertEqual(verdict(record { $0.identity.executableUUID = nil }, current: missing), .skip(.appChanged))
    }
    func testOSChangeIsSkipped() { var current = identity; current.osVersion = "Version 26.6 (Build 23M1)"; XCTAssertEqual(verdict(record(), current: current), .skip(.osChanged)) }
    func testBootTimeOutsideJitterIsAReboot() {
        var current = identity; current.bootTime += 30; XCTAssertEqual(verdict(record(), current: current), .inferred(.unexplained))
        current.bootTime += 1; XCTAssertEqual(verdict(record(), current: current), .skip(.rebooted))
        current.bootTime = identity.bootTime - 31; XCTAssertEqual(verdict(record(), current: current), .skip(.rebooted))
        current.bootTime = 0; XCTAssertEqual(verdict(record(), current: current), .skip(.rebooted))
    }
    func testStaleAndFutureRecordsAreSkipped() {
        XCTAssertEqual(verdict(record(), after: 60 + 14 * 86_400 + 1), .skip(.stale))
        XCTAssertEqual(verdict(record(), after: 60 + 14 * 86_400), .inferred(.unexplained))
        XCTAssertEqual(verdict(record { $0.sampledAt = self.base.addingTimeInterval(120 + 301) }), .skip(.stale))
        XCTAssertEqual(verdict(record { $0.sampledAt = self.base.addingTimeInterval(120 + 300) }), .inferred(.unexplained))
    }
    func testFingerprintsDeriveFromTypeAndCause() {
        for cause in [TerminationInference.Cause.lowMemory, .unresponsive, .unexplained] {
            let digest = SHA256.hash(data: Data("\(cause.exceptionType)|apple_inferred_\(cause.rawValue)".utf8)).map { String(format: "%02x", $0) }.joined()
            XCTAssertEqual(cause.fingerprint, String(digest.prefix(16)))
            XCTAssertNotEqual(cause.fingerprint, "e23830aadf486dc3")
        }
    }
    func testMessagesCarryKiBAndTheInferredLabel() {
        let value = record { $0.footprintBytes = 1_400_000_000; $0.availableBytes = 40_000_000; $0.memoryWarnings = 2; $0.mainStallMs = 7400 }
        XCTAssertEqual(TerminationInference.message(.lowMemory, value),
            "Killed for low memory while in the foreground (inferred, footprint 1367187 KiB, 39062 KiB available, 2 memory warnings)")
        XCTAssertTrue(TerminationInference.message(.unresponsive, value).hasPrefix("Terminated after the main thread stopped responding for 7 s in the foreground (inferred"))
        XCTAssertEqual(TerminationInference.message(.unexplained, record { $0.footprintBytes = nil; $0.availableBytes = nil }),
            "Terminated in the foreground without a crash report (inferred)")
        XCTAssertTrue(TerminationInference.message(.lowMemory, record { $0.memoryWarnings = 1 }).hasSuffix(", 1 memory warning)"))
    }
    func testEvidenceAttachesOnlyThisProcessExposure() throws {
        let value = record { $0.mainStallMs = 0; $0.thermalState = 2; $0.pressure = .warning }
        let mine = EverframeNativeExposure(exposureID: UUID().uuidString.lowercased(), loadedBuildID: nil, loadedBundleStatus: .notApplicable,
            nativeBuildID: "native-A", processLaunchID: value.launchID.uuidString.lowercased(), startedAt: base)
        let other = mine.with(processLaunchID: UUID().uuidString.lowercased())
        let seen = base.addingTimeInterval(60), collected = base.addingTimeInterval(120)
        let evidence = TerminationInference.evidence(record: value, cause: .unexplained, evidenceID: "id", lastSeen: seen, collectedAt: collected, exposure: mine)
        XCTAssertEqual(evidence.nativeExposure?.exposureID, mine.exposureID)
        XCTAssertEqual(evidence.processLaunchID, value.launchID.uuidString.lowercased())
        XCTAssertEqual(evidence.apple.appState, .active); XCTAssertEqual(evidence.apple.thermalState, .serious)
        XCTAssertEqual(evidence.apple.memoryPressure, .warning); XCTAssertNil(evidence.apple.mainThreadStallMS)
        XCTAssertEqual(evidence.apple.footprintKB, 300 * 1024); XCTAssertEqual(evidence.apple.availableKB, 900 * 1024)
        XCTAssertEqual(evidence.cause, .unexplained); XCTAssertEqual(evidence.lastSeenAt, seen); XCTAssertEqual(evidence.collectedAt, collected)
        XCTAssertNil(TerminationInference.evidence(record: value, cause: .unexplained, evidenceID: "id", lastSeen: seen,
            collectedAt: collected, exposure: other).nativeExposure)
    }
}
