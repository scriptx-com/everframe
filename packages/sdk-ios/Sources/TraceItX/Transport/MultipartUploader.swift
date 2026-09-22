// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

/// Hand-rolled RFC-7578 multipart/form-data uploader (per CONTEXT lock — no Alamofire).
/// Posts envelope + per-attachment parts via `URLSession.upload(for:from:)` async/await.
public struct MultipartUploader {

    public let endpoint: URL
    public let sdkKey: String
    internal var authorizeUpload: (@MainActor @Sendable () -> Bool)?

    /// One form-data part. Caller supplies the `name`, `filename`, `contentType`, and raw bytes.
    public struct Part {
        public let name: String
        public let filename: String
        public let contentType: String
        public let data: Data

        public init(name: String, filename: String, contentType: String, data: Data) {
            self.name = name
            self.filename = filename
            self.contentType = contentType
            self.data = data
        }
    }

    public init(endpoint: URL, sdkKey: String) {
        self.endpoint = endpoint
        self.sdkKey = sdkKey
    }

    /// Builds the multipart body, sets headers, and uploads via the given URLSession.
    /// Returns the HTTP status code and response headers; throws on non-HTTP responses
    /// or transport errors.
    /// - Parameter companionAttribution: Companion attribution token for a
    ///   dashboard-initiated report (spec 2026-08-07). When non-nil it rides
    ///   this POST as `X-TX-Companion-Attribution` so ingest can credit the
    ///   report to the team member who filed it. nil on every ordinary
    ///   (in-app or QR-paired) submit — the request is then byte-for-byte what
    ///   it was before companion existed. SECURITY: never log it.
    /// - Parameter identityToken: Verified-identity JWT (recognition spec
    ///   2026-08-06), already resolved by the caller via
    ///   `resolveIdentityHeader` — this function does no gating of its own,
    ///   it only attaches whatever it is handed. Rides as
    ///   `X-TX-Identity-Token`. nil sends the report anonymously.
    public func upload(
        parts: [Part],
        idempotencyKey: String,
        companionAttribution: String? = nil,
        identityToken: String? = nil,
        urlSession: URLSession = .shared
    ) async throws -> (statusCode: Int, headers: [AnyHashable: Any]) {

        let boundary = "----TraceItX\(UUID().uuidString)"
        let body = Self.buildBody(parts: parts, boundary: boundary)

        // Append the ingest path. `endpoint` is the configured BASE URL
        // (matching @traceitx/react's contract — see sdk-react/src/
        // transport/submit.ts:55). Previously this POSTed to the bare base
        // and got 404'd by every ingest path; the example saw
        // TraceItXTransportError on every submit.
        let ingestURL: URL = {
            var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)
            let basePath = (components?.path ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            // If the host already specified an /api/ingest-suffixed endpoint
            // (custom routing, reverse proxy stripping the prefix), don't
            // double-append.
            if basePath.hasSuffix("api/ingest") {
                return endpoint
            }
            components?.path = "/" + (basePath.isEmpty ? "api/ingest" : "\(basePath)/api/ingest")
            return components?.url ?? endpoint
        }()

        var req = URLRequest(url: ingestURL)
        req.httpMethod = "POST"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(sdkKey)", forHTTPHeaderField: "Authorization")
        req.setValue(idempotencyKey, forHTTPHeaderField: "X-TraceItX-Idempotency-Key")
        if let companionAttribution = companionAttribution {
            // SECURITY: never log this value (and note the debug print below
            // deliberately prints only the URL + byte count, no headers).
            req.setValue(companionAttribution, forHTTPHeaderField: "X-TX-Companion-Attribution")
        }
        if let identityToken {
            // SECURITY: never log this value — same posture as
            // companionAttribution above.
            req.setValue(identityToken, forHTTPHeaderField: IDENTITY_TOKEN_HEADER)
        }

        #if DEBUG
        print("[TraceItX] POST \(ingestURL.absoluteString) bytes=\(body.count) boundary=\(boundary)")
        #endif

        do {
            let data: Data
            let response: URLResponse
            if let authorizeUpload {
                (data, response) = try await AuthorizedUpload.send(request: req, body: body,
                    session: urlSession, authorize: authorizeUpload)
            } else {
                (data, response) = try await urlSession.upload(for: req, from: body)
            }
            guard let http = response as? HTTPURLResponse else {
                #if DEBUG
                print("[TraceItX] non-HTTP response: \(response)")
                #endif
                throw MultipartUploaderError.nonHTTPResponse
            }
            #if DEBUG
            let bodyPreview = String(data: data.prefix(512), encoding: .utf8) ?? "<\(data.count) non-utf8 bytes>"
            print("[TraceItX] response status=\(http.statusCode) body=\(bodyPreview)")
            #endif
            return (http.statusCode, http.allHeaderFields)
        } catch {
            #if DEBUG
            let nsErr = error as NSError
            print("[TraceItX] transport error url=\(endpoint.absoluteString) domain=\(nsErr.domain) code=\(nsErr.code) desc=\(nsErr.localizedDescription)")
            #endif
            throw error
        }
    }

    /// Builds an RFC-7578 multipart body. Exposed for test introspection.
    public static func buildBody(parts: [Part], boundary: String) -> Data {
        var body = Data()
        for p in parts {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append(
                "Content-Disposition: form-data; name=\"\(p.name)\"; filename=\"\(p.filename)\"\r\n"
                    .data(using: .utf8)!
            )
            body.append("Content-Type: \(p.contentType)\r\n\r\n".data(using: .utf8)!)
            body.append(p.data)
            body.append("\r\n".data(using: .utf8)!)
        }
        body.append("--\(boundary)--\r\n".data(using: .utf8)!)
        return body
    }
}

/// Local error for the uploader. The orchestrating `ReportSubmitter` translates
/// these (alongside HTTP status codes from `RetryPolicy.classify`) into
/// `TraceItXTransportError` cases owned by 04-01.
public enum MultipartUploaderError: Error, Equatable {
    case nonHTTPResponse
}
