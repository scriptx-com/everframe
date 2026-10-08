// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
import Foundation
import EverframeProtocol
@testable import EverframeKit

final class NativeCrashRecoveryTests: XCTestCase {
    private var directory: URL!
    private let key = Data(repeating: 0x47, count: 32)
    private var root: URL { directory.appendingPathComponent("recovery") }
    private var queue: URL { directory.appendingPathComponent("queue") }
    enum Stop: Error { case interrupted }
    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: directory) }
    private func recovery(active: Set<UUID> = [], limits: NativeCrashRecovery.Limits = .defaults) throws -> NativeCrashRecovery {
        let key = key
        return try NativeCrashRecovery(rootURL: root, activeRunIDs: active, limits: limits, keyProvider: { key })
    }
    private func box(count: Int = 50) -> JSONLOutbox {
        let key = key
        return JSONLOutbox(fileURL: queue, maxEntries: count, keyProvider: { key })
    }
    private func runPath(_ id: UUID) -> URL { root.appendingPathComponent("runs/" + id.uuidString.lowercased()) }
    private func contextPath(_ id: UUID) -> URL { root.appendingPathComponent("contexts/" + id.uuidString.lowercased()) }
    private func reportPath(_ run: NativeCrashRecovery.Run) -> URL { run.recorderURL.appendingPathComponent("Reports/Everframe-report-0000000000000001.json") }
    private func writeRaw(_ data: Data, run: NativeCrashRecovery.Run) throws {
        let parent = reportPath(run).deletingLastPathComponent()
        if !FileManager.default.fileExists(atPath: parent.path) {
            try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        }
        try data.write(to: reportPath(run)); try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: reportPath(run).path)
    }
    private func prepared(now: Date = Date()) throws -> (NativeCrashRecovery.Run, UUID) {
        let live = try recovery(); let run = try live.prepareRun(now: now)
        let context = try live.writeContext(NativeRecoveryTestData.context(), runID: run.id)
        let report = UUID(); try writeRaw(NativeRecoveryTestData.raw(context: context, report: report), run: run)
        return (run, report)
    }
    func testOriginalContextImportsAndReceiptPreventsReimportAfterDrain() throws {
        let (run, id) = try prepared()
        let live = try recovery(active: [run.id]); let newRun = try live.prepareRun()
        _ = try live.writeContext(NativeRecoveryTestData.context(owner: "sdk-B", pattern: "other"), runID: newRun.id)
        XCTAssertEqual(try recovery().recover(runID: run.id, outbox: box()), .queued(id))
        let entry = try XCTUnwrap(box().hydrate().first)
        XCTAssertEqual(entry.reportId, id); XCTAssertEqual(entry.sdkKey, "sdk-A")
        XCTAssertEqual(entry.identitySubject, "subject-A")
        let envelope = try EverframeReportEnvelope(data: entry.envelopeBytes)
        XCTAssertEqual(envelope.reporter.user?.id, "user-A")
        XCTAssertEqual(envelope.payload.crash?.message, "[REDACTED]")
        for path in [runPath(run.id).appendingPathComponent("stage.evr"), runPath(run.id).appendingPathComponent("receipt.evr")] {
            let bytes = try Data(contentsOf: path)
            XCTAssertNil(bytes.range(of: Data("sdk-A".utf8))); XCTAssertNil(bytes.range(of: Data("original-secret".utf8)))
            XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: path.path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        }
        try box().drain { _ in true }
        XCTAssertEqual(try recovery().recover(runID: run.id, outbox: box()), .alreadyImported(id))
        XCTAssertTrue(try box().hydrate().isEmpty)
        XCTAssertTrue(FileManager.default.fileExists(atPath: reportPath(run).path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: contextPath(run.id).path))
    }
    func testEveryInterruptionBoundaryReusesStagedBytesIncludingDrainedEnqueue() throws {
        for phase in [NativeCrashRecovery.Phase.staged, .enqueued, .receipted] {
            let (run, id) = try prepared()
            var first: OutboxEntry?
            XCTAssertThrowsError(try recovery().recover(runID: run.id, outbox: box()) { reached in
                guard reached == phase else { return }
                first = try self.box().hydrate().first
                try self.box().drain { _ in true }
                throw Stop.interrupted
            })
            let stage = try Data(contentsOf: runPath(run.id).appendingPathComponent("stage.evr"))
            let result = try recovery().recover(runID: run.id, outbox: box())
            XCTAssertEqual(result, phase == .receipted ? .alreadyImported(id) : .queued(id))
            XCTAssertEqual(try Data(contentsOf: runPath(run.id).appendingPathComponent("stage.evr")), stage)
            if phase == .enqueued { XCTAssertEqual(try box().hydrate().first, first) }
            if phase == .receipted { XCTAssertTrue(try box().hydrate().isEmpty) }
            try box().drain { _ in true }
        }
    }
    func testQueueFailureAndChangedRawRetainEvidence() throws {
        let (run, _) = try prepared()
        let corrupt = Data("unrecognized queue".utf8); try corrupt.write(to: queue)
        XCTAssertThrowsError(try recovery().recover(runID: run.id, outbox: box()))
        let stage = try Data(contentsOf: runPath(run.id).appendingPathComponent("stage.evr"))
        XCTAssertEqual(try Data(contentsOf: queue), corrupt)
        try FileManager.default.removeItem(at: queue)
        try writeRaw(NativeRecoveryTestData.raw(context: UUID()), run: run)
        XCTAssertEqual(try recovery().recover(runID: run.id, outbox: box()), .quarantined(.journal))
        XCTAssertEqual(try Data(contentsOf: runPath(run.id).appendingPathComponent("stage.evr")), stage)
        XCTAssertTrue(try box().hydrate().isEmpty)
    }
    func testMissingMalformedAndMultipleRecordsRemainQuarantined() throws {
        let live = try recovery(); let run = try live.prepareRun()
        XCTAssertEqual(try recovery().recover(runID: run.id, outbox: box()), .noReport)
        for (raw, reason) in [(Data("partial".utf8), NativeCrashRecovery.Quarantine.record),
                              (try NativeRecoveryTestData.raw(context: UUID()), .context)] {
            try writeRaw(raw, run: run)
            XCTAssertEqual(try recovery().recover(runID: run.id, outbox: box()), .quarantined(reason))
            XCTAssertEqual(try Data(contentsOf: reportPath(run)), raw)
        }
        try Data("second".utf8).write(to: reportPath(run).deletingLastPathComponent().appendingPathComponent("Everframe-report-0000000000000002.json"))
        XCTAssertEqual(try recovery().recover(runID: run.id, outbox: box()), .quarantined(.multipleReports))
        XCTAssertTrue(try box().hydrate().isEmpty)
    }
    func testActiveAndInFlightRunsCannotBeRecoveredOrRetired() throws {
        let live = try recovery(); let run = try live.prepareRun(now: Date(timeIntervalSince1970: 1))
        let ctx = try live.writeContext(NativeRecoveryTestData.context(), runID: run.id)
        try writeRaw(NativeRecoveryTestData.raw(context: ctx), run: run)
        XCTAssertThrowsError(try live.recover(runID: run.id, outbox: box()))
        XCTAssertEqual(try live.maintain(), 0)
        let closed = try recovery()
        _ = try closed.recover(runID: run.id, outbox: box()) { _ in
            XCTAssertEqual(try closed.maintain(), 0)
            XCTAssertThrowsError(try closed.recover(runID: run.id, outbox: self.box()))
        }
        XCTAssertEqual(try closed.maintain(), 1)
    }
    func testUnsafeAndUnknownTreesAreQuarantinedAndNeverRetired() throws {
        // Aged, so maintenance would retire it if its tree were recognized.
        let (run, _) = try prepared(now: Date(timeIntervalSince1970: 1))
        let raw = try Data(contentsOf: reportPath(run))
        try FileManager.default.setAttributes([.posixPermissions: 0o666], ofItemAtPath: reportPath(run).path)
        XCTAssertEqual(try recovery().recover(runID: run.id, outbox: box()), .quarantined(.tree))
        XCTAssertEqual(try recovery().maintain(), 0)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: reportPath(run).path)
        let unknown = runPath(run.id).appendingPathComponent("unknown")
        try Data().write(to: unknown)
        XCTAssertEqual(try recovery().maintain(), 0); try FileManager.default.removeItem(at: unknown)
        let linked = directory.appendingPathComponent("hardlink")
        try FileManager.default.linkItem(at: reportPath(run), to: linked)
        XCTAssertEqual(try recovery().recover(runID: run.id, outbox: box()), .quarantined(.tree))
        XCTAssertEqual(try recovery().maintain(), 0); try FileManager.default.removeItem(at: linked)
        try FileManager.default.removeItem(at: reportPath(run))
        try raw.write(to: linked)
        try FileManager.default.createSymbolicLink(at: reportPath(run), withDestinationURL: linked)
        XCTAssertEqual(try recovery().maintain(), 0); try FileManager.default.removeItem(at: reportPath(run))
        XCTAssertTrue(FileManager.default.fileExists(atPath: contextPath(run.id).path))
        XCTAssertTrue(try box().hydrate().isEmpty)
    }
    func testUnrecognizedRunStaysQuarantinedWithoutBlockingOtherRuns() throws {
        let (blocked, _) = try prepared(), (pending, reportID) = try prepared()
        let unknown = blocked.recorderURL.appendingPathComponent("Reports/unrecognized")
        try Data("vendor".utf8).write(to: unknown)
        XCTAssertEqual(try recovery().recover(runID: pending.id, outbox: box()), .queued(reportID))
        XCTAssertEqual(try recovery().recover(runID: blocked.id, outbox: box()), .quarantined(.tree))
        let live = try recovery(); let next = try live.prepareRun()
        XCTAssertNoThrow(try live.writeContext(NativeRecoveryTestData.context(), runID: next.id))
        // Age retirement removes the other closed run, never unrecognized content.
        XCTAssertEqual(try recovery(active: [next.id]).maintain(now: Date().addingTimeInterval(15 * 86400)), 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: runPath(pending.id).path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: unknown.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: reportPath(blocked).path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: contextPath(blocked.id).path))
        XCTAssertEqual(try box().hydrate().map(\.reportId), [reportID])
    }
    func testOversizedRunsAreNeverImportedButStillRetire() throws {
        let (oversized, _) = try prepared(now: Date().addingTimeInterval(-60)), (pending, reportID) = try prepared()
        try writeRaw(Data(repeating: 32, count: 2 * 1024 * 1024 + 1), run: oversized)
        XCTAssertEqual(try recovery().recover(runID: pending.id, outbox: box()), .queued(reportID))
        XCTAssertEqual(try recovery().recover(runID: oversized.id, outbox: box()), .quarantined(.tree))
        XCTAssertEqual(try recovery().maintain(), 0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: reportPath(oversized).path))
        // A run total over its bound is quarantined the same way.
        var limits = NativeCrashRecovery.Limits.defaults
        limits.maxRunBytes = try Data(contentsOf: reportPath(pending)).count - 1
        XCTAssertEqual(try recovery(limits: limits).recover(runID: pending.id, outbox: box()), .quarantined(.tree))
        XCTAssertEqual(try recovery(limits: limits).maintain(), 0)
        // Admission still reclaims the oldest closed run when its files exceed their bounds.
        limits = .defaults; limits.maxRuns = 2
        XCTAssertNoThrow(try recovery(limits: limits).prepareRun())
        XCTAssertFalse(FileManager.default.fileExists(atPath: runPath(oversized.id).path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: contextPath(oversized.id).path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: runPath(pending.id).path))
        XCTAssertEqual(try box().hydrate().map(\.reportId), [reportID])
    }
    func testRecrashLeftoverIsRecognizedWithoutBlockingOtherRuns() throws {
        let (recrash, originalID) = try prepared(), (pending, reportID) = try prepared()
        // An interrupted vendor recrash leaves the renamed original beside a partial report.
        let original = recrash.recorderURL.appendingPathComponent("Reports/Everframe-report-0000000000000001.old")
        try FileManager.default.moveItem(at: reportPath(recrash), to: original)
        try writeRaw(Data("{\"report\":".utf8), run: recrash)
        XCTAssertEqual(try recovery().recover(runID: pending.id, outbox: box()), .queued(reportID))
        XCTAssertEqual(try recovery().recover(runID: recrash.id, outbox: box()), .quarantined(.multipleReports))
        try FileManager.default.removeItem(at: reportPath(recrash))
        XCTAssertEqual(try recovery().recover(runID: recrash.id, outbox: box()), .queued(originalID))
        XCTAssertEqual(try recovery().maintain(now: Date().addingTimeInterval(15 * 86400)), 2)
        XCTAssertFalse(FileManager.default.fileExists(atPath: runPath(recrash.id).path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: contextPath(recrash.id).path))
    }
    func testCapacityExpiresOldestClosedRunAndRefusesActiveRun() throws {
        var limits = NativeCrashRecovery.Limits.defaults; limits.maxRuns = 1
        let live = try recovery(limits: limits); let old = try live.prepareRun()
        XCTAssertThrowsError(try live.prepareRun())
        let next = try recovery(limits: limits).prepareRun()
        XCTAssertNotEqual(old.id, next.id)
        XCTAssertFalse(FileManager.default.fileExists(atPath: runPath(old.id).path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: contextPath(old.id).path))
    }
    func testAgeRetirementResumesRawFirstTombstoneAndRemovesOrphanContext() throws {
        let (run, _) = try prepared(now: Date(timeIntervalSince1970: 1))
        let tombstone = root.appendingPathComponent("runs/.retiring-" + run.id.uuidString.lowercased())
        try FileManager.default.moveItem(at: runPath(run.id), to: tombstone)
        XCTAssertEqual(try recovery().maintain(), 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: tombstone.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: contextPath(run.id).path))
        let key = key
        let store = try NativeCrashContextStore(rootURL: root.appendingPathComponent("contexts"), keyProvider: { key })
        let orphan = try store.createRun(now: Date(timeIntervalSince1970: 1))
        XCTAssertEqual(try recovery().maintain(), 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: contextPath(orphan.id).path))
    }
    func testJournalTamperingAndCrossRunCiphertextAreRejected() throws {
        let (a, _) = try prepared(), (b, _) = try prepared()
        for run in [a, b] {
            XCTAssertThrowsError(try recovery().recover(runID: run.id, outbox: box()) { _ in throw Stop.interrupted })
        }
        let aStage = runPath(a.id).appendingPathComponent("stage.evr"), bStage = runPath(b.id).appendingPathComponent("stage.evr")
        let original = try Data(contentsOf: bStage)
        try Data(contentsOf: aStage).write(to: bStage)
        XCTAssertEqual(try recovery().recover(runID: b.id, outbox: box()), .quarantined(.journal))
        try original.write(to: bStage)
        _ = try recovery().recover(runID: b.id, outbox: box())
        try box().drain { _ in true }
        let receipt = runPath(b.id).appendingPathComponent("receipt.evr")
        var corrupted = try Data(contentsOf: receipt); corrupted[corrupted.count - 1] ^= 1
        try corrupted.write(to: receipt)
        XCTAssertEqual(try recovery().recover(runID: b.id, outbox: box()), .quarantined(.journal))
        XCTAssertTrue(try box().hydrate().isEmpty)
    }
    func testStagedEntrySurvivesUnavailableKeyAndFailedQueueWrite() throws {
        let (run, id) = try prepared()
        XCTAssertThrowsError(try recovery().recover(runID: run.id, outbox: box()) { _ in throw Stop.interrupted })
        let stageURL = runPath(run.id).appendingPathComponent("stage.evr"), bytes = try Data(contentsOf: stageURL)
        let unavailable = try NativeCrashRecovery(rootURL: root, activeRunIDs: [], keyProvider: { throw Stop.interrupted })
        XCTAssertThrowsError(try unavailable.recover(runID: run.id, outbox: box()))
        // Queue parent becomes unwritable while the existing recovery subdirectories
        // remain writable. This exercises an actual failed queue-file creation.
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: directory.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path) }
        XCTAssertThrowsError(try recovery().recover(runID: run.id, outbox: box()))
        XCTAssertEqual(try Data(contentsOf: stageURL), bytes)
        XCTAssertFalse(FileManager.default.fileExists(atPath: runPath(run.id).appendingPathComponent("receipt.evr").path))
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        XCTAssertEqual(try recovery().recover(runID: run.id, outbox: box()), .queued(id))
    }
    func testStageAndTotalCapacityNeverDeleteActiveRuns() throws {
        let (run, _) = try prepared()
        let rawBytes = try Data(contentsOf: reportPath(run)).count
        var limits = NativeCrashRecovery.Limits.defaults; limits.maxRunBytes = rawBytes + 10
        XCTAssertThrowsError(try recovery(limits: limits).recover(runID: run.id, outbox: box()))
        XCTAssertFalse(FileManager.default.fileExists(atPath: runPath(run.id).appendingPathComponent("stage.evr").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: reportPath(run).path))
        limits = .defaults; limits.maxTotalBytes = rawBytes - 1
        XCTAssertThrowsError(try recovery(active: [run.id], limits: limits).maintain())
        XCTAssertEqual(try recovery(limits: limits).maintain(), 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: contextPath(run.id).path))
    }
    func testTombstoneResumesAfterContextRemovalAndActiveTombstoneStays() throws {
        let (run, _) = try prepared()
        let tombstone = root.appendingPathComponent("runs/.retiring-" + run.id.uuidString.lowercased())
        try FileManager.default.moveItem(at: runPath(run.id), to: tombstone)
        XCTAssertEqual(try recovery(active: [run.id]).maintain(), 0)
        let key = key
        try NativeCrashContextStore(rootURL: root.appendingPathComponent("contexts"), keyProvider: { key }).removeRun(run.id)
        XCTAssertEqual(try recovery().maintain(), 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: tombstone.path))
    }
    func testRetirementResumesDuringContextDeletionBeforeInspectingUnrelatedRuns() throws {
        let (retiring, _) = try prepared(), (pending, reportID) = try prepared()
        let tombstone = root.appendingPathComponent("runs/.retiring-" + retiring.id.uuidString.lowercased())
        try FileManager.default.moveItem(at: runPath(retiring.id), to: tombstone)
        // Recursive context removal can delete the header before its ciphertext.
        try FileManager.default.removeItem(at: contextPath(retiring.id).appendingPathComponent("run.json"))
        XCTAssertEqual(try recovery().recover(runID: pending.id, outbox: box()), .queued(reportID))
        XCTAssertFalse(FileManager.default.fileExists(atPath: contextPath(retiring.id).path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: tombstone.path))
        XCTAssertNoThrow(try recovery().prepareRun())
    }
    func testPartialContextRetirementStillRejectsActiveAndUnsafeContent() throws {
        let (run, _) = try prepared()
        let tombstone = root.appendingPathComponent("runs/.retiring-" + run.id.uuidString.lowercased())
        try FileManager.default.moveItem(at: runPath(run.id), to: tombstone)
        try FileManager.default.removeItem(at: contextPath(run.id).appendingPathComponent("run.json"))
        XCTAssertThrowsError(try recovery(active: [run.id]).prepareRun())
        XCTAssertTrue(FileManager.default.fileExists(atPath: tombstone.path))
        let unknown = contextPath(run.id).appendingPathComponent("unknown")
        try Data().write(to: unknown)
        XCTAssertThrowsError(try recovery().prepareRun())
        XCTAssertTrue(FileManager.default.fileExists(atPath: unknown.path))
        try FileManager.default.removeItem(at: unknown)
        XCTAssertEqual(try recovery().maintain(), 1)
        XCTAssertNoThrow(try recovery().prepareRun())
    }
    func testAdmissionRetiresClosedContextBudgetAndReservesAnInitialContext() throws {
        // Both a completely full store and one with enough room for a header
        // but too little for the first context must reclaim a closed run.
        for spare in [0, 1024] {
            let live = try recovery(); let run = try live.prepareRun()
            let key = key
            let store = try NativeCrashContextStore(rootURL: root.appendingPathComponent("contexts"), keyProvider: { key })
            for _ in 0..<255 { _ = try store.writeContext(Data(repeating: 0x47, count: 65536), runID: run.id) }
            let used = try FileManager.default.contentsOfDirectory(at: contextPath(run.id), includingPropertiesForKeys: [.fileSizeKey]).reduce(0) {
                $0 + (try $1.resourceValues(forKeys: [.fileSizeKey]).fileSize!)
            }
            _ = try store.writeContext(Data(repeating: 0x47, count: 16 * 1024 * 1024 - used - 36 - spare), runID: run.id)
            XCTAssertThrowsError(try live.prepareRun(), "Cannot reclaim an active run for context capacity")
            let relaunched = try recovery()
            let next = try relaunched.prepareRun()
            XCTAssertFalse(FileManager.default.fileExists(atPath: contextPath(run.id).path))
            XCTAssertFalse(FileManager.default.fileExists(atPath: runPath(run.id).path))
            XCTAssertNoThrow(try relaunched.writeContext(NativeRecoveryTestData.context(), runID: next.id))
            // Keep this subcase independent without bypassing production retention.
            _ = try recovery().maintain(now: Date().addingTimeInterval(15 * 86400))
        }
    }
}
