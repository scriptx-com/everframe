// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
@testable import EverframeKit

/// EverframeCaptures the URL and Authorization header of every request a stubbed
/// URLSession issues, and answers with a configurable status. Used to assert
/// WHICH project an outbox entry was submitted to.
final class RecordingURLProtocol: URLProtocol {

    struct Record {
        let host: String
        let authorization: String?
        /// Native identity Task 8b — the header `resolveIdentityHeader`
        /// decides whether to attach. `nil` means the request carried no
        /// `X-Everframe-Identity-Token` header at all (sent anonymously), which is
        /// what distinguishes "no header" from a future accidental empty
        /// string.
        let identityToken: String?
    }

    nonisolated(unsafe) static var recorded: [Record] = []
    nonisolated(unsafe) static var responseStatus: Int = 200
    nonisolated(unsafe) static var onRequest: (() -> Void)?

    static func reset() {
        recorded = []
        responseStatus = 200
        onRequest = nil
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else { return }
        Self.onRequest?()
        Self.recorded.append(Record(
            host: url.host ?? "",
            authorization: request.value(forHTTPHeaderField: "Authorization"),
            identityToken: request.value(forHTTPHeaderField: IDENTITY_TOKEN_HEADER)))

        let response = HTTPURLResponse(
            url: url,
            statusCode: Self.responseStatus,
            httpVersion: "HTTP/1.1",
            headerFields: [:])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data())
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
