// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
import Foundation
import EverframeProtocol
@testable import EverframeKit

final class AppleDiagnosticRuntimeTests: XCTestCase {
    private var root: URL!
    private let key = Data(repeating: 0x67, count: 32)
    private let now = Date(timeIntervalSince1970: 1_791_417_600)
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }
    private func outbox(max: Int = 50) -> JSONLOutbox {
        let key = key; return JSONLOutbox(fileURL: root.appendingPathComponent("outbox"), maxEntries: max, keyProvider: { key })
    }
    private func runtime(box: JSONLOutbox? = nil, at date: Date? = nil, retryInterval: TimeInterval = 30) -> AppleDiagnosticRuntime {
        let key = key, date = date ?? now
        return AppleDiagnosticRuntime(root: root.appendingPathComponent("journal"), outbox: box ?? outbox(),
            keyProvider: { key }, now: { date }, retryInterval: retryInterval)
    }
    private func eventually(timeout: TimeInterval = 5, _ condition: () throws -> Bool) async throws -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while try !condition() {
            guard Date() < deadline else { return false }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        return true
    }
    private func expect(_ value: Bool, file: StaticString = #filePath, line: UInt = #line) { XCTAssertTrue(value, file: file, line: line) }
    private func reject(_ value: Bool, file: StaticString = #filePath, line: UInt = #line) { XCTAssertFalse(value, file: file, line: line) }
    private func context(_ owner: String = "sdk-A") throws -> AppleDiagnosticContext {
        let config = EverframeConfig(appId: owner, release: "release-A",
            redaction: .init(customPatterns: [try NSRegularExpression(pattern: "original-secret")]))
        let device = DeviceMetadata(model: "iPhone", osName: "iOS", osVersion: "18.0", locale: "en_US", timezone: "UTC",
            appVersion: "1.0", appBuild: "42", bundleIdentifier: "dev.example.host")
        return .init(frozen: try NativeCrashStartupContext.make(config: config, user: nil, device: device,
            endpoint: "https://example.invalid/api/ingest"), applicationVersion: "1.0", applicationBuild: "42")
    }
    private func candidate(begin: Date? = nil, version: String = "1.0") -> AppleDiagnosticCandidate {
        .init(kind: "hang_batch", begin: begin ?? now, end: now, applicationVersion: version,
            applicationBuild: "42", osVersion: "iOS 18.0",
            hangs: [.init(durationMs: 2000, stack: .init(status: "unavailable", truncated: false, frames: []))],
            exits: [], truncated: false)
    }
    func testSDKStartAndKillFenceDiagnosticAdmission() async throws {
        let live = runtime(), device = DeviceMetadata(model: "iPhone", osName: "iOS", osVersion: "18.0", locale: "en_US", timezone: "UTC",
            appVersion: "1.0", appBuild: "42", bundleIdentifier: "dev.example.host")
        // The accepted receipt starts the SDK's retry drain; keep it off real hosts.
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [AppleUnavailableProtocol.self]
        let session = URLSession(configuration: configuration); defer { session.invalidateAndCancel() }
        let sdk = Everframe(nativeCrashRuntime: nil, appleDiagnosticRuntime: live, appleDiagnosticSession: { session },
            nativeDeviceSnapshot: { device })
        defer { live.boundary() }
        reject(await sdk.setAppleDiagnosticsEnabled(true))
        try sdk.start(config: .init(appId: "evf_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", capture: .init(logs: false)))
        expect(await sdk.setAppleDiagnosticsEnabled(true)); expect(await live.accept(candidate()))
        let old = try XCTUnwrap(outbox().hydrate().first)
        try sdk.start(config: .init(appId: "evf_live_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", capture: .init(logs: false)))
        XCTAssertFalse(AppleDiagnosticDelivery.allows(old, now: now.addingTimeInterval(20)))
        reject(await live.accept(candidate()))
        expect(await sdk.setAppleDiagnosticsEnabled(true))
        XCTAssertFalse(AppleDiagnosticDelivery.allows(old, now: now.addingTimeInterval(20)))
        sdk.kill(); reject(await live.accept(candidate()))
        expect(await sdk.setAppleDiagnosticsEnabled(false)); XCTAssertTrue(try outbox().hydrate().isEmpty)
    }
    func testWindowAndNativeVersionMustMatchDespiteCustomRelease() async throws {
        let live = runtime(); let enabled = await live.enable(context: try context()); XCTAssertTrue(enabled)
        let old = await live.accept(candidate(begin: now.addingTimeInterval(-1))); XCTAssertFalse(old)
        let wrong = await live.accept(candidate(version: "2.0")); XCTAssertFalse(wrong)
        let good = await live.accept(candidate()); XCTAssertTrue(good)
        let duplicate = await live.accept(candidate()); XCTAssertFalse(duplicate)
        let entry = try XCTUnwrap(outbox().hydrate().first)
        let envelope = try EverframeReportEnvelope(data: entry.envelopeBytes)
        XCTAssertEqual(envelope.source, .diagnostic); XCTAssertNil(envelope.reporter.user); XCTAssertNil(entry.identitySubject)
        XCTAssertNil(envelope.sessionID); XCTAssertNil(envelope.payload.crash)
        XCTAssertEqual(envelope.payload.appleDiagnostic?.outcome.rawValue, "unknown")
        if let path = ProcessInfo.processInfo.environment["EVERFRAME_APPLE_PROOF_DIR"] {
            let directory = URL(fileURLWithPath: path)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try entry.envelopeBytes.write(to: directory.appendingPathComponent("synthetic-apple-hang.json"))
        }
        live.boundary(); reject(await live.accept(candidate()))
    }
    func testRestartRetriesAcceptedFrozenReceiptButRejectsOldCallbackWindow() async throws {
        let first = runtime(); expect(await first.enable(context: try context()))
        expect(await first.accept(candidate()))
        let old = try XCTUnwrap(outbox().hydrate().first); first.boundary(); reject(await first.accept(candidate()))
        XCTAssertFalse(AppleDiagnosticDelivery.allows(old, now: now.addingTimeInterval(20)))
        let next = runtime(at: now.addingTimeInterval(10)); expect(await next.enable(context: try context()))
        XCTAssertEqual(try outbox().hydrate(), [old]); XCTAssertTrue(AppleDiagnosticDelivery.allows(old, now: now.addingTimeInterval(20)))
        reject(await next.accept(candidate()))
        next.boundary(); reject(await next.accept(candidate()))
    }
    func testDisableThenEnableCannotReviveAcceptedEntries() async throws {
        let live = runtime(); expect(await live.enable(context: try context()))
        expect(await live.accept(candidate()))
        let old = try XCTUnwrap(outbox().hydrate().first)
        let revoked = live.revoke(); XCTAssertFalse(AppleDiagnosticDelivery.allows(old, now: now.addingTimeInterval(20)))
        expect(await live.enable(context: try context()))
        expect(await live.finishRevocation(revoked))
        XCTAssertTrue(try outbox().hydrate().isEmpty)
        XCTAssertFalse(AppleDiagnosticDelivery.allows(old, now: now.addingTimeInterval(20))); live.boundary(); reject(await live.accept(candidate()))
    }
    func testWrongDestinationNeverAuthorizesHistoricalReceipt() async throws {
        let first = runtime(); expect(await first.enable(context: try context()))
        expect(await first.accept(candidate())); let old = try XCTUnwrap(outbox().hydrate().first)
        first.boundary(); reject(await first.accept(candidate()))
        let next = runtime(); expect(await next.enable(context: try context("sdk-B")))
        XCTAssertFalse(AppleDiagnosticDelivery.allows(old, now: now.addingTimeInterval(20))); XCTAssertEqual(try outbox().hydrate(), [old]); next.boundary(); reject(await next.accept(candidate()))
    }
    func testInterruptedAmbiguousJournalResetCannotForgetOutboxErasure() async throws {
        let first = runtime(); expect(await first.enable(context: try context()))
        expect(await first.accept(candidate())); first.boundary(); reject(await first.accept(candidate()))
        XCTAssertEqual(try outbox().hydrate().count, 1)
        // Process dies after ambiguous journal cleanup but before its new revoke
        // record is committed. An empty journal cannot prove queue erasure.
        try AppleDiagnosticStore.eraseAmbiguous(root: root.appendingPathComponent("journal"))
        let next = runtime(); expect(await next.enable(context: try context()))
        XCTAssertTrue(try outbox().hydrate().isEmpty); next.boundary(); reject(await next.accept(candidate()))
    }
    func testFailedOutboxErasureSurvivesRestartAndBlocksReenable() async throws {
        let blocked = AppleDiagnosticKeyFailure(), key = key
        let failing = JSONLOutbox(fileURL: root.appendingPathComponent("outbox"), keyProvider: {
            if blocked.isBlocked { throw CocoaError(.fileReadNoPermission) }; return key
        })
        let first = runtime(box: failing); expect(await first.enable(context: try context()))
        expect(await first.accept(candidate())); blocked.set(true)
        let request = first.revoke(); reject(await first.finishRevocation(request))
        reject(await first.enable(context: try context()))
        let next = runtime(box: failing); reject(await next.enable(context: try context()))
        blocked.set(false); expect(await next.enable(context: try context()))
        XCTAssertTrue(try outbox().hydrate().isEmpty); first.boundary(); reject(await first.accept(candidate())); next.boundary(); reject(await next.accept(candidate()))
    }
    func testRevocationDuringQueuedProjectionCannotBeOvertakenByEnable() async throws {
        let live = runtime(); expect(await live.enable(context: try context()))
        let entered = expectation(description: "projection began"), release = DispatchSemaphore(value: 0)
        let input = candidate()
        live.receive { entered.fulfill(); release.wait(); return [input] }
        await fulfillment(of: [entered], timeout: 3)
        let request = live.revoke()
        let newer = Task { await live.enable(context: try! context()) }
        release.signal(); expect(await newer.value); expect(await live.finishRevocation(request))
        XCTAssertTrue(try outbox().hydrate().isEmpty); live.boundary(); reject(await live.accept(candidate()))
    }
    func testDelayedReceiptRetryAfterRestartUsesFrozenBytesAndDurablySettlesHTTPAcceptance() async throws {
        let date = Date()
        // Use an exact runtime clock for the reporting-window boundary.
        let begin = date.addingTimeInterval(-86400)
        var previous: AppleDiagnosticRuntime? = runtime(at: begin)
        expect(await previous!.enable(context: try context(), scope: .installation)); previous = nil
        let live = runtime(at: date)
        expect(await live.enable(context: try context(), scope: .installation))
        let accepted = AppleDiagnosticCandidate(kind: "hang_batch", begin: begin, end: date,
            applicationVersion: "1.0", applicationBuild: "42", osVersion: "iOS 18.0",
            hangs: [.init(durationMs: 2000, stack: .init(status: "unavailable", truncated: false, frames: []))], exits: [], truncated: false)
        expect(await live.accept(accepted))
        let original = try XCTUnwrap(outbox().hydrate().first)
        let manual = OutboxEntry(reportId: UUID(), createdAt: original.createdAt, envelopeBytes: Data("{}".utf8),
            idempotencyKey: "manual", attachmentRefs: [], sdkKey: "manual-owner", endpoint: original.endpoint,
            identitySubject: "manual-user")
        _ = try outbox().enqueueRecovered(manual)
        AppleRetryProtocol.reset()
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [AppleRetryProtocol.self]
        let session = URLSession(configuration: config); defer { session.invalidateAndCancel() }
        let submitter = ReportSubmitter(config: EverframeConfig(appId: "sdk-A"), outbox: outbox(), session: session).restrictingOutboxToAppleDiagnostics()
        await submitter.drainOutbox(identityHolder: IdentityTokenHolder(), currentReplayConfig: { .off }, epochAtInitiation: 0, currentEpoch: { 0 })
        XCTAssertEqual(try outbox().hydrate(), [original, manual]); live.boundary(); reject(await live.accept(candidate()))
        let next = runtime(at: Date()); expect(await next.enable(context: try context()))
        XCTAssertEqual(try outbox().hydrate(), [original, manual])
        await submitter.drainOutbox(identityHolder: IdentityTokenHolder(), currentReplayConfig: { .off }, epochAtInitiation: 0, currentEpoch: { 0 })
        // A worker barrier places the journal settlement before the simulated restart.
        expect(await next.enable(context: try context())); XCTAssertEqual(try outbox().hydrate(), [manual]); next.boundary(); reject(await next.accept(candidate()))
        let final = runtime(at: Date()); expect(await final.enable(context: try context()))
        XCTAssertEqual(try outbox().hydrate(), [manual]); final.boundary(); reject(await final.accept(candidate()))
        let requests = AppleRetryProtocol.requests
        XCTAssertEqual(requests.count, 2)
        let bodies = AppleRetryProtocol.bodies
        XCTAssertEqual(bodies.count, 2)
        // Multipart boundaries can differ; the immutable envelope bytes cannot.
        for body in bodies { XCTAssertNotNil(body.range(of: original.envelopeBytes)) }
        for request in requests {
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Everframe-Idempotency-Key"), original.idempotencyKey)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer sdk-A")
            XCTAssertNil(request.value(forHTTPHeaderField: "X-Everframe-Identity-Token"))
            XCTAssertEqual(request.url?.absoluteString, original.endpoint)
        }
    }
    func testSDKRetryDrainLeavesQueuedManualReportsToTheirOwnDrain() async throws {
        // Drives the SDK's own retry drain rather than a hand-built restricted submitter.
        // Whole seconds: queued entries persist ISO-8601 timestamps.
        let date = Date(timeIntervalSince1970: floor(Date().timeIntervalSince1970))
        let appId = "evf_live_cccccccccccccccccccccccccccccccc", endpoint = IngestEndpoint.url.absoluteString
        let device = DeviceMetadata(model: "iPhone", osName: "iOS", osVersion: "18.0", locale: "en_US", timezone: "UTC",
            appVersion: "1.0", appBuild: "42", bundleIdentifier: "dev.example.host")
        let manual = OutboxEntry(reportId: UUID(), createdAt: date, envelopeBytes: Data("{}".utf8), idempotencyKey: "manual",
            attachmentRefs: [], sdkKey: appId, endpoint: endpoint, identitySubject: "manual-user")
        _ = try outbox().enqueueRecovered(manual)
        // Stage a receipt for the destination the SDK freezes, then restart.
        let frozen = try NativeCrashStartupContext.make(config: EverframeConfig(appId: appId), user: nil, device: device, endpoint: endpoint)
        let first = runtime(at: date)
        expect(await first.enable(context: .init(frozen: frozen, applicationVersion: "1.0", applicationBuild: "42")))
        expect(await first.accept(AppleDiagnosticCandidate(kind: "hang_batch", begin: date, end: date, applicationVersion: "1.0",
            applicationBuild: "42", osVersion: "iOS 18.0", hangs: [.init(durationMs: 2000, stack: .init(status: "unavailable",
            truncated: false, frames: []))], exits: [], truncated: false)))
        first.boundary(); reject(await first.accept(candidate()))
        let receipt = try XCTUnwrap(outbox().hydrate().last); XCTAssertTrue(AppleDiagnosticDelivery.isApple(receipt))
        AppleAcceptProtocol.reset()
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [AppleAcceptProtocol.self]
        let session = URLSession(configuration: configuration); defer { session.invalidateAndCancel() }
        let live = runtime(at: date)
        let sdk = Everframe(nativeCrashRuntime: nil, appleDiagnosticRuntime: live, appleDiagnosticSession: { session },
            nativeDeviceSnapshot: { device })
        try sdk.start(config: .init(appId: appId, capture: .init(logs: false)))
        expect(await sdk.setAppleDiagnosticsEnabled(true))
        expect(try await eventually { try !self.outbox().hydrate().contains(where: AppleDiagnosticDelivery.isApple) })
        // The manual report is neither sent without its identity nor rewritten.
        XCTAssertEqual(try outbox().hydrate(), [manual])
        XCTAssertEqual(AppleAcceptProtocol.requests.map { $0.value(forHTTPHeaderField: "X-Everframe-Idempotency-Key") },
                       [receipt.idempotencyKey])
        sdk.kill(); expect(await sdk.setAppleDiagnosticsEnabled(false))
    }
    func testIdleRetryTicksNeitherRewriteTheSharedQueueNorStartDrains() async throws {
        let box = outbox(), drains = AppleDrainCounter(), file = root.appendingPathComponent("outbox")
        let manual = OutboxEntry(reportId: UUID(), createdAt: now, envelopeBytes: Data("{}".utf8), idempotencyKey: "manual",
            attachmentRefs: [], sdkKey: "manual-owner", endpoint: "https://example.invalid/api/ingest")
        _ = try box.enqueueRecovered(manual)
        let live = runtime(box: box, retryInterval: 0.01)
        let enabled = await live.enable(context: try context(), scope: .installation, drain: { drains.increment() }); expect(enabled)
        // Every rewrite re-seals the queue under a fresh nonce: equal bytes mean no rewrite.
        let idle = try Data(contentsOf: file)
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(try Data(contentsOf: file), idle); XCTAssertEqual(drains.count, 0)
        // A pending receipt is still retried on later ticks without rewriting the queue.
        expect(await live.accept(candidate()))
        let staged = try Data(contentsOf: file)
        expect(try await eventually { drains.count >= 3 })
        XCTAssertEqual(try Data(contentsOf: file), staged); live.boundary(); reject(await live.accept(candidate()))
    }
    func testAggregateProducerKeepsCountsWithoutIndividualIncidentClaims() async throws {
        let live = runtime(); expect(await live.enable(context: try context()))
        let input = AppleDiagnosticCandidate(kind: "app_exit_summary", begin: now, end: now,
            applicationVersion: "1.0", applicationBuild: "42", osVersion: "iOS 18.0", hangs: [],
            exits: [.init(state: "foreground", reason: "normal", count: 3),
                    .init(state: "background", reason: "memory_pressure", count: 2)], truncated: false)
        expect(await live.accept(input))
        let entry = try XCTUnwrap(outbox().hydrate().first)
        let object = try JSONSerialization.jsonObject(with: entry.envelopeBytes) as! [String: Any]
        let payload = object["payload"] as! [String: Any], diagnostic = payload["appleDiagnostic"] as! [String: Any]
        XCTAssertNil(diagnostic["occurredAt"]); XCTAssertNil(diagnostic["fatal"]); XCTAssertNil(diagnostic["processLaunchId"])
        XCTAssertEqual(diagnostic["outcome"] as? String, "unknown"); XCTAssertNil(payload["crash"])
        XCTAssertEqual((diagnostic["exits"] as? [[String: Any]])?.count, 2)
        if let path = ProcessInfo.processInfo.environment["EVERFRAME_APPLE_PROOF_DIR"] {
            let directory = URL(fileURLWithPath: path)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try entry.envelopeBytes.write(to: directory.appendingPathComponent("synthetic-apple-exits.json"))
        }
        live.boundary(); reject(await live.accept(candidate()))
    }
    func testExpiredReceiptsRemoveOnlyTheirOutboxBytes() async throws {
        let first = runtime(); expect(await first.enable(context: try context()))
        expect(await first.accept(candidate())); first.boundary(); reject(await first.accept(candidate()))
        let manual = OutboxEntry(reportId: UUID(), createdAt: now, envelopeBytes: Data("{}".utf8),
            idempotencyKey: "manual", attachmentRefs: [], sdkKey: "sdk-A", endpoint: "https://example.invalid/api/ingest")
        _ = try outbox().enqueueRecovered(manual)
        let next = runtime(at: now.addingTimeInterval(7 * 86400 + 1))
        expect(await next.enable(context: try context()))
        XCTAssertEqual(try outbox().hydrate(), [manual]); next.boundary(); reject(await next.accept(candidate()))
    }
    func testFrozenRedactionRemovesSensitiveBinaryNames() async throws {
        let live = runtime(); expect(await live.enable(context: try context()))
        let input = AppleDiagnosticCandidate(kind: "hang_batch", begin: now, end: now, applicationVersion: "1.0",
            applicationBuild: "42", osVersion: "iOS 18.0", hangs: [.init(durationMs: 2000,
            stack: .init(status: "available", truncated: false, frames: [.init(binaryUUID: UUID().uuidString,
                binaryName: "original-secret", address: "0x1000", offset: "0x1")]))], exits: [], truncated: false)
        expect(await live.accept(input))
        let entry = try XCTUnwrap(outbox().hydrate().first)
        XCTAssertFalse(String(decoding: entry.envelopeBytes, as: UTF8.self).contains("original-secret"))
        let envelope = try EverframeReportEnvelope(data: entry.envelopeBytes)
        XCTAssertTrue(envelope.payload.appleDiagnostic!.hangs![0].stack.frames.isEmpty)
        live.boundary(); reject(await live.accept(candidate()))
    }
    func testFullOutboxRetainsStagedReceiptForRestartWithoutEviction() async throws {
        let full = outbox(max: 2)
        let manuals = (0..<2).map { _ in OutboxEntry(reportId: UUID(), createdAt: now, envelopeBytes: Data("{}".utf8),
            idempotencyKey: UUID().uuidString, attachmentRefs: [], sdkKey: "manual-owner", endpoint: "https://example.invalid/api/ingest") }
        for manual in manuals { _ = try full.enqueueRecovered(manual) }
        let first = runtime(box: full); expect(await first.enable(context: try context()))
        expect(await first.accept(candidate()))
        XCTAssertEqual(try full.hydrate(), manuals); first.boundary(); reject(await first.accept(candidate()))
        // Once a slot frees, the next opt-in inserts the staged receipt.
        try full.drain(where: { $0.reportId == manuals[0].reportId })
        let next = runtime(box: outbox(max: 2)); expect(await next.enable(context: try context()))
        let queued = try full.hydrate()
        XCTAssertEqual(queued.count, 2); XCTAssertEqual(queued.first, manuals[1])
        XCTAssertTrue(AppleDiagnosticDelivery.isApple(try XCTUnwrap(queued.last))); next.boundary(); reject(await next.accept(candidate()))
    }
}

