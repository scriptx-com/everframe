// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Ingest plumbing for device linking: the link nonce rides a linked quick
// capture, the accepted body reaches the caller (for `linkPending`), and a
// `403 device_unlinked` for a device token throws without queueing.
import XCTest
@testable import EverframeKit

private final class BodyBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [Data] = []
    func append(_ data: Data) { lock.lock(); stored.append(data); lock.unlock() }
    var values: [Data] { lock.lock(); defer { lock.unlock() }; return stored }
}

final class DeviceLinkIngestTests: XCTestCase {
    private var tempDir: URL!
    private var outbox: JSONLOutbox!
    private var submitter: ReportSubmitter!

    override func setUpWithError() throws {
        try super.setUpWithError()
        RecordingURLProtocol.reset()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("everframe-device-link-ingest-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        outbox = JSONLOutbox(testFileURL: tempDir.appendingPathComponent("outbox.jsonl"))
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [RecordingURLProtocol.self]
        submitter = ReportSubmitter(config: EverframeConfig(sdkKey: "app"), outbox: outbox,
                                    session: URLSession(configuration: cfg))
    }

    override func tearDownWithError() throws {
        RecordingURLProtocol.reset()
        try? FileManager.default.removeItem(at: tempDir)
        try super.tearDownWithError()
    }

    private func submit(captureToken: String?, linkNonce: String?,
                        onAccepted: (@Sendable (Data) -> Void)? = nil) async throws -> ReportResult {
        try await submitter.submit(
            envelopeBytes: Data("{}".utf8), idempotencyKey: UUID().uuidString, attachments: [],
            captureToken: captureToken, linkNonce: linkNonce, onAccepted: onAccepted)
    }

    func testLinkNonceHeaderRidesQuickCaptureUpload() async throws {
        let nonce = DeviceLinkNonce.make()
        let result = try await submit(captureToken: fixtureToken, linkNonce: nonce)
        guard case .submitted = result else { return XCTFail("not submitted") }
        XCTAssertEqual(RecordingURLProtocol.recorded.count, 1)
        XCTAssertTrue(RecordingURLProtocol.recorded.first?.linkNonce == nonce)
        XCTAssertTrue(RecordingURLProtocol.recorded.first?.captureToken == fixtureToken)
    }

    func testNoLinkNonceByDefault() async throws {
        _ = try await submitter.submit(envelopeBytes: Data("{}".utf8), idempotencyKey: "i", attachments: [],
                                       captureToken: fixtureToken)
        XCTAssertNil(RecordingURLProtocol.recorded.first?.linkNonce)
        _ = try await submit(captureToken: nil, linkNonce: nil)
        XCTAssertNil(RecordingURLProtocol.recorded.last?.linkNonce)
        XCTAssertNil(RecordingURLProtocol.recorded.last?.captureToken)
    }

    func testAcceptedBodyIsHandedToCallback() async throws {
        let id = UUID()
        RecordingURLProtocol.responseBody = Data(#"{"reportId":"r","linkPending":{"attemptId":"\#(id)","number":47}}"#.utf8)
        let box = BodyBox()
        _ = try await submit(captureToken: fixtureToken, linkNonce: DeviceLinkNonce.make(), onAccepted: { box.append($0) })
        XCTAssertEqual(box.values.count, 1)
        XCTAssertEqual(DeviceLinkPending.fromIngestBody(box.values.first ?? Data()), DeviceLinkPending(attemptId: id, number: 47))
    }

    func testCallbackNotCalledOnFailure() async throws {
        RecordingURLProtocol.responseStatus = 503
        let box = BodyBox()
        let result = try await submit(captureToken: nil, linkNonce: nil, onAccepted: { box.append($0) })
        guard case .queued = result else { return XCTFail("expected queued") }
        XCTAssertTrue(box.values.isEmpty)
    }

    func test403DeviceUnlinkedWithDeviceTokenThrowsAndQueuesNothing() async throws {
        RecordingURLProtocol.responseStatus = 403
        RecordingURLProtocol.responseBody = Data(#"{"error":"device_unlinked"}"#.utf8)
        do {
            _ = try await submit(captureToken: fixtureToken, linkNonce: DeviceLinkNonce.make())
            XCTFail("expected deviceUnlinked")
        } catch let error as DeviceLinkRejection {
            XCTAssertEqual(error, .deviceUnlinked)
        }
        XCTAssertTrue(try outbox.hydrate().isEmpty)
    }

    func test403WithCaptureTokenStaysServerError() async throws {
        RecordingURLProtocol.responseStatus = 403
        RecordingURLProtocol.responseBody = Data(#"{"error":"device_unlinked"}"#.utf8)
        do {
            _ = try await submit(captureToken: "evf_cap_x", linkNonce: nil)
            XCTFail("expected serverError")
        } catch EverframeTransportError.serverError(let status) {
            XCTAssertEqual(status, 403)
        }
        XCTAssertTrue(try outbox.hydrate().isEmpty)
    }

    func test403OtherBodyWithDeviceTokenStaysServerError() async throws {
        RecordingURLProtocol.responseStatus = 403
        RecordingURLProtocol.responseBody = Data(#"{"error":"forbidden"}"#.utf8)
        do {
            _ = try await submit(captureToken: fixtureToken, linkNonce: nil)
            XCTFail("expected serverError")
        } catch EverframeTransportError.serverError(let status) {
            XCTAssertEqual(status, 403)
        }
    }

    func testPublicUploadSignatureStillReturnsStatusAndHeaders() async throws {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [RecordingURLProtocol.self]
        let uploader = MultipartUploader(endpoint: URL(string: "https://ingest.example")!, sdkKey: "k")
        let (status, _) = try await uploader.upload(parts: [], idempotencyKey: "i", urlSession: URLSession(configuration: cfg))
        XCTAssertEqual(status, 200)
        XCTAssertNil(RecordingURLProtocol.recorded.first?.linkNonce)
    }
}

/// The link nonce is stripped with the capture token on a cross-origin
/// redirect, against two real local servers (see `IdentityHeaderRedirectTests`).
final class DeviceLinkRedirectTests: XCTestCase {
    private var serverA: RecordingHTTPServer!
    private var serverB: RecordingHTTPServer!
    private var tempDir: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        serverA = try RecordingHTTPServer()
        serverB = try RecordingHTTPServer()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("everframe-link-redirect-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        serverA?.stop()
        serverB?.stop()
        try? FileManager.default.removeItem(at: tempDir)
        try super.tearDownWithError()
    }

    private func submitter() -> ReportSubmitter {
        ReportSubmitter(config: EverframeConfig(sdkKey: "app"),
                        outbox: JSONLOutbox(testFileURL: tempDir.appendingPathComponent("outbox.jsonl")))
    }

    func testRedirectGuardStripsLinkNonce() async throws {
        serverA.respond = { [serverB] _ in
            (302, ["Location": serverB!.url.appendingPathComponent("api/ingest").absoluteString], Data())
        }
        serverB.respond = { _ in (200, ["Content-Type": "application/json"], Data("{}".utf8)) }
        let nonce = DeviceLinkNonce.make()
        let result = try await submitter().submit(
            envelopeBytes: Data("{}".utf8), idempotencyKey: "idem-link-1", attachments: [],
            captureToken: fixtureToken, endpoint: serverA.url.absoluteString, linkNonce: nonce, onAccepted: nil)
        guard case .submitted = result else { return XCTFail("not submitted") }
        XCTAssertTrue(serverA.recorded.first?.headers["X-Everframe-Link-Nonce"] == nonce)
        XCTAssertEqual(serverB.recorded.count, 1)
        XCTAssertNil(serverB.recorded.first?.headers["X-Everframe-Link-Nonce"])
        XCTAssertNil(serverB.recorded.first?.headers["X-Everframe-Capture-Token"])
    }

    func testSameOriginRedirectKeepsLinkNonceAndToken() async throws {
        var redirectedOnce = false
        serverA.respond = { request in
            if request.path == "/api/ingest" && !redirectedOnce {
                redirectedOnce = true
                return (302, ["Location": "/api/ingest/"], Data())
            }
            return (200, ["Content-Type": "application/json"], Data("{}".utf8))
        }
        let nonce = DeviceLinkNonce.make()
        let result = try await submitter().submit(
            envelopeBytes: Data("{}".utf8), idempotencyKey: "idem-link-2", attachments: [],
            captureToken: fixtureToken, endpoint: serverA.url.absoluteString, linkNonce: nonce, onAccepted: nil)
        guard case .submitted = result else { return XCTFail("not submitted") }
        XCTAssertEqual(serverA.recorded.count, 2)
        XCTAssertTrue(serverA.recorded.last?.headers["X-Everframe-Link-Nonce"] == nonce)
        XCTAssertTrue(serverA.recorded.last?.headers["X-Everframe-Capture-Token"] == fixtureToken)
    }
}
