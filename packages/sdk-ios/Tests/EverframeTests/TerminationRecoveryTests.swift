// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
import EverframeProtocol
@testable import EverframeKit

final class TerminationRecoveryTests: XCTestCase {
    private var directory: URL!
    private let key = Data(repeating: 0x47, count: 32)
    private let base = Date(timeIntervalSince1970: 1_760_000_000)
    private let identity = TerminationStateFileTests.identity
    private var root: URL { directory.appendingPathComponent("recovery") }
    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: directory) }
    private func recovery() throws -> NativeCrashRecovery { let key = key; return try NativeCrashRecovery(rootURL: root, activeRunIDs: [], keyProvider: { key }) }
    private func box() -> JSONLOutbox { let key = key; return JSONLOutbox(fileURL: directory.appendingPathComponent("queue"), maxEntries: 50, keyProvider: { key }) }
    private func context(_ now: TimeInterval = 120) -> TerminationInference.Context { .init(current: identity, now: base.addingTimeInterval(now)) }
    /// A killed process: armed, active, 1.4 GB footprint and 40 MB headroom at its last sample.
    private func killedRun(sampledAt: TimeInterval = 60) throws -> (NativeCrashRecovery.Run, UUID) {
        let live = try recovery(), run = try live.prepareRun(now: base, terminationState: true)
        let contextID = try live.writeContext(NativeRecoveryTestData.context(), runID: run.id)
        let state = try XCTUnwrap(run.terminationState)
        state.writeHeader(launchID: UUID(), identity: identity, startedAt: base)
        state.store(TerminationAppState.active.rawValue, at: TerminationLayout.appStateAt)
        state.store(base.addingTimeInterval(10), at: TerminationLayout.stateChangedAt)
        state.store(1_400_000_000, at: TerminationLayout.footprintAt); state.store(40_000_000, at: TerminationLayout.availableAt)
        state.store(base.addingTimeInterval(sampledAt), at: TerminationLayout.sampledAt)
        state.arm(contextID: contextID)
        return (run, contextID)
    }

    func testEligibleRunWithoutReportQueuesOneAnonymousStacklessFatal() throws {
        let (run, _) = try killedRun()
        guard case .queued(let id) = try recovery().recover(runID: run.id, outbox: box(), inference: context()) else { return XCTFail("not queued") }
        let entry = try XCTUnwrap(box().hydrate().first)
        XCTAssertEqual(entry.reportId, id); XCTAssertEqual(entry.sdkKey, "sdk-A"); XCTAssertNil(entry.identitySubject)
        XCTAssertEqual(entry.endpoint, "https://example.invalid/api/ingest"); XCTAssertTrue(entry.attachmentRefs.isEmpty)
        let envelope = try EverframeReportEnvelope(data: entry.envelopeBytes), crash = try XCTUnwrap(envelope.payload.crash)
        let evidence = try XCTUnwrap(envelope.payload.inferredTermination)
        XCTAssertEqual(envelope.source, .crash); XCTAssertNil(envelope.reporter.user); XCTAssertNil(envelope.sessionID)
        XCTAssertTrue(envelope.attachments.isEmpty); XCTAssertNil(envelope.payload.breadcrumbs); XCTAssertNil(envelope.payload.logs)
        XCTAssertEqual(crash.exceptionType, "Low memory kill"); XCTAssertEqual(crash.fingerprint, "165254e7d389a4b6")
        XCTAssertEqual(crash.mechanism, "apple-termination-inference"); XCTAssertEqual(crash.frames.count, 0)
        XCTAssertEqual(crash.fatal, true); XCTAssertFalse(crash.handled); XCTAssertNil(crash.native)
        XCTAssertEqual(crash.message, "Killed for low memory while in the foreground (inferred, footprint 1367187 KiB, 39062 KiB available)")
        XCTAssertEqual(evidence.cause, .lowMemory); XCTAssertEqual(evidence.apple.footprintKB, 1_367_187); XCTAssertEqual(evidence.apple.availableKB, 39_062)
        XCTAssertEqual(evidence.evidenceID, id.uuidString.lowercased()); XCTAssertEqual(envelope.reportID, id.uuidString.lowercased())
        XCTAssertEqual(envelope.submittedAt, evidence.collectedAt); XCTAssertEqual(evidence.collectedAt, base.addingTimeInterval(120))
        XCTAssertEqual(crash.occurredAt, evidence.lastSeenAt); XCTAssertEqual(evidence.lastSeenAt, base.addingTimeInterval(60))
        XCTAssertNil(evidence.nativeExposure)   // the test context carries no release-health pointer
    }
    func testReceiptPreventsReinferenceAfterDrain() throws {
        let (run, _) = try killedRun()
        guard case .queued(let id) = try recovery().recover(runID: run.id, outbox: box(), inference: context()) else { return XCTFail("not queued") }
        try box().drain { _ in true }
        XCTAssertEqual(try recovery().recover(runID: run.id, outbox: box(), inference: context()), .alreadyImported(id))
        XCTAssertTrue(try box().hydrate().isEmpty)
    }
    func testInterruptedStageResumesWithoutReevaluating() throws {
        let (run, _) = try killedRun()
        enum Stop: Error { case interrupted }
        XCTAssertThrowsError(try recovery().recover(runID: run.id, outbox: box(), inference: context()) { if $0 == .staged { throw Stop.interrupted } })
        XCTAssertTrue(try box().hydrate().isEmpty)
        var rebooted = identity; rebooted.bootTime += 3600   // would now be ineligible
        guard case .queued = try recovery().recover(runID: run.id, outbox: box(), inference: .init(current: rebooted, now: base.addingTimeInterval(4000))) else { return XCTFail("stage not resumed") }
        XCTAssertEqual(try box().hydrate().count, 1)
    }
    func testAStagedInferenceResumesEvenWithoutAnInferenceContext() throws {
        let (run, _) = try killedRun()
        enum Stop: Error { case interrupted }
        XCTAssertThrowsError(try recovery().recover(runID: run.id, outbox: box(), inference: context()) { if $0 == .staged { throw Stop.interrupted } })
        // An older closed run is recovered without inference; its journal must still complete.
        guard case .queued = try recovery().recover(runID: run.id, outbox: box()) else { return XCTFail("stage not resumed") }
        XCTAssertEqual(try box().hydrate().count, 1)
    }
    func testCrashReportWinsOverTheStateFile() throws {
        let (run, contextID) = try killedRun()
        let reports = run.recorderURL.appendingPathComponent("Reports")
        try FileManager.default.createDirectory(at: reports, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let report = UUID(), path = reports.appendingPathComponent("Everframe-report-0000000000000001.json")
        try NativeRecoveryTestData.raw(context: contextID, report: report).write(to: path)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: path.path)
        XCTAssertEqual(try recovery().recover(runID: run.id, outbox: box(), inference: context()), .queued(report))
        let entries = try box().hydrate()
        XCTAssertEqual(entries.count, 1)
        XCTAssertNotEqual(try EverframeReportEnvelope(data: XCTUnwrap(entries.first).envelopeBytes).payload.crash?.mechanism, "apple-termination-inference")
    }
    func testIneligibleOrUnrequestedEvaluationStaysNoReport() throws {
        let (run, _) = try killedRun()
        XCTAssertEqual(try recovery().recover(runID: run.id, outbox: box()), .noReport)           // not the newest run
        var other = identity; other.appBuild = "46"
        XCTAssertEqual(try recovery().recover(runID: run.id, outbox: box(), inference: .init(current: other, now: base.addingTimeInterval(120))), .noReport)
        XCTAssertTrue(try box().hydrate().isEmpty)
        // Nothing was journaled, so the run can still be evaluated later.
        guard case .queued = try recovery().recover(runID: run.id, outbox: box(), inference: context()) else { return XCTFail("not queued") }
    }
    func testMissingContextStaysNoReport() throws {
        let (run, _) = try killedRun()
        try XCTUnwrap(run.terminationState).arm(contextID: UUID())
        XCTAssertEqual(try recovery().recover(runID: run.id, outbox: box(), inference: context()), .noReport)
        XCTAssertTrue(try box().hydrate().isEmpty)
    }
    func testRunWithoutStateFileStaysNoReport() throws {
        let run = try recovery().prepareRun(now: base)   // an older SDK: no termination.state
        XCTAssertNil(run.terminationState)
        XCTAssertEqual(try recovery().recover(runID: run.id, outbox: box(), inference: context()), .noReport)
    }
    func testLastSeenAfterCollectionIsClampedToCollection() throws {
        let (run, _) = try killedRun(sampledAt: 200)   // clock moved back; within the 300 s skew
        guard case .queued = try recovery().recover(runID: run.id, outbox: box(), inference: context(120)) else { return XCTFail("not queued") }
        let envelope = try EverframeReportEnvelope(data: XCTUnwrap(box().hydrate().first).envelopeBytes)
        let evidence = try XCTUnwrap(envelope.payload.inferredTermination)
        XCTAssertEqual(evidence.lastSeenAt, evidence.collectedAt); XCTAssertEqual(envelope.payload.crash?.occurredAt, evidence.collectedAt)
    }
    func testTreeScanRejectsAStateFileWithTheWrongMode() throws {
        let (run, _) = try killedRun()
        let path = root.appendingPathComponent("runs/" + run.id.uuidString.lowercased() + "/" + TerminationLayout.fileName)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: path.path)
        XCTAssertEqual(try recovery().recover(runID: run.id, outbox: box(), inference: context()), .quarantined(.tree))
    }
    func testTreeScanQuarantinesAnOversizedStateFile() throws {
        let (run, _) = try killedRun()
        let path = root.appendingPathComponent("runs/" + run.id.uuidString.lowercased() + "/" + TerminationLayout.fileName)
        let handle = try FileHandle(forWritingTo: path); try handle.seekToEnd(); try handle.write(contentsOf: Data([0])); try handle.close()
        XCTAssertEqual(try recovery().recover(runID: run.id, outbox: box(), inference: context()), .quarantined(.tree))
    }
    func testEntryIsAnonymousEvenWhenTheTemplateCarriesASessionAndUser() throws {
        let frozen = try NativeRecoveryTestData.context()
        let template = try EverframeReportEnvelope(data: frozen.envelopeTemplate).with(sessionID: .some(UUID().uuidString.lowercased()))
        XCTAssertNotNil(template.reporter.user)
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601; encoder.outputFormatting = [.sortedKeys]
        let context = try NativeCrashRecoveryContext(sdkKey: frozen.sdkKey, endpoint: frozen.endpoint, identitySubject: "subject-A",
            envelopeTemplate: encoder.encode(template), redaction: frozen.redaction)
        var record = TerminationRunRecord(launchID: UUID(), identity: identity, startedAt: base)
        record.appState = .active; record.mainStallMs = 6_000
        let entry = try context.inferredTerminationEntry(record: record, cause: .unresponsive, reportID: UUID(), collectedAt: base.addingTimeInterval(30))
        let envelope = try EverframeReportEnvelope(data: entry.envelopeBytes)
        XCTAssertNil(envelope.sessionID); XCTAssertNil(envelope.reporter.user); XCTAssertNil(entry.identitySubject)
        XCTAssertEqual(envelope.payload.crash?.exceptionType, "Unresponsive termination")
        XCTAssertEqual(envelope.payload.crash?.fingerprint, "a96ea84123b3e05f")
        XCTAssertEqual(envelope.payload.inferredTermination?.apple.mainThreadStallMS, 6_000)
        XCTAssertEqual(envelope.context.app.version, "release-A")   // the frozen release, never the live one
    }
}