final class AppleDiagnosticTransportTests: XCTestCase {
    func testRevocationDuringAsyncConfigReadStopsRequestAdmission() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let owner = UUID()
        defer { AppleDiagnosticDelivery.remove(owner: owner); try? FileManager.default.removeItem(at: root) }
        let box = JSONLOutbox(fileURL: root.appendingPathComponent("queue"), keyProvider: { Data(repeating: 1, count: 32) })
        let id = UUID(), bytes = Data("{\"payload\":{\"appleDiagnostic\":{}}}".utf8)
        let entry = OutboxEntry(reportId: id, createdAt: Date(timeIntervalSince1970: floor(Date().timeIntervalSince1970)),
            envelopeBytes: bytes, idempotencyKey: id.uuidString, attachmentRefs: [], sdkKey: "key", endpoint: IngestEndpoint.url.absoluteString)
        _ = try box.enqueueRecovered(entry)
        AppleDiagnosticDelivery.publish(owner: owner, entry: entry) { XCTFail("Revoked receipt must not settle") }
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [AppleNeverUploadProtocol.self]
        let session = URLSession(configuration: config); defer { session.invalidateAndCancel() }
        let submitter = ReportSubmitter(config: EverframeConfig(appId: "key"), outbox: box, session: session)
        let entered = expectation(description: "async config read"), gate = AppleReplayGate()
        let task = Task {
            await submitter.drainOutbox(identityHolder: IdentityTokenHolder(), currentReplayConfig: {
                await gate.wait(entered: entered); return .off
            }, epochAtInitiation: 0, currentEpoch: { 0 })
        }
        await fulfillment(of: [entered], timeout: 3)
        AppleDiagnosticDelivery.remove(owner: owner)
        await gate.release(); await task.value
        XCTAssertEqual(try box.hydrate(), [entry])
    }
    func testDurableAppleEntryCannotDrainWithoutLiveReceiptAuthority() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let box = JSONLOutbox(fileURL: root.appendingPathComponent("queue"), keyProvider: { Data(repeating: 1, count: 32) })
        let id = UUID(); let bytes = Data("{\"payload\":{\"appleDiagnostic\":{\"evidenceId\":\"\(id.uuidString)\"}}}".utf8)
        let entry = OutboxEntry(reportId: id, createdAt: Date(timeIntervalSince1970: floor(Date().timeIntervalSince1970)),
            envelopeBytes: bytes, idempotencyKey: id.uuidString, attachmentRefs: [], sdkKey: "key", endpoint: "https://apple.invalid/ingest")
        _ = try box.enqueueRecovered(entry)
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [AppleNeverUploadProtocol.self]
        let session = URLSession(configuration: config); defer { session.invalidateAndCancel() }
        let submitter = ReportSubmitter(config: EverframeConfig(appId: "key"), outbox: box, session: session)
        await submitter.drainOutbox(identityHolder: IdentityTokenHolder(), currentReplayConfig: { .off }, epochAtInitiation: 0, currentEpoch: { 0 })
        XCTAssertEqual(try box.hydrate(), [entry])
    }
}
private final class AppleNeverUploadProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        XCTFail("An unowned Apple receipt reached network admission")
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private final class AppleDrainCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    var count: Int { lock.withLock { value } }
    func increment() { lock.withLock { value += 1 } }
}

