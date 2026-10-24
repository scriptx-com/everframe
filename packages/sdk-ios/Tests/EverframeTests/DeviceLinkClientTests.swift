// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
@testable import EverframeKit

/// Answers each request with the next scripted outcome and records it.
private final class ScriptedFetcher: URLSessionFetching, @unchecked Sendable {
    enum Outcome {
        case status(Int, String)
        case error(Error)
    }

    private let lock = NSLock()
    private var outcomes: [Outcome]
    private var requests: [URLRequest] = []

    init(_ outcomes: [Outcome]) { self.outcomes = outcomes }

    var recorded: [URLRequest] {
        lock.lock(); defer { lock.unlock() }
        return requests
    }

    private func next(_ request: URLRequest) -> Outcome {
        lock.lock(); defer { lock.unlock() }
        requests.append(request)
        return outcomes.isEmpty ? .status(500, "") : outcomes.removeFirst()
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        switch next(request) {
        case let .status(code, body):
            let response = HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: "HTTP/1.1", headerFields: nil)!
            return (Data(body.utf8), response)
        case let .error(error):
            throw error
        }
    }
}

final class DeviceLinkClientTests: XCTestCase {
    private let base = URL(string: "https://h.example")!
    private let device = DeviceLinkHelloRequest.Device(
        model: "iPhone16,1", os: "iOS", osVersion: "18.2", appVersion: "1.0.0", sdk: "ios/1.6.0", formFactor: "phone")

    private func client(_ fetcher: ScriptedFetcher) -> DeviceLinkClient {
        DeviceLinkClient(baseURL: base, sdkKey: "k", fetcher: fetcher)
    }

    private func bodyObject(_ request: URLRequest?) -> [String: Any]? {
        guard let data = request?.httpBody else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    func testURLsDeriveFromBase() {
        XCTAssertEqual(DeviceLinkClient.url(base: URL(string: "https://h.example")!, path: "hello").absoluteString,
                       "https://h.example/api/device-link/hello")
        XCTAssertEqual(DeviceLinkClient.url(base: URL(string: "https://h.example/prefix/")!, path: "hello").absoluteString,
                       "https://h.example/prefix/api/device-link/hello")
        XCTAssertEqual(DeviceLinkClient.url(base: URL(string: "https://h.example/api/ingest")!, path: "hello").absoluteString,
                       "https://h.example/api/device-link/hello")
        XCTAssertEqual(DeviceLinkClient.url(base: URL(string: "https://h.example/x/api/config")!, path: "hello").absoluteString,
                       "https://h.example/x/api/device-link/hello")
        XCTAssertEqual(DeviceLinkClient.url(base: URL(string: "http://127.0.0.1:8787")!, path: "hello").absoluteString,
                       "http://127.0.0.1:8787/api/device-link/hello")
    }

    func testHelloSendsKeyAndBody() async {
        let fetcher = ScriptedFetcher([.status(200, #"{"status":"none"}"#)])
        let nonce = DeviceLinkNonce.make()
        _ = await client(fetcher).hello(nonce: nonce, device: device)
        let request = fetcher.recorded.first
        XCTAssertEqual(request?.httpMethod, "POST")
        XCTAssertEqual(request?.url?.absoluteString, "https://h.example/api/device-link/hello")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "Authorization"), "Bearer k")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "Accept"), "application/json")
        XCTAssertNil(request?.value(forHTTPHeaderField: "X-Everframe-Capture-Token"))
        XCTAssertNil(request?.url?.query)
        XCTAssertEqual(request?.timeoutInterval, 10)
        let body = bodyObject(request)
        XCTAssertTrue(body?["attemptNonce"] as? String == nonce)
        XCTAssertEqual((body?["device"] as? [String: Any])?["formFactor"] as? String, "phone")
        XCTAssertEqual((body?["device"] as? [String: Any])?["sdk"] as? String, "ios/1.6.0")
    }

