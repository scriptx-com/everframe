// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
@testable import TraceItXKit

/// URLProtocol stub that captures the outbound request (incl. body) and returns a synthesized HTTP response.
final class StubURLProtocol: URLProtocol {

    /// Set per-test (read off the main thread by URLProtocol). Static-mutable
    /// is safe here because tests run sequentially.
    nonisolated(unsafe) static var capturedRequest: URLRequest?
    nonisolated(unsafe) static var capturedBody: Data?
    nonisolated(unsafe) static var stubStatus: Int = 200
    nonisolated(unsafe) static var stubHeaders: [String: String] = [:]

    static func reset() {
        capturedRequest = nil
        capturedBody = nil
        stubStatus = 200
        stubHeaders = [:]
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        // The httpBodyStream is what URLSession.upload(for:from:) sets — drain it.
        var body = Data()
        if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            let bufferSize = 64 * 1024
            var buffer = [UInt8](repeating: 0, count: bufferSize)
            while true {
                let read = stream.read(&buffer, maxLength: bufferSize)
                if read <= 0 { break }
                body.append(buffer, count: read)
            }
        } else if let direct = request.httpBody {
            body = direct
        }
        StubURLProtocol.capturedRequest = request
        StubURLProtocol.capturedBody = body

        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: StubURLProtocol.stubStatus,
            httpVersion: "HTTP/1.1",
            headerFields: StubURLProtocol.stubHeaders
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data())
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() { /* no-op */ }
}

final class MultipartUploaderTests: XCTestCase {
    @MainActor func test_revoked_after_packing_never_starts_request() async throws {
        let session = makeStubSession()
        var uploader = MultipartUploader(endpoint: URL(string: "https://ingest.example.test")!, sdkKey: "k")
        uploader.authorizeUpload = { false }
        do {
            _ = try await uploader.upload(parts: [.init(name: "replay", filename: "replay.mp4",
                contentType: "video/mp4", data: Data(repeating: 0, count: 1024))],
                idempotencyKey: "revoked", urlSession: session)
            XCTFail("Revoked bytes must not start an upload")
        } catch UploadAuthorizationError.revoked { }
        XCTAssertNil(StubURLProtocol.capturedRequest)
    }

    @MainActor func test_authorized_request_still_uploads_binary_body() async throws {
        let session = makeStubSession()
        var uploader = MultipartUploader(endpoint: URL(string: "https://ingest.example.test")!, sdkKey: "k")
        uploader.authorizeUpload = { true }
        let result = try await uploader.upload(parts: [.init(name: "replay", filename: "replay.mp4",
            contentType: "video/mp4", data: Data([0, 1, 2, 255]))], idempotencyKey: "allowed", urlSession: session)
        XCTAssertEqual(result.statusCode, 200)
        XCTAssertNotNil(StubURLProtocol.capturedBody?.range(of: Data([0, 1, 2, 255])))
    }