private final class AppleAcceptProtocol: URLProtocol {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var recorded: [URLRequest] = []
    static var requests: [URLRequest] { lock.withLock { recorded } }
    static func reset() { lock.withLock { recorded = [] } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.withLock { Self.recorded.append(request) }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

/// A retryable answer: the receipt stays queued and no request leaves the process.
private final class AppleUnavailableProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 503, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private final class AppleDiagnosticKeyFailure: @unchecked Sendable {
    private let lock = NSLock()
    private var blocked = false
    var isBlocked: Bool { lock.withLock { blocked } }
    func set(_ value: Bool) { lock.withLock { blocked = value } }
}

private actor AppleReplayGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var released = false
    func wait(entered: XCTestExpectation) async {
        guard !released else { return }
        await withCheckedContinuation { continuation in self.continuation = continuation; entered.fulfill() }
    }
    func release() { released = true; continuation?.resume(); continuation = nil }
}

private final class AppleRetryProtocol: URLProtocol {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var recorded: [URLRequest] = []
    static var requests: [URLRequest] { lock.withLock { recorded } }
    nonisolated(unsafe) private static var recordedBodies: [Data] = []
    static var bodies: [Data] { lock.withLock { recordedBodies } }
    static func reset() { lock.withLock { recorded = []; recordedBodies = [] } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var body = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }; body.append(contentsOf: buffer.prefix(count))
            }
        }
        let status = Self.lock.withLock {
            Self.recorded.append(request); Self.recordedBodies.append(body)
            return Self.recorded.count == 1 ? 503 : 200
        }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
