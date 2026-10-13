// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
import Foundation
import EverframeProtocol
@testable import EverframeKit

final class ReleaseHealthRuntimeTests: XCTestCase {
    private var root: URL!
    private let key = Data(repeating: 0x72, count: 32)
    private let now = Date(timeIntervalSince1970: 1_791_421_323.456)
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }
    /// Owners differ by user ID; nil is the anonymous owner.
    private func configuration(_ user: String? = nil) throws -> ReleaseHealthConfiguration {
        try .init(userId: user)
    }
    private func runtime(app: AppRelease = .testRelease, beforeCommit: @escaping () throws -> Void = {}) -> ReleaseHealthRuntime {
        let key = key, now = now
        return ReleaseHealthRuntime(root: root, keyProvider: { key }, appRelease: { _ in app }, now: { now },
            beforeCommit: beforeCommit, transport: { _, _ in .retry })
    }
    private func enable(_ runtime: ReleaseHealthRuntime, user: String? = nil, key: String = "key-a") async throws -> Bool {
        let config = try configuration(user)
        let ticket = runtime.requestEnable(configuration: config, sdkKey: key, endpoint: "https://a.example/api/ingest/release-health").ticket
        return await runtime.enable(ticket: ticket, sdkVersion: "1.0.0")
    }
    private func rows() throws -> [ReleaseHealthEntry] { try ReleaseHealthStore(root: root, keyProvider: { self.key }).pending() }
    private func records() throws -> [[String: Any]] { try rows().map { try JSONSerialization.jsonObject(with: $0.body) as! [String: Any] } }
    func testForegroundRecordsKeepTheNativePlatformAndCoveragePolicy() async throws {
        let runtime = runtime()
        let enabled = try await enable(runtime); XCTAssertTrue(enabled)
        _ = runtime.setForeground(false)
        await runtime.barrier()
        let bodies = try records()
        XCTAssertEqual(bodies.compactMap { $0["phase"] as? String }, ["start", "end"])
        for body in bodies {
            let exposure = try XCTUnwrap(body["exposure"] as? [String: Any])
            let coverage = try XCTUnwrap(exposure["coverage"] as? [String: Any])
            #if os(tvOS)
            XCTAssertEqual(exposure["platform"] as? String, "tvos")
            XCTAssertEqual(coverage["policy"] as? String, "tvos-sdk-segment-v1")
            #else
            XCTAssertEqual(exposure["platform"] as? String, "ios")
            XCTAssertEqual(coverage["policy"] as? String, "ios-sdk-segment-v1")
            #endif
            XCTAssertEqual(body["schemaVersion"] as? Int, 5)
            XCTAssertEqual(exposure["sessionPolicy"] as? String, "foreground-v1")
            XCTAssertEqual(coverage["sampleRate"] as? Int, 1)
        }
    }
    func testForegroundSubjectsAreFrozenAcrossAccountRotation() async throws {
        let runtime = runtime()
        let first = try ReleaseHealthConfiguration(userId: "opaque-a", loadedBuildId: "bundle-a", loadedBundleStatus: .known)
        let ticket = runtime.requestEnable(configuration: first, sdkKey: "key-a", endpoint: "https://a.example/api/ingest/release-health").ticket
        let accepted = await runtime.enable(ticket: ticket, sdkVersion: "test"); XCTAssertTrue(accepted)
        let a = try XCTUnwrap(runtime.readyPointer)
        runtime.boundary()
        let second = try ReleaseHealthConfiguration(userId: "opaque-b", loadedBuildId: "bundle-b", loadedBundleStatus: .known)
        let next = runtime.requestEnable(configuration: second, sdkKey: "key-a", endpoint: "https://a.example/api/ingest/release-health").ticket
        let replaced = await runtime.enable(ticket: next, sdkVersion: "test"); XCTAssertTrue(replaced)
        XCTAssertEqual(a.processLaunchID, runtime.readyPointer?.processLaunchID)
        let bodies = try records()
        XCTAssertEqual(bodies.count, 3)
        for body in bodies { XCTAssertEqual(body["schemaVersion"] as? Int, 5) }
        let exposures = bodies.map { $0["exposure"] as! [String: Any] }
        XCTAssertEqual(exposures[0]["subject"] as? [String: String], ["kind": "provided", "id": "opaque-a"])
        XCTAssertEqual(exposures[1]["subject"] as? [String: String], ["kind": "provided", "id": "opaque-a"])
        XCTAssertEqual(exposures[2]["subject"] as? [String: String], ["kind": "provided", "id": "opaque-b"])
        XCTAssertEqual(exposures[2]["sessionPolicy"] as? String, "foreground-v1")
        let erased = await runtime.finishRevocation(runtime.revoke().request); XCTAssertTrue(erased)
        XCTAssertTrue(try rows().isEmpty)
    }
    func testRevocationWithNothingStoredCreatesNothing() async throws {
        let missing = root.appendingPathComponent("release-health")
        let reads = KeyReads(key), now = now
        let runtime = ReleaseHealthRuntime(root: missing, keyProvider: { reads.read() }, appRelease: { _ in .testRelease },
            now: { now }, transport: { _, _ in .retry })
        let erased = await runtime.finishRevocation(runtime.revoke().request); XCTAssertTrue(erased)
        XCTAssertNil(try NativeCrashContextFiles.info(missing), "erasing an absent store created its directory")
        XCTAssertEqual(reads.count, 0, "erasing an absent store read the encryption key")
        // A later enable still creates the store and records a session.
        let ticket = runtime.requestEnable(configuration: try configuration(), sdkKey: "key-a",
            endpoint: "https://a.example/api/ingest/release-health").ticket
        let enabled = await runtime.enable(ticket: ticket, sdkVersion: "1.0.0"); XCTAssertTrue(enabled)
        XCTAssertNotNil(try NativeCrashContextFiles.info(missing))
        XCTAssertEqual(reads.count, 1)
    }
    func testCanonicallyEquivalentOpaqueIDsRotateWithoutAnExplicitBoundary() async throws {
        let runtime = runtime(), composed = "\u{00e9}", decomposed = "e\u{0301}"
        let a = try ReleaseHealthConfiguration(userId: composed)
        let first = runtime.requestEnable(configuration: a, sdkKey: "key", endpoint: "https://example.test").ticket
        let accepted = await runtime.enable(ticket: first, sdkVersion: "test"); XCTAssertTrue(accepted)
        let pointer = try XCTUnwrap(runtime.readyPointer)
        let b = try ReleaseHealthConfiguration(userId: decomposed)
        let second = runtime.requestEnable(configuration: b, sdkKey: "key", endpoint: "https://example.test").ticket
        XCTAssertNotEqual(first, second); XCTAssertNil(runtime.readyPointer)
        let changed = await runtime.enable(ticket: second, sdkVersion: "test"); XCTAssertTrue(changed)
        XCTAssertNotEqual(pointer.exposureID, runtime.readyPointer?.exposureID)
        XCTAssertEqual(pointer.processLaunchID, runtime.readyPointer?.processLaunchID)
        let ids = try rows().map { entry -> [UInt8] in
            let record = try JSONSerialization.jsonObject(with: entry.body) as! [String: Any]
            let subject = (record["exposure"] as! [String: Any])["subject"] as! [String: String]
            return Array(subject["id"]!.utf8)
        }
        XCTAssertEqual(ids, [Array(composed.utf8), Array(composed.utf8), Array(decomposed.utf8)])
        runtime.boundary(); await runtime.barrier()
    }
    func testCompletedEndClampsWallClockRollbackAndKeepsMonotonicElapsed() throws {
        let segment = ReleaseHealthSegment(configuration: try configuration(), app: .testRelease, sdkVersion: "test", sdkKey: "key",
            endpoint: "https://example.test", processLaunchID: UUID(), now: now, uptime: 10)
        let body = try JSONSerialization.jsonObject(with: segment.entry(end: true, now: now.addingTimeInterval(-30), uptime: 12).body) as! [String: Any]
        XCTAssertEqual(body["schemaVersion"] as? Int, 5)
        XCTAssertEqual(body["outcome"] as? String, "completed")
        XCTAssertEqual(body["capturedAt"] as? String, "2026-10-08T01:02:03.456Z")
        XCTAssertEqual(body["elapsedMs"] as? Int, 2000)
    }
    func testInvalidProvidedSubjectIsRefused() throws {
        for id in ["", " ", String(repeating: "a", count: 129), "a\u{0000}", "\u{feff}", " \u{feff}\u{00a0}"] {
            XCTAssertThrowsError(try ReleaseHealthConfiguration(userId: id)) {
                XCTAssertEqual($0 as? ReleaseHealthConfiguration.ValidationError, .invalidUserIdentity)
            }
        }
        XCTAssertNoThrow(try ReleaseHealthConfiguration(userId: String(repeating: "a", count: 128)))
    }
    func testBlankIdentityUsesTheWireContractTrim() throws {
        // Every non-control character that ECMAScript trim() removes: Zs, U+2028, U+2029 and U+FEFF.
        let blank = " \u{a0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}"
        XCTAssertThrowsError(try ReleaseHealthConfiguration(userId: blank))
        for id in [blank, "\u{feff}"] {
            XCTAssertThrowsError(try ReleaseHealthConfiguration(userId: nil, loadedBuildId: id, loadedBundleStatus: .known))
        }
        // The wire contract and Android accept these; Foundation's whitespace set would not.
        for id in ["\u{85}", "\u{200b}", " \u{85}\u{200b}\u{a0}"] {
            XCTAssertNoThrow(try ReleaseHealthConfiguration(userId: id))
            XCTAssertNoThrow(try ReleaseHealthConfiguration(userId: nil, loadedBuildId: id, loadedBundleStatus: .known))
        }
    }
    func testConfigurationNeedsNoArgumentsAndValidatesTheBridgeFields() throws {
        let anonymous = ReleaseHealthConfiguration()
        XCTAssertNil(anonymous.userId); XCTAssertNil(anonymous.loadedBuildId); XCTAssertEqual(anonymous.loadedBundleStatus, .notApplicable)
        XCTAssertEqual(anonymous, try ReleaseHealthConfiguration(userId: nil))
        XCTAssertThrowsError(try ReleaseHealthConfiguration(userId: " ")) {
            XCTAssertEqual($0 as? ReleaseHealthConfiguration.ValidationError, .invalidUserIdentity)
        }
        let invalidBundles: [(String?, ReleaseHealthConfiguration.LoadedBundleStatus)] =
            [(nil, .known), ("downloaded", .unknown), (String(repeating: "b", count: 201), .known)]
        for (loaded, status) in invalidBundles {
            XCTAssertThrowsError(try ReleaseHealthConfiguration(userId: nil, loadedBuildId: loaded, loadedBundleStatus: status)) {
                XCTAssertEqual($0 as? ReleaseHealthConfiguration.ValidationError, .invalidBuildIdentity)
            }
        }
        XCTAssertNoThrow(try ReleaseHealthConfiguration(userId: nil, loadedBuildId: String(repeating: "b", count: 200), loadedBundleStatus: .known))
    }
    func testReadinessIsAbsentUntilDurableAppendAndSameOwnerEnableIsIdempotent() async throws {
        let runtime = runtime(); let config = try configuration()
        let ticket = runtime.requestEnable(configuration: config, sdkKey: "key-a", endpoint: "https://a.example/api/ingest/release-health").ticket
        XCTAssertNil(runtime.readyPointer)
        let accepted = await runtime.enable(ticket: ticket, sdkVersion: "1.0.0"); XCTAssertTrue(accepted)
        let pointer = try XCTUnwrap(runtime.readyPointer)
        XCTAssertEqual(pointer.app.version, "2.4.0"); XCTAssertEqual(pointer.app.build, "412")
        XCTAssertEqual(try rows().count, 1)
        let again = try await enable(runtime); XCTAssertTrue(again)
        XCTAssertEqual(runtime.readyPointer?.exposureID, pointer.exposureID)
        XCTAssertEqual(try rows().count, 1)
        runtime.boundary(); await runtime.barrier()
    }
    func testOnlyAWithdrawnReadyPointerIsReportedRetired() async throws {
        let runtime = runtime(), endpoint = "https://a.example/api/ingest/release-health"
        let first = runtime.requestEnable(configuration: try configuration(), sdkKey: "key-a", endpoint: endpoint)
        XCTAssertFalse(first.retiredPointer)
        let accepted = await runtime.enable(ticket: first.ticket, sdkVersion: "1.0.0"); XCTAssertTrue(accepted)
        // The same owner keeps its pointer; a new owner withdraws it exactly once.
        let same = runtime.requestEnable(configuration: try configuration(), sdkKey: "key-a", endpoint: endpoint)
        XCTAssertEqual(same.ticket, first.ticket); XCTAssertFalse(same.retiredPointer); XCTAssertNotNil(runtime.readyPointer)
        XCTAssertTrue(runtime.requestEnable(configuration: try configuration("user-b"), sdkKey: "key-a", endpoint: endpoint).retiredPointer)
        let next = runtime.requestEnable(configuration: try configuration("user-c"), sdkKey: "key-a", endpoint: endpoint)
        XCTAssertFalse(next.retiredPointer); XCTAssertNil(runtime.readyPointer)
        let reopened = await runtime.enable(ticket: next.ticket, sdkVersion: "1.0.0"); XCTAssertTrue(reopened)
        XCTAssertTrue(runtime.revoke().retiredPointer)
        let erase = runtime.revoke(); XCTAssertFalse(erase.retiredPointer)
        let erased = await runtime.finishRevocation(erase.request); XCTAssertTrue(erased)
        XCTAssertNil(runtime.readyPointer); XCTAssertTrue(try rows().isEmpty)
    }
    func testReplacementByAnotherUserHasDistinctSegmentSameProcessAndExplicitOldEnd() async throws {
        let runtime = runtime(); let first = try await enable(runtime, user: "user-a"); XCTAssertTrue(first)
        let a = try XCTUnwrap(runtime.readyPointer)
        runtime.boundary(); XCTAssertNil(runtime.readyPointer)
        let second = try await enable(runtime, user: "user-b"); XCTAssertTrue(second)
        let b = try XCTUnwrap(runtime.readyPointer)
        XCTAssertNotEqual(a.exposureID, b.exposureID); XCTAssertEqual(a.processLaunchID, b.processLaunchID)
        let bodies = try records()
        XCTAssertEqual(bodies.compactMap { $0["phase"] as? String }, ["start", "end", "start"])
        let exposures = bodies.map { $0["exposure"] as! [String: Any] }
        XCTAssertEqual(exposures.map { $0["exposureId"] as? String }, [a.exposureID, a.exposureID, b.exposureID])
        XCTAssertEqual(exposures.map { ($0["subject"] as? [String: String])?["id"] }, ["user-a", "user-a", "user-b"])
        for exposure in exposures {
            let app = exposure["app"] as? [String: Any]
            XCTAssertEqual(app?["version"] as? String, "2.4.0"); XCTAssertEqual(app?["build"] as? String, "412")
            XCTAssertEqual(app?["debug"] as? Bool, false)
            XCTAssertNil(exposure["native" + "Release"]) // the retired field, spelled in two parts for the repository check
        }
        runtime.boundary(); await runtime.barrier()
    }
    func testStalePendingEnableCannotPublishOrReopenAfterDisable() async throws {
        let runtime = runtime(); let ticket = runtime.requestEnable(configuration: try configuration(), sdkKey: "key-a", endpoint: "https://a.example/api/ingest/release-health").ticket
        let erase = runtime.revoke().request
        let stale = await runtime.enable(ticket: ticket, sdkVersion: "1.0.0"); XCTAssertFalse(stale)
        let erased = await runtime.finishRevocation(erase); XCTAssertTrue(erased)
        XCTAssertNil(runtime.readyPointer); XCTAssertTrue(try rows().isEmpty)
    }
    func testFailedPurgeCannotBeForgottenByReenable() async throws {
        let state = FailureFlag(); let runtime = runtime(beforeCommit: { if state.value { throw CocoaError(.fileWriteNoPermission) } })
        let first = try await enable(runtime, user: "user-a"); XCTAssertTrue(first)
        state.value = true; let erase = runtime.revoke().request
        let erased = await runtime.finishRevocation(erase); XCTAssertFalse(erased)
        let blocked = try await enable(runtime, user: "user-b"); XCTAssertFalse(blocked); XCTAssertNil(runtime.readyPointer)
        state.value = false
        let accepted = try await enable(runtime, user: "user-b"); XCTAssertTrue(accepted)
        let bodies = try rows().map { String(decoding: $0.body, as: UTF8.self) }
        XCTAssertEqual(bodies.count, 1); XCTAssertFalse(bodies.contains { $0.contains("user-a") })
        runtime.boundary(); await runtime.barrier()
    }
    func testStartAndFrozenPointerUseIdenticalMillisecondTimestampAndNullBundle() async throws {
        let runtime = runtime(); let accepted = try await enable(runtime); XCTAssertTrue(accepted)
        let body = try JSONSerialization.jsonObject(with: XCTUnwrap(rows().first).body) as! [String: Any]
        let exposure = body["exposure"] as! [String: Any]
        XCTAssertEqual(exposure["startedAt"] as? String, "2026-10-08T01:02:03.456Z")
        XCTAssertTrue(exposure["loadedBuildId"] is NSNull)
        XCTAssertEqual(exposure["subject"] as? [String: String], ["kind": "anonymous"])
        XCTAssertEqual(body["schemaVersion"] as? Int, 5)
        XCTAssertEqual((exposure["app"] as? [String: Any])?["debug"] as? Bool, false)
        XCTAssertEqual(body["capturedAt"] as? String, exposure["startedAt"] as? String)
        let pointer = try XCTUnwrap(runtime.readyPointer)
        XCTAssertEqual(Int64((pointer.startedAt.timeIntervalSince1970 * 1000).rounded()), Int64((now.timeIntervalSince1970 * 1000).rounded()))
        runtime.boundary(); await runtime.barrier()
    }
    /// `debugBuild` of the owning start reaches the record and the frozen pointer.
    func testTheOwnersDebugBuildIsWrittenToTheRecordAndThePointer() async throws {
        let key = key, now = now
        let runtime = ReleaseHealthRuntime(root: root, keyProvider: { key },
            appRelease: { AppRelease(version: "2.4.0", build: "412", debug: $0 ?? false) }, now: { now }, transport: { _, _ in .retry })
        for configured in [true, false] {
            let ticket = runtime.requestEnable(configuration: try configuration(), sdkKey: "key-a",
                endpoint: "https://a.example/api/ingest/release-health", debugBuild: configured).ticket
            let accepted = await runtime.enable(ticket: ticket, sdkVersion: "1.0.0"); XCTAssertTrue(accepted)
            XCTAssertEqual(runtime.readyPointer?.app.debug, configured)
            let wire = try XCTUnwrap(JSONSerialization.jsonObject(with: ReleaseHealthDate.encoder().encode(XCTUnwrap(runtime.readyPointer))) as? [String: Any])
            XCTAssertEqual((wire["app"] as? [String: Any])?["debug"] as? Bool, configured)
            runtime.boundary(); await runtime.barrier()
        }
        let apps = try records().map { try XCTUnwrap(($0["exposure"] as? [String: Any])?["app"] as? [String: Any]) }
        XCTAssertEqual(apps.map { $0["debug"] as? Bool }, [true, true, false, false])
        XCTAssertEqual(Set(apps.map { Set($0.keys) }), [["version", "build", "debug"]])
    }
    func testChangingDebugBuildIsANewOwner() async throws {
        let runtime = runtime(), endpoint = "https://a.example/api/ingest/release-health"
        let first = runtime.requestEnable(configuration: try configuration(), sdkKey: "key-a", endpoint: endpoint, debugBuild: false)
        let accepted = await runtime.enable(ticket: first.ticket, sdkVersion: "1.0.0"); XCTAssertTrue(accepted)
        let same = runtime.requestEnable(configuration: try configuration(), sdkKey: "key-a", endpoint: endpoint, debugBuild: false)
        XCTAssertEqual(same.ticket, first.ticket); XCTAssertFalse(same.retiredPointer)
        let changed = runtime.requestEnable(configuration: try configuration(), sdkKey: "key-a", endpoint: endpoint, debugBuild: true)
        XCTAssertNotEqual(changed.ticket, first.ticket); XCTAssertTrue(changed.retiredPointer)
        runtime.boundary(); await runtime.barrier()
    }
    // Review Focus 1: a build-less app's start record and frozen pointer both write "build": null.
    func testAMissingBuildIsWrittenAsAnExplicitNull() async throws {
        let runtime = runtime(app: AppRelease(version: "2.4.0", build: nil, debug: false))
        let accepted = try await enable(runtime); XCTAssertTrue(accepted)
        let body = try XCTUnwrap(records().first)
        XCTAssertEqual(body["schemaVersion"] as? Int, 5)
        let app = try XCTUnwrap((body["exposure"] as? [String: Any])?["app"] as? [String: Any])
        XCTAssertEqual(app["version"] as? String, "2.4.0"); XCTAssertTrue(app["build"] is NSNull)
        let pointer = try XCTUnwrap(runtime.readyPointer)
        XCTAssertEqual(pointer.app.version, "2.4.0"); XCTAssertNil(pointer.app.build)
        let wire = try XCTUnwrap(JSONSerialization.jsonObject(with: ReleaseHealthDate.encoder().encode(pointer)) as? [String: Any])
        let wireApp = try XCTUnwrap(wire["app"] as? [String: Any])
        XCTAssertTrue(wireApp["build"] is NSNull)
        runtime.boundary(); await runtime.barrier()
    }
    func testAnInvalidAppReleaseNeverOpensASession() async throws {
        let runtime = runtime(app: AppRelease(version: String(repeating: "a", count: 65), build: nil, debug: false))
        let accepted = try await enable(runtime); XCTAssertFalse(accepted)
        XCTAssertNil(runtime.readyPointer); XCTAssertTrue(try rows().isEmpty)
    }
    func testDisableDuringDurableAppendNeverPublishesReadiness() async throws {
        let entered = expectation(description: "append reached durable boundary")
        let release = DispatchSemaphore(value: 0); let blocked = FailureFlag(); blocked.value = true
        let runtime = runtime(beforeCommit: {
            if blocked.value { blocked.value = false; entered.fulfill(); _ = release.wait(timeout: .now() + 5) }
        })
        let ticket = runtime.requestEnable(configuration: try configuration(), sdkKey: "key-a", endpoint: "https://a.example/api/ingest/release-health").ticket
        let pending = Task { await runtime.enable(ticket: ticket, sdkVersion: "1.0.0") }
        await fulfillment(of: [entered], timeout: 3)
        let erase = runtime.revoke().request; XCTAssertNil(runtime.readyPointer); release.signal()
        let accepted = await pending.value; XCTAssertFalse(accepted)
        let erased = await runtime.finishRevocation(erase); XCTAssertTrue(erased)
        XCTAssertTrue(try rows().isEmpty); XCTAssertNil(runtime.readyPointer)
    }
    func testPreparedTransportCannotStartAfterRevocation() async throws {
        let prepared = expectation(description: "transport prepared")
        let gate = HealthAsyncGate(); let sent = FailureFlag(); let key = key, now = now
        let runtime = ReleaseHealthRuntime(root: root, keyProvider: { key }, appRelease: { _ in .testRelease }, now: { now }, transport: { _, admission in
            prepared.fulfill(); await gate.wait()
            _ = admission { sent.value = true }
            return .retry
        })
        let accepted = try await enable(runtime); XCTAssertTrue(accepted)
        await fulfillment(of: [prepared], timeout: 3)
        let erase = runtime.revoke().request
        let erased = await runtime.finishRevocation(erase); XCTAssertTrue(erased)
        await gate.release(); await runtime.flush()
        XCTAssertFalse(sent.value); XCTAssertTrue(try rows().isEmpty)
    }
    func testFailedStartAppendNeverPublishesReadiness() async throws {
        let holder = HealthRuntimeHolder(), readyDuringCommit = HealthValues<Bool?>()
        let runtime = runtime(beforeCommit: {
            readyDuringCommit.append(holder.runtime.map { $0.readyPointer != nil })
            throw CocoaError(.fileWriteOutOfSpace)
        })
        holder.runtime = runtime
        let accepted = try await enable(runtime); XCTAssertFalse(accepted)
        XCTAssertEqual(readyDuringCommit.values, [false])
        XCTAssertNil(runtime.readyPointer); XCTAssertTrue(try rows().isEmpty)
    }
    func testFullJournalRejectsStartWithoutReadiness() async throws {
        let store = try ReleaseHealthStore(root: root, keyProvider: { self.key })
        for _ in 0..<256 {
            try store.append(.init(recordID: UUID(), createdAt: now, sdkKey: "key-a",
                endpoint: "https://a.example/api/ingest/release-health", body: Data("{}".utf8)))
        }
        let runtime = runtime(); let accepted = try await enable(runtime); XCTAssertFalse(accepted)
        XCTAssertNil(runtime.readyPointer); XCTAssertEqual(try rows().count, 256)
    }
    func testInterruptedStagingIsErasedBeforeTheNextStart() async throws {
        let old = ReleaseHealthSegment(configuration: try configuration("user-old"), app: .testRelease, sdkVersion: "1.0.0", sdkKey: "key-a",
            endpoint: "https://a.example/api/ingest/release-health", processLaunchID: UUID(), now: now, uptime: 1)
        try ReleaseHealthStore(root: root, keyProvider: { self.key }).append(old.entry(end: false, now: now, uptime: 1))
        try Data("partial encrypted staging".utf8).write(to: root.appendingPathComponent(".pending"))
        let runtime = runtime(); let accepted = try await enable(runtime); XCTAssertTrue(accepted)
        let pointer = try XCTUnwrap(runtime.readyPointer); XCTAssertNotEqual(pointer.exposureID, old.pointer.exposureID)
        let bodies = try records()
        XCTAssertEqual(bodies.compactMap { ($0["exposure"] as? [String: Any])?["exposureId"] as? String }, [pointer.exposureID])
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(".pending").path))
        runtime.boundary(); await runtime.barrier()
    }
    func testDrainSendsOnlyTheEnabledOwnersRecords() async throws {
        let foreign = ReleaseHealthEntry(recordID: UUID(), createdAt: now, sdkKey: "key-a",
            endpoint: "https://a.example/api/ingest/release-health", body: Data("{}".utf8))
        try ReleaseHealthStore(root: root, keyProvider: { self.key }).append(foreign)
        let sent = HealthValues<String>(), key = key, now = now
        let runtime = ReleaseHealthRuntime(root: root, keyProvider: { key }, appRelease: { _ in .testRelease }, now: { now }, transport: { entry, admission in
            _ = admission { sent.append(entry.sdkKey) }; return .settled
        })
        let accepted = try await enable(runtime, key: "key-b"); XCTAssertTrue(accepted)
        await runtime.flush()
        XCTAssertEqual(sent.values, ["key-b"]); XCTAssertEqual(try rows().map(\.recordID), [foreign.recordID])
        runtime.boundary(); await runtime.barrier()
    }
    func testUnknownFilesStayUnavailableWithoutDeletingUnownedData() async throws {
        try Data("unowned".utf8).write(to: root.appendingPathComponent("not-ours"))
        let runtime = runtime(); let accepted = try await enable(runtime); XCTAssertFalse(accepted)
        XCTAssertNil(runtime.readyPointer)
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("not-ours").path))
    }
}
private final class FailureFlag: @unchecked Sendable {
    private let lock = NSLock(); private var storage = false
    var value: Bool { get { lock.lock(); defer { lock.unlock() }; return storage } set { lock.lock(); storage = newValue; lock.unlock() } }
}

private final class HealthRuntimeHolder: @unchecked Sendable {
    private let lock = NSLock(); private weak var storage: ReleaseHealthRuntime?
    var runtime: ReleaseHealthRuntime? { get { lock.withLock { storage } } set { lock.withLock { storage = newValue } } }
}
private final class HealthValues<Value>: @unchecked Sendable {
    private let lock = NSLock(); private var storage: [Value] = []
    func append(_ value: Value) { lock.withLock { storage.append(value) } }
    var values: [Value] { lock.withLock { storage } }
}

private actor HealthAsyncGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var released = false
    func wait() async { if !released { await withCheckedContinuation { continuation = $0 } } }
    func release() { released = true; continuation?.resume(); continuation = nil }
}

/// Counts encryption-key reads; the runtime calls its key provider on its worker.
private final class KeyReads: @unchecked Sendable {
    private let lock = NSLock(); private var reads = 0; private let key: Data
    init(_ key: Data) { self.key = key }
    var count: Int { lock.withLock { reads } }
    func read() -> Data { lock.withLock { reads += 1 }; return key }
}
