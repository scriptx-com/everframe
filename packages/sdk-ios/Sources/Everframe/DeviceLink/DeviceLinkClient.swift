// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The device-link endpoints, authenticated with the SDK key:
//   POST /api/device-link/hello
//   POST /api/device-link/attempts/:attemptId/check
//
// Requests never follow a redirect: their bodies carry the attempt nonce. They
// carry no device token and no query string.
//
// SECURITY: never log a request, a response or a body.
import Foundation

protocol DeviceLinkTransport: Sendable {
    func hello(nonce: String, device: DeviceLinkHelloRequest.Device) async -> DeviceLinkHelloResult
    func check(attemptId: UUID, nonce: String) async -> DeviceLinkCheckResult
}

enum DeviceLinkHelloResult: Equatable, Sendable {
    case reply(DeviceLinkHelloReply)
    /// `429`: stop, and stay quiet for a while.
    case rateLimited
    /// Any other status, a malformed reply or a transport error: stop.
    case failed
}

enum DeviceLinkCheckResult: Equatable, Sendable {
    case reply(DeviceLinkCheckReply)
    /// A transient failure (`429`, `5xx`, a transport error): check again.
    case retry
    /// A malformed reply or a terminal status: end the attempt.
    case stop
}

/// Refuses every redirect. The redirect response becomes the task's result.
final class DeviceLinkNoRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

struct DeviceLinkClient: DeviceLinkTransport {
    static let timeout: TimeInterval = 10

    /// Process-lifetime session: ephemeral, never captured by the SDK's own
    /// network capture, and never following a redirect.
    static let noRedirectSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = (configuration.protocolClasses ?? []).filter {
            !NSStringFromClass($0).contains("EFNetworkCaptureProtocol")
        }
        return URLSession(configuration: configuration, delegate: DeviceLinkNoRedirectDelegate(), delegateQueue: nil)
    }()

    let baseURL: URL
    let sdkKey: String
    let fetcher: URLSessionFetching

    init(baseURL: URL, sdkKey: String, fetcher: URLSessionFetching = DeviceLinkClient.noRedirectSession) {
        self.baseURL = baseURL
        self.sdkKey = sdkKey
        self.fetcher = fetcher
    }

    /// `<base>/api/device-link/<path>`. A base already ending in `api/ingest`
    /// or `api/config` has that suffix trimmed first.
    static func url(base: URL, path: String) -> URL {
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        var basePath = (components?.path ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        for suffix in ["api/ingest", "api/config"] where basePath == suffix || basePath.hasSuffix("/" + suffix) {
            basePath = String(basePath.dropLast(suffix.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        }
        let tail = "api/device-link/\(path)"
        components?.path = "/" + (basePath.isEmpty ? tail : "\(basePath)/\(tail)")
        components?.query = nil
        components?.fragment = nil
        return components?.url ?? base.appendingPathComponent(tail)
    }

    func hello(nonce: String, device: DeviceLinkHelloRequest.Device) async -> DeviceLinkHelloResult {
        guard let body = try? JSONEncoder().encode(DeviceLinkHelloRequest(attemptNonce: nonce, device: device)) else {
            return .failed
        }
        guard let (status, data) = await post(path: "hello", body: body) else { return .failed }
        if status == 429 { return .rateLimited }
        guard status == 200, let reply = DeviceLinkHelloReply.decode(data) else { return .failed }
        return .reply(reply)
    }

    func check(attemptId: UUID, nonce: String) async -> DeviceLinkCheckResult {
        guard let body = try? JSONSerialization.data(withJSONObject: ["attemptNonce": nonce]) else { return .stop }
        guard let (status, data) = await post(path: "attempts/\(attemptId.uuidString.lowercased())/check", body: body) else {
            return .retry
        }
        switch status {
        case 200: return DeviceLinkCheckReply.decode(data).map(DeviceLinkCheckResult.reply) ?? .stop
        case 429, 500...599: return .retry
        default: return .stop
        }
    }

    /// The status and body, or nil on a transport error or a non-HTTP response.
    private func post(path: String, body: Data) async -> (Int, Data)? {
        var request = URLRequest(url: Self.url(base: baseURL, path: path))
        request.httpMethod = "POST"
        request.timeoutInterval = Self.timeout
        request.setValue("Bearer \(sdkKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = body
        guard let (data, response) = try? await fetcher.data(for: request),
              let http = response as? HTTPURLResponse else { return nil }
        return (http.statusCode, data)
    }
}