    private func makeStubSession() -> URLSession {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: cfg)
    }

    override func setUp() {
        super.setUp()
        StubURLProtocol.reset()
    }

    func test_upload_sets_multipart_content_type_with_boundary() async throws {
        let session = makeStubSession()
        let uploader = MultipartUploader(endpoint: URL(string: "https://ingest.example.test/v1/reports")!, sdkKey: "k")
        let parts: [MultipartUploader.Part] = [
            .init(name: "envelope", filename: "envelope.json", contentType: "application/json", data: Data("{}".utf8))
        ]
        _ = try await uploader.upload(parts: parts, idempotencyKey: "idem-1", urlSession: session)

        let ct = StubURLProtocol.capturedRequest?.value(forHTTPHeaderField: "Content-Type") ?? ""
        XCTAssertTrue(ct.hasPrefix("multipart/form-data; boundary="), "got Content-Type=\(ct)")
    }

    func test_upload_sets_authorization_bearer_header() async throws {
        let session = makeStubSession()
        let uploader = MultipartUploader(endpoint: URL(string: "https://ingest.example.test/v1/reports")!, sdkKey: "my-sdk-key")
        let parts: [MultipartUploader.Part] = [
            .init(name: "envelope", filename: "envelope.json", contentType: "application/json", data: Data("{}".utf8))
        ]
        _ = try await uploader.upload(parts: parts, idempotencyKey: "idem-1", urlSession: session)

        let auth = StubURLProtocol.capturedRequest?.value(forHTTPHeaderField: "Authorization") ?? ""
        XCTAssertEqual(auth, "Bearer my-sdk-key")
    }

    func test_upload_sets_idempotency_key_header() async throws {
        let session = makeStubSession()
        let uploader = MultipartUploader(endpoint: URL(string: "https://ingest.example.test/v1/reports")!, sdkKey: "k")
        let parts: [MultipartUploader.Part] = [
            .init(name: "envelope", filename: "envelope.json", contentType: "application/json", data: Data("{}".utf8))
        ]
        _ = try await uploader.upload(parts: parts, idempotencyKey: "sha256-deadbeef", urlSession: session)

        let idem = StubURLProtocol.capturedRequest?.value(forHTTPHeaderField: "X-TraceItX-Idempotency-Key") ?? ""
        XCTAssertEqual(idem, "sha256-deadbeef")
    }

    func test_upload_body_contains_envelope_and_attachment_parts() async throws {
        let session = makeStubSession()
        let uploader = MultipartUploader(endpoint: URL(string: "https://ingest.example.test/v1/reports")!, sdkKey: "k")
        let parts: [MultipartUploader.Part] = [
            .init(name: "envelope", filename: "envelope.json", contentType: "application/json", data: Data("{\"hello\":\"world\"}".utf8)),
            .init(name: "screenshot", filename: "screenshot.png", contentType: "image/png", data: Data([0x89, 0x50, 0x4E, 0x47]))
        ]
        _ = try await uploader.upload(parts: parts, idempotencyKey: "idem-1", urlSession: session)

        let body = StubURLProtocol.capturedBody ?? Data()
        // Multipart includes binary PNG bytes, so the whole body is not UTF-8.
        let bodyStr = String(decoding: body, as: UTF8.self)
        XCTAssertNotNil(body.range(of: Data([0x89, 0x50, 0x4E, 0x47])))
        XCTAssertTrue(bodyStr.contains("name=\"envelope\""), "envelope part missing")
        XCTAssertTrue(bodyStr.contains("filename=\"envelope.json\""), "envelope filename missing")
        XCTAssertTrue(bodyStr.contains("Content-Type: application/json"), "envelope CT missing")
        XCTAssertTrue(bodyStr.contains("name=\"screenshot\""), "screenshot part missing")
        XCTAssertTrue(bodyStr.contains("filename=\"screenshot.png\""), "screenshot filename missing")
        XCTAssertTrue(bodyStr.contains("Content-Type: image/png"), "screenshot CT missing")
        // RFC-7578 closing delimiter
        let ct = StubURLProtocol.capturedRequest?.value(forHTTPHeaderField: "Content-Type") ?? ""
        let boundary = ct.replacingOccurrences(of: "multipart/form-data; boundary=", with: "")
        XCTAssertTrue(bodyStr.contains("--\(boundary)--"), "closing boundary missing")
    }

    func test_upload_returns_status_and_headers_on_2xx() async throws {
        StubURLProtocol.stubStatus = 202
        StubURLProtocol.stubHeaders = ["X-Foo": "bar"]
        let session = makeStubSession()
        let uploader = MultipartUploader(endpoint: URL(string: "https://ingest.example.test/v1/reports")!, sdkKey: "k")
        let parts: [MultipartUploader.Part] = [
            .init(name: "envelope", filename: "envelope.json", contentType: "application/json", data: Data("{}".utf8))
        ]
        let (status, headers) = try await uploader.upload(parts: parts, idempotencyKey: "idem-1", urlSession: session)
        XCTAssertEqual(status, 202)
        XCTAssertEqual(headers["X-Foo"] as? String, "bar")
    }
}
