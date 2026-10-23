// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// A linked capture that fails transiently is queued with its token's
// fingerprint, never the token, and is retried only while that same token is
// stored. It never lands in the shared inbox or under the device's next owner.
import XCTest
@testable import EverframeKit

final class DeviceLinkOutboxTests: XCTestCase {
    private var tempDir: URL!
    private var outboxURL: URL!
    private var outbox: JSONLOutbox!
    private var submitter: ReportSubmitter!
    private var store: DeviceLinkStore!

    override func setUpWithError() throws {
        try super.setUpWithError()
        RecordingURLProtocol.reset()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("everframe-device-link-outbox-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        outboxURL = tempDir.appendingPathComponent("outbox.jsonl")
        outbox = JSONLOutbox(testFileURL: outboxURL)
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [RecordingURLProtocol.self]
        submitter = ReportSubmitter(config: EverframeConfig(sdkKey: "app"), outbox: outbox,
                                    session: URLSession(configuration: cfg))
        store = DeviceLinkStore(secure: InMemoryDeviceLinkSecureStore())
    }

    override func tearDownWithError() throws {
        RecordingURLProtocol.reset()
        try? FileManager.default.removeItem(at: tempDir)
        try super.tearDownWithError()
    }

    private func queue(captureToken: String?) async throws {
        RecordingURLProtocol.responseStatus = 503
        let result = try await submitter.submit(
            envelopeBytes: Data("{}".utf8), idempotencyKey: UUID().uuidString, attachments: [],
            captureToken: captureToken, linkNonce: captureToken == nil ? nil : DeviceLinkNonce.make(), onAccepted: nil)
        guard case .queued = result else { return XCTFail("expected queued") }
        RecordingURLProtocol.reset()
    }

    private func drain() async {
        await submitter.drainOutbox(identityHolder: IdentityTokenHolder(), currentReplayConfig: { .off },
                                    epochAtInitiation: 0, currentEpoch: { 0 }, deviceLinks: store)
    }

    private func saveLink(_ token: String) {
        store.save(DeviceLink(token: token, owner: .user(name: "Aurimas")), endpoint: IngestEndpoint.url, sdkKey: "app")
    }

    func testRetryableFailureQueuesFingerprintNotToken() async throws {
        try await queue(captureToken: fixtureToken)
        let entries = try outbox.hydrate()
        XCTAssertEqual(entries.count, 1)
        XCTAssertEqual(entries.first?.deviceTokenFingerprint, DeviceLinkToken.fingerprint(fixtureToken))
        let raw = try Data(contentsOf: outboxURL)
        XCTAssertNil(raw.range(of: Data(fixtureToken.utf8)))
        XCTAssertNil(raw.range(of: Data(Data(fixtureToken.utf8).base64EncodedString().utf8)))
        // The decrypted entry never holds the token either.
        let encoded = try JSONEncoder().encode(try XCTUnwrap(entries.first))
        XCTAssertNil(encoded.range(of: Data(fixtureToken.utf8)))
    }

    func testCaptureTokenEntriesHaveNoFingerprint() async throws {
        try await queue(captureToken: "evf_cap_x")
        XCTAssertNil(try outbox.hydrate().first?.deviceTokenFingerprint)
        try await queue(captureToken: nil)
        XCTAssertEqual(try outbox.hydrate().compactMap(\.deviceTokenFingerprint), [])
    }

    func testFingerprintIsNotEncodedWhenNil() throws {
        let entry = OutboxEntry(reportId: UUID(), createdAt: Date(), envelopeBytes: Data("{}".utf8),
                                idempotencyKey: "i", attachmentRefs: [], sdkKey: "app", endpoint: "https://x")
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(entry)) as? [String: Any]
        XCTAssertFalse(object?.keys.contains("deviceTokenFingerprint") ?? true)
    }

    func testDrainSendsWithCurrentTokenWhenFingerprintMatches() async throws {
        try await queue(captureToken: fixtureToken)
        saveLink(fixtureToken)
        await drain()
        XCTAssertEqual(RecordingURLProtocol.recorded.count, 1)
        XCTAssertTrue(RecordingURLProtocol.recorded.first?.captureToken == fixtureToken)
        XCTAssertNil(RecordingURLProtocol.recorded.first?.linkNonce)
        XCTAssertTrue(try outbox.hydrate().isEmpty)
    }

    func testDrainKeepsEntryOnTransientFailure() async throws {
        try await queue(captureToken: fixtureToken)
        saveLink(fixtureToken)
        RecordingURLProtocol.responseStatus = 503
        await drain()
        XCTAssertEqual(RecordingURLProtocol.recorded.count, 1)
        XCTAssertEqual(try outbox.hydrate().first?.deviceTokenFingerprint, DeviceLinkToken.fingerprint(fixtureToken))
    }

    func testDrainDropsEntryWhenTokenChangedOrMissing() async throws {
        try await queue(captureToken: fixtureToken)
        saveLink(otherToken)
        await drain()
        XCTAssertTrue(RecordingURLProtocol.recorded.isEmpty)
        XCTAssertTrue(try outbox.hydrate().isEmpty)

        try await queue(captureToken: fixtureToken)
        store.clear(endpoint: IngestEndpoint.url, sdkKey: "app", ifFingerprint: DeviceLinkToken.fingerprint(otherToken))
        await drain()
        XCTAssertTrue(RecordingURLProtocol.recorded.isEmpty)
        XCTAssertTrue(try outbox.hydrate().isEmpty)
    }

    func testDrainDeviceUnlinkedClearsMatchingToken() async throws {
        try await queue(captureToken: fixtureToken)
        saveLink(fixtureToken)
        RecordingURLProtocol.responseStatus = 403
        RecordingURLProtocol.responseBody = Data(#"{"error":"device_unlinked"}"#.utf8)
        await drain()
        XCTAssertEqual(RecordingURLProtocol.recorded.count, 1)
        XCTAssertTrue(try outbox.hydrate().isEmpty)
        XCTAssertNil(store.link(endpoint: IngestEndpoint.url, sdkKey: "app"))
    }

    func testLegacyEntryWithoutFieldDecodesAndDrainsAsToday() async throws {
        let legacy = #"{"reportId":"\#(UUID())","createdAt":0,"envelopeBytes":"e30=","idempotencyKey":"legacy","attachmentRefs":[],"sdkKey":"app","endpoint":"\#(IngestEndpoint.url.absoluteString)"}"#
        let entry = try JSONDecoder().decode(OutboxEntry.self, from: Data(legacy.utf8))
        XCTAssertNil(entry.deviceTokenFingerprint)
        try outbox.enqueue(entry)
        saveLink(fixtureToken)
        await drain()
        XCTAssertEqual(RecordingURLProtocol.recorded.count, 1)
        XCTAssertNil(RecordingURLProtocol.recorded.first?.captureToken)
        XCTAssertTrue(try outbox.hydrate().isEmpty)
    }
}
