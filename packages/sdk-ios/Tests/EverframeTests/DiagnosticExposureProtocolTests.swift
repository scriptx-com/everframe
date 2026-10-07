// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
import EverframeProtocol

final class DiagnosticExposureProtocolTests: XCTestCase {
    func testLegacyInitializerDoesNotRequireAnExposure() throws {
        let source = try EverframeDiagnosticEvidence("""
        {"version":1,"evidenceId":"11111111-1111-4111-8111-111111111111","processLaunchId":"22222222-2222-4222-8222-222222222222","kind":"process_exit","provenance":"android_application_exit_info","scope":"os_process","outcome":"terminated","cause":"anr","occurredAt":"2026-10-07T10:00:00.000Z","collectedAt":"2026-10-07T10:01:00.000Z","attribution":{"process":"exact_os_token","release":"frozen","session":"unavailable","webExposure":"unavailable"},"android":{"apiLevel":35,"reason":6,"pid":100},"trace":{"status":"unavailable","format":"none","truncated":false,"frames":[]}}
        """)
        let copy = EverframeDiagnosticEvidence(android: source.android, attribution: source.attribution,
            cause: source.cause, collectedAt: source.collectedAt, evidenceID: source.evidenceID,
            kind: source.kind, occurredAt: source.occurredAt, outcome: source.outcome,
            processLaunchID: source.processLaunchID, provenance: source.provenance,
            scope: source.scope, trace: source.trace, version: source.version)
        XCTAssertNil(copy.nativeExposure)
        XCTAssertEqual(copy.processLaunchID, source.processLaunchID)
    }
}
