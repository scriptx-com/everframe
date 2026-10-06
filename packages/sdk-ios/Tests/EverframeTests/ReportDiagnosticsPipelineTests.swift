// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
import CryptoKit
@testable import EverframeKit

final class ReportDiagnosticsPipelineTests: XCTestCase {
    private var directory: URL!
    private let ledger = ReportDiagnostics()
    private var owner: ReportDiagnostics.Handle!
    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        owner = ledger.beginGeneration(epoch: 1, enabled: true)
        DeliveryURLProtocol.response = { .success(202) }
    }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: directory) }
    private func box(_ name: String = "queue", capacity: Int = 50) -> JSONLOutbox {
        JSONLOutbox(testFileURL: directory.appendingPathComponent(name), maxEntries: capacity)
    }
    private func entry() -> OutboxEntry {
        OutboxEntry(reportId: UUID(), createdAt: Date(), envelopeBytes: Data("private report".utf8),
            idempotencyKey: "private-token", attachmentRefs: [], sdkKey: "private-key",
            endpoint: "https://delivery.invalid", identitySubject: "private-subject")
    }
    private func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [DeliveryURLProtocol.self]
        return URLSession(configuration: config)
    }
    private func drain(_ sender: ReportSubmitter) async {
        await sender.drainOutbox(identityHolder: IdentityTokenHolder(), currentReplayConfig: { .off },
            epochAtInitiation: 1, currentEpoch: { 1 })
    }

    func testDurableEvictionDuplicateAndRemovalNoOp() throws {
        let queue = box(capacity: 1), first = entry(), second = entry()
        try queue.enqueue(first, diagnostics: owner)
        try queue.enqueue(first, diagnostics: owner)
        XCTAssertEqual(ledger.snapshot().queue.operations["capacity-evicted"], 0)
        try queue.enqueue(second, diagnostics: owner)
        XCTAssertEqual(ledger.snapshot().queue.operations["capacity-evicted"], 1)
        XCTAssertEqual(try queue.hydrate().map(\.reportId), [second.reportId])
        try queue.drain(where: { $0.reportId == first.reportId }, diagnostics: owner, reason: .removedAfterAcceptance)
        XCTAssertEqual(ledger.snapshot().queue.operations["removed-after-acceptance"], 0)
        try queue.drain(where: { $0.reportId == second.reportId }, diagnostics: owner, reason: .removedAfterAcceptance)
        XCTAssertEqual(ledger.snapshot().queue.pendingCount, 0)
        XCTAssertEqual(ledger.snapshot().queue.operations["removed-after-acceptance"], 1)
        XCTAssertFalse(try ledger.snapshot().toJSON().contains("private"))
    }

    func testUnsupportedPartialAndCorruptReadsDoNotInventEmptyQueues() throws {
        let queue = box()
        try Data("legacy private content".utf8).write(to: queue.resolvedFileURL)
        XCTAssertEqual(try queue.hydrate(diagnostics: owner).count, 0)
        XCTAssertNil(ledger.snapshot().queue.pendingCount)
        XCTAssertEqual(ledger.snapshot().queue.quality, "unknown")
        XCTAssertEqual(ledger.snapshot().queue.migration, "blocked")
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601
        let lines = try encoder.encode(entry()) + Data("\nmalformed private line\n".utf8)
        let sealed = try AES.GCM.seal(lines, using: SymmetricKey(data: Data(repeating: 0xA7, count: 32)), authenticating: Data("EVRBOX01".utf8))
        try (Data("EVRBOX01".utf8) + XCTUnwrap(sealed.combined)).write(to: queue.resolvedFileURL)
        XCTAssertEqual(try queue.hydrate(diagnostics: owner).count, 1)
        XCTAssertEqual(ledger.snapshot().queue.pendingCount, 1)
        XCTAssertEqual(ledger.snapshot().queue.quality, "partial")
        try Data("EVRBOX01broken".utf8).write(to: queue.resolvedFileURL)
        XCTAssertThrowsError(try queue.hydrate(diagnostics: owner))
        XCTAssertNil(ledger.snapshot().queue.pendingCount)
        XCTAssertEqual(ledger.snapshot().queue.operations["read-failed"], 1)
    }

    func testFailedEnqueueAndUnboundStoreCannotClaimEviction() throws {
        let queue = box(capacity: 0)
        XCTAssertThrowsError(try queue.enqueue(entry(), diagnostics: owner))
        XCTAssertEqual(ledger.snapshot().queue.lastFailure, "capacity")
        XCTAssertEqual(ledger.snapshot().queue.operations["capacity-evicted"], 0)
        let unbound = box("custom")
        try unbound.enqueue(entry())
        XCTAssertEqual(ledger.snapshot().queue.operations["enqueue-committed"], 0)
        let keyFailure = JSONLOutbox(fileURL: directory.appendingPathComponent("key"), keyProvider: { throw OutboxStorageError.invalidKey })
        XCTAssertThrowsError(try keyFailure.enqueue(entry(), diagnostics: owner))
        XCTAssertEqual(ledger.snapshot().queue.lastFailure, "key-unavailable")
    }

    func testFailedRewriteDoesNotClaimEvictionAndGetterDoesNotReadKeys() throws {
        let url = directory.appendingPathComponent("rewrite")
        let original = JSONLOutbox(testFileURL: url, maxEntries: 1)
        let first = entry(); try original.enqueue(first)
        let gate = DeliveryKeyGate()
        let queue = JSONLOutbox(fileURL: url, maxEntries: 1, keyProvider: { try gate.read() })
        XCTAssertThrowsError(try queue.enqueue(entry(), diagnostics: owner))
        XCTAssertEqual(ledger.snapshot().queue.operations["capacity-evicted"], 0)
        XCTAssertEqual(ledger.snapshot().queue.operations["enqueue-committed"], 0)
        XCTAssertEqual(try original.hydrate().map(\.reportId), [first.reportId])
        let reads = gate.count
        for _ in 0..<100 { _ = try ledger.snapshot().toJSON() }
        XCTAssertEqual(gate.count, reads)
    }

    func testHTTPClassificationsAndTerminalDrainPolicy() async throws {
        let session = session(); defer { session.invalidateAndCancel() }
        for status in [202, 400, 403, 408, 429, 503] {
            let owner = ledger.beginGeneration(epoch: status, enabled: true)
            DeliveryURLProtocol.response = { .success(status) }
            let queue = box("http-\(status)")
            let sender = ReportSubmitter(config: EverframeConfig(appId: "fixture"), outbox: queue, session: session).observing(owner)
            do { _ = try await sender.submit(envelopeBytes: Data("{}".utf8), idempotencyKey: "one", attachments: [], endpoint: "https://delivery.invalid") }
            catch { XCTAssertTrue([400, 403].contains(status)) }
            let expected = status == 202 ? "server-accepted" : [408, 429, 503].contains(status) ? "retryable-http" : "terminal-http"
            XCTAssertEqual(ledger.snapshot().transport["live-submit"]?.lastOutcome, expected)
            XCTAssertEqual(ledger.snapshot().transport["live-submit"]?.settledAttempts, 1)
        }
        owner = ledger.beginGeneration(epoch: 1, enabled: true)
        let queue = box("drain")
        try queue.enqueue(entry())
        let sender = ReportSubmitter(config: EverframeConfig(appId: "fixture"), outbox: queue, session: session).observing(owner)
        DeliveryURLProtocol.response = { .success(503) }
        await drain(sender)
        XCTAssertEqual(try queue.hydrate().count, 1)
        XCTAssertEqual(ledger.snapshot().queue.operations["enqueue-committed"], 1)
        DeliveryURLProtocol.response = { .success(400) }
        await drain(sender)
        XCTAssertEqual(try queue.hydrate().count, 0)
        XCTAssertEqual(ledger.snapshot().queue.operations["removed-after-terminal"], 1)
        XCTAssertEqual(ledger.snapshot().transport["outbox-drain"]?.settledAttempts, 2)
        XCTAssertEqual(ledger.snapshot().transport["live-submit"]?.settledAttempts, 0)
    }

    func testAcceptedHTTPWithCorruptedQueueReportsRemovalFailure() async throws {
        let queue = box(); try queue.enqueue(entry())
        let session = session(); defer { session.invalidateAndCancel() }
        DeliveryURLProtocol.response = {
            try! Data("EVRBOX01corrupted".utf8).write(to: queue.resolvedFileURL)
            return .success(202)
        }
        await drain(ReportSubmitter(config: EverframeConfig(appId: "fixture"), outbox: queue, session: session).observing(owner))
        XCTAssertEqual(ledger.snapshot().transport["outbox-drain"]?.outcomes["server-accepted"], 1)
        XCTAssertEqual(ledger.snapshot().queue.operations["removed-after-acceptance"], 0)
        XCTAssertEqual(ledger.snapshot().queue.operations["removal-failed"], 1)
        XCTAssertNil(ledger.snapshot().queue.pendingCount)
    }

    func testNetworkCancellationAuthorizationAndLateGeneration() async throws {
        let session = session(); defer { session.invalidateAndCancel() }
        let sender = ReportSubmitter(config: EverframeConfig(appId: "fixture"), outbox: box(), session: session).observing(owner)
        DeliveryURLProtocol.response = { .failure(URLError(.notConnectedToInternet)) }
        _ = try await sender.submit(envelopeBytes: Data(), idempotencyKey: "network", attachments: [], endpoint: "https://delivery.invalid")
        XCTAssertEqual(ledger.snapshot().transport["live-submit"]?.lastOutcome, "network-failure")
        DeliveryURLProtocol.response = { .failure(URLError(.cancelled)) }
        do { _ = try await sender.submit(envelopeBytes: Data(), idempotencyKey: "cancel", attachments: [], endpoint: "https://delivery.invalid"); XCTFail("cancellation must still throw") } catch {}
        XCTAssertEqual(ledger.snapshot().transport["live-submit"]?.lastOutcome, "cancelled")
        do { _ = try await sender.authorizing { false }.submit(envelopeBytes: Data(), idempotencyKey: "auth", attachments: [], endpoint: "https://delivery.invalid"); XCTFail("revocation must throw") } catch { XCTAssertTrue(error is UploadAuthorizationError) }
        XCTAssertEqual(ledger.snapshot().transport["live-submit"]?.lastOutcome, "authorization-cancelled")
        DeliveryURLProtocol.response = { [ledger] in
            ledger.beginGeneration(epoch: 2, enabled: true)
            return .success(202)
        }
        _ = try await sender.submit(envelopeBytes: Data(), idempotencyKey: "old", attachments: [], endpoint: "https://delivery.invalid")
        XCTAssertEqual(ledger.snapshot().revision, 0)
    }
}

private final class DeliveryURLProtocol: URLProtocol {
    nonisolated(unsafe) static var response: () -> Result<Int, Error> = { .success(202) }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "delivery.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        switch Self.response() {
        case .success(let status):
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: [:])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocolDidFinishLoading(self)
        case .failure(let error): client?.urlProtocol(self, didFailWithError: error)
        }
    }
    override func stopLoading() {}
}

private final class DeliveryKeyGate: @unchecked Sendable {
    private let lock = NSLock()
    private var reads = 0
    var count: Int { lock.lock(); defer { lock.unlock() }; return reads }
    func read() throws -> Data {
        lock.lock(); defer { lock.unlock() }
        reads += 1
        if reads == 2 { throw OutboxStorageError.invalidKey }
        return Data(repeating: 0xA7, count: 32)
    }
}