    func testHelloStatusMapping() async {
        let id = UUID()
        let cases: [(ScriptedFetcher.Outcome, DeviceLinkHelloResult)] = [
            (.status(200, #"{"status":"none"}"#), .reply(.none)),
            (.status(200, #"{"status":"pending","attemptId":"\#(id)","number":47}"#), .reply(.pending(attemptId: id, number: 47))),
            (.status(429, ""), .rateLimited),
            (.status(500, ""), .failed),
            (.status(404, ""), .failed),
            (.status(302, ""), .failed),
            (.status(200, "x"), .failed),
            (.status(200, #"{"status":"pending","attemptId":"../x","number":47}"#), .failed),
            (.error(URLError(.notConnectedToInternet)), .failed),
        ]
        for (index, (outcome, expected)) in cases.enumerated() {
            let result = await client(ScriptedFetcher([outcome])).hello(nonce: DeviceLinkNonce.make(), device: device)
            XCTAssertEqual(result, expected, "case \(index)")
        }
    }

    func testCheckSendsNonceInBodyAndLowercasedIdInPath() async {
        let id = UUID()
        let fetcher = ScriptedFetcher([.status(200, #"{"status":"pending"}"#)])
        let nonce = DeviceLinkNonce.make()
        let result = await client(fetcher).check(attemptId: id, nonce: nonce)
        XCTAssertEqual(result, .reply(.pending))
        let request = fetcher.recorded.first
        XCTAssertEqual(request?.httpMethod, "POST")
        XCTAssertEqual(request?.url?.path, "/api/device-link/attempts/\(id.uuidString.lowercased())/check")
        XCTAssertNil(request?.url?.query)
        XCTAssertEqual(request?.value(forHTTPHeaderField: "Authorization"), "Bearer k")
        XCTAssertNil(request?.value(forHTTPHeaderField: "X-Everframe-Capture-Token"))
        let body = bodyObject(request)
        XCTAssertEqual(body.map { Set($0.keys) }, ["attemptNonce"])
        XCTAssertTrue(body?["attemptNonce"] as? String == nonce)
    }

    func testCheckStatusMapping() async {
        let cases: [(ScriptedFetcher.Outcome, DeviceLinkCheckResult)] = [
            (.status(200, #"{"status":"linked","token":"\#(fixtureToken)","owner":{"kind":"team"}}"#),
             .reply(.linked(token: fixtureToken, owner: .team))),
            (.status(200, #"{"status":"expired"}"#), .reply(.expired)),
            (.status(200, "x"), .stop),
            (.status(200, #"{"status":"linked","token":"evf_cap_x","owner":{"kind":"team"}}"#), .stop),
            (.status(429, ""), .retry),
            (.status(503, ""), .retry),
            (.status(500, ""), .retry),
            (.error(URLError(.timedOut)), .retry),
            (.error(URLError(.notConnectedToInternet)), .retry),
            (.status(404, ""), .stop),
            (.status(401, ""), .stop),
            (.status(302, ""), .stop),
        ]
        for (index, (outcome, expected)) in cases.enumerated() {
            let result = await client(ScriptedFetcher([outcome])).check(attemptId: UUID(), nonce: DeviceLinkNonce.make())
            XCTAssertTrue(result == expected, "case \(index)")
        }
    }

    func testPostRecordingSendsKeyTokenAndBody() async throws {
        let fetcher = ScriptedFetcher([.status(204, "")])
        let events = [RecordedKey(key: "MEDIA_PLAY_PAUSE", downMs: 0, upMs: 1620),
                      RecordedKey(key: "DPAD_UP", downMs: 2000, upMs: 2080)]
        let ok = await client(fetcher).postRecording(recordingId: "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b",
                                                     token: fixtureToken, events: events)
        XCTAssertTrue(ok)
        let request = try XCTUnwrap(fetcher.recorded.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString,
                       "https://h.example/api/device-link/recordings/6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b")
        XCTAssertNil(request.url?.query)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer k")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        // Compared, never printed.
        XCTAssertTrue(request.value(forHTTPHeaderField: "X-Everframe-Capture-Token") == fixtureToken)
        let body = try XCTUnwrap(bodyObject(request))
        XCTAssertEqual(Set(body.keys), ["events"])
        let sent = try XCTUnwrap(body["events"] as? [[String: Any]])
        XCTAssertEqual(sent.count, 2)
        XCTAssertEqual(sent[0]["key"] as? String, "MEDIA_PLAY_PAUSE")
        XCTAssertEqual(sent[0]["downMs"] as? Int, 0)
        XCTAssertEqual(sent[0]["upMs"] as? Int, 1620)
        XCTAssertEqual(Set(sent[1].keys), ["key", "downMs", "upMs"])
    }

    func testPostRecordingIsTrueOnlyOn204() async {
        let outcomes: [ScriptedFetcher.Outcome] = [
            .status(200, ""), .status(404, ""), .status(302, ""), .status(500, ""), .error(URLError(.timedOut)),
        ]
        for (index, outcome) in outcomes.enumerated() {
            let ok = await client(ScriptedFetcher([outcome])).postRecording(recordingId: "abc", token: fixtureToken, events: [])
            XCTAssertFalse(ok, "case \(index)")
        }
        // An id outside the contract never reaches the network.
        let fetcher = ScriptedFetcher([.status(204, "")])
        let bad = await client(fetcher).postRecording(recordingId: "a/b", token: fixtureToken, events: [])
        XCTAssertFalse(bad)
        XCTAssertTrue(fetcher.recorded.isEmpty)
    }

    func testNoRedirectSessionRefusesRedirects() {
        let delegate = DeviceLinkNoRedirectDelegate()
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let task = session.dataTask(with: URL(string: "https://h.example/api/device-link/hello")!)
        let response = HTTPURLResponse(url: URL(string: "https://h.example/api/device-link/hello")!, statusCode: 302,
                                       httpVersion: "HTTP/1.1", headerFields: ["Location": "https://h.example/other"])!
        var received: URLRequest? = URLRequest(url: URL(string: "https://sentinel.example")!)
        var called = false
        delegate.urlSession(session, task: task, willPerformHTTPRedirection: response,
                            newRequest: URLRequest(url: URL(string: "https://h.example/other")!)) { request in
            called = true
            received = request
        }
        XCTAssertTrue(called)
        XCTAssertNil(received)
        XCTAssertTrue(DeviceLinkClient.noRedirectSession.delegate is DeviceLinkNoRedirectDelegate)
    }
}
