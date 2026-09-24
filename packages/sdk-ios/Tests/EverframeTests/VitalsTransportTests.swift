// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
@testable import EverframeKit

/// Scripted URLProtocol: pops one outcome per request, records the request.
///
/// Codex round-5, W5-M8 — every piece of mutable state here is behind ONE lock. `startLoading`
/// runs on URLSession's own thread while the test thread reads `requests` and asserts on it, a
/// delayed response mutates `completions` from a global queue, and `stopLoading` writes the
/// stopped flag from a third: serial XCTest execution serialises the TEST BODIES, not these
/// callbacks, so the stub itself had undefined concurrent accesses under every assertion it
/// supports. Reads answer SNAPSHOTS, and the two callbacks the stub owns (`onRequest`,
/// `onCompletion`) are copied out and invoked with the lock released — one of them re-enters the
/// transport, and none of them may run under a lock the assertions also take.
final class VitalsStubProtocol: URLProtocol {
    enum Outcome { case status(Int, headers: [String: String] = [:]); case networkError }
    private struct State {
        var outcomes: [Outcome] = []
        var requests: [(URLRequest, Data)] = []
        var onRequest: (() -> Void)?
        /// Round-1, #9: a response delivered LATER, so a test can decide the request's fate
        /// while it is still on the wire.
        var responseDelay: TimeInterval = 0
        /// The responses that actually reached the client — a cancelled request stops before
        /// delivering one. (`stopLoading` is NOT a cancellation signal: URLSession calls it on
        /// normal completion too.)
        var completions = 0
        /// Fired after each completion, so a test can WAIT for one instead of sleeping past it.
        var onCompletion: (() -> Void)?
    }
    private static let state = Locked(State())

    static func reset() { state.mutate { $0 = State() } }
    static var requests: [(URLRequest, Data)] { state.value.requests }
    static var completions: Int { state.value.completions }
    static var outcomes: [Outcome] {
        get { state.value.outcomes }
        set { state.mutate { $0.outcomes = newValue } }
    }
    static var onRequest: (() -> Void)? {
        get { state.value.onRequest }
        set { state.mutate { $0.onRequest = newValue } }
    }
    static var onCompletion: (() -> Void)? {
        get { state.value.onCompletion }
        set { state.mutate { $0.onCompletion = newValue } }
    }
    static var responseDelay: TimeInterval {
        get { state.value.responseDelay }
        set { state.mutate { $0.responseDelay = newValue } }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var body = Data()
        if let s = request.httpBodyStream { s.open(); defer { s.close() }; var buf = [UInt8](repeating: 0, count: 65536)
            while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; body.append(buf, count: n) } }
        else if let d = request.httpBody { body = d }
        var outcome = Outcome.status(200)
        var announce: (() -> Void)?
        var delay: TimeInterval = 0
        Self.state.mutate {
            $0.requests.append((request, body))
            if !$0.outcomes.isEmpty { outcome = $0.outcomes.removeFirst() }
            announce = $0.onRequest
            delay = $0.responseDelay
        }
        announce?()
        let deliver = { [weak self] in
            guard let self, !self.stopped.value else { return }
            switch outcome {
            case let .status(code, headers):
                let r = HTTPURLResponse(url: self.request.url!, statusCode: code, httpVersion: "HTTP/1.1", headerFields: headers)!
                self.client?.urlProtocol(self, didReceive: r, cacheStoragePolicy: .notAllowed)
                self.client?.urlProtocol(self, didLoad: Data())
                self.client?.urlProtocolDidFinishLoading(self)
            case .networkError:
                self.client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            }
            var done: (() -> Void)?
            Self.state.mutate { $0.completions += 1; done = $0.onCompletion }
            done?()
        }
        if delay > 0 { DispatchQueue.global().asyncAfter(deadline: .now() + delay, execute: deliver) } else { deliver() }
    }
    private let stopped = Locked(false)
    override func stopLoading() { stopped.mutate { $0 = true } }
}

/// Closes the transport the first time the send path reads the kill predicate — the last thing
/// `attempt` does before creating its task — and always answers "not killed", so the send runs
/// on into the close/registration window W5-I2 describes.
///
/// Codex round-6, W6-M9 — both fields are guarded, and the close runs OUTSIDE that guard. The
/// predicate is read from the transport's send path on whichever thread got there (URLSession's,
/// today only one of them), and an `@unchecked Sendable` stub with unsynchronised state is the
/// defect wave 5's M8 removed from this very suite: benign while one send exercises it, a data
/// race the moment a second does, and invisible either way. Releasing the lock before `close()`
/// also keeps this stub a leaf: it never holds its own lock across a call into the transport.
final class CloseOnFirstKillCheck: @unchecked Sendable {
    private let lock = NSLock()
    private weak var _transport: VitalsTransport?
    private var fired = false
    var transport: VitalsTransport? {
        get { lock.lock(); defer { lock.unlock() }; return _transport }
        set { lock.lock(); _transport = newValue; lock.unlock() }
    }
    func closeAndAnswerNotKilled() -> Bool {
        lock.lock()
        let first = !fired
        fired = true
        let t = _transport
        lock.unlock()
        if first { t?.close() }
        return false
    }
}

final class VitalsTransportTests: XCTestCase {
    private var session: URLSession!
    private var killed = false
    private let endpoint = URL(string: "https://ingest.example.test/api/ingest/vitals")!

    override func setUp() {
        super.setUp()
        VitalsStubProtocol.reset(); killed = false
        let cfg = URLSessionConfiguration.ephemeral; cfg.protocolClasses = [VitalsStubProtocol.self]
        session = URLSession(configuration: cfg)
    }
    private func transport(retryDelayMs: Int64 = 20, maxRetryAfterMs: Int64 = 60_000) -> VitalsTransport {
        VitalsTransport(session: session, endpoint: endpoint, apiKey: "txx_live_k", isKilled: { [self] in killed },
                        queue: VitalsQueue.shared, retryDelayMs: retryDelayMs, maxRetryAfterMs: maxRetryAfterMs)
    }
    private func waitForRequests(_ n: Int, timeout: TimeInterval = 3) {
        let deadline = Date().addingTimeInterval(timeout)
        while VitalsStubProtocol.requests.count < n && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }
    }
    private func settle(_ seconds: TimeInterval = 0.3) { RunLoop.current.run(until: Date().addingTimeInterval(seconds)) }

    func testPostsJSONWithBearerAuth() {
        transport().send(Data(#"{"payload":{}}"#.utf8))
        waitForRequests(1)
        let (req, body) = VitalsStubProtocol.requests[0]
        XCTAssertEqual(req.httpMethod, "POST"); XCTAssertEqual(req.url, endpoint)
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer txx_live_k")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(String(decoding: body, as: UTF8.self), #"{"payload":{}}"#)
    }
    func testRetriesOnceAfterTheDelayOn5xxThenGivesUp() {
        VitalsStubProtocol.outcomes = [.status(503), .status(503), .status(503)]
        transport().send(Data("x".utf8))
        waitForRequests(2); settle()
        XCTAssertEqual(VitalsStubProtocol.requests.count, 2)
    }
    func test429HonoursRetryAfterCappedAt60s() {
        // Retry-After: 0 → immediate retry; a huge value is capped (asserted through the cap seam)
        VitalsStubProtocol.outcomes = [.status(429, headers: ["Retry-After": "0"]), .status(200)]
        transport(retryDelayMs: 5_000).send(Data("x".utf8))
        waitForRequests(2, timeout: 2)
        XCTAssertEqual(VitalsStubProtocol.requests.count, 2)
        XCTAssertEqual(VitalsTransport.retryAfterMs(header: "999999", fallbackMs: 5_000, maxMs: 60_000), 60_000)
        XCTAssertEqual(VitalsTransport.retryAfterMs(header: "junk", fallbackMs: 5_000, maxMs: 60_000), 5_000)
        XCTAssertEqual(VitalsTransport.retryAfterMs(header: "-3", fallbackMs: 5_000, maxMs: 60_000), 5_000)
        XCTAssertEqual(VitalsTransport.retryAfterMs(header: "7", fallbackMs: 5_000, maxMs: 60_000), 7_000)
    }
    func testNoRetryOnOther4xx() {
        VitalsStubProtocol.outcomes = [.status(400)]
        transport().send(Data("x".utf8))
        waitForRequests(1); settle()
        XCTAssertEqual(VitalsStubProtocol.requests.count, 1)
    }
    func testRetriesOnNetworkError() {
        VitalsStubProtocol.outcomes = [.networkError, .status(200)]
        transport().send(Data("x".utf8))
        waitForRequests(2)
        XCTAssertEqual(VitalsStubProtocol.requests.count, 2)
    }
    func testKilledClientSendsNothingIncludingTheRetry() {
        killed = true
        transport().send(Data("x".utf8)); settle()
        XCTAssertEqual(VitalsStubProtocol.requests.count, 0)
        killed = false
        VitalsStubProtocol.outcomes = [.status(503)]
        let t = transport(retryDelayMs: 100)
        VitalsStubProtocol.onRequest = { [self] in killed = true }   // kill lands inside the retry window
        t.send(Data("x".utf8))
        waitForRequests(1); settle(0.5)
        XCTAssertEqual(VitalsStubProtocol.requests.count, 1)
    }
    func testCloseCancelsTheScheduledRetryAndSilencesEveryLaterSend() {
        VitalsStubProtocol.outcomes = [.status(503)]
        let t = transport(retryDelayMs: 200)
        t.send(Data("x".utf8)); waitForRequests(1)
        t.close(); settle(0.5)
        XCTAssertEqual(VitalsStubProtocol.requests.count, 1)
        t.send(Data("y".utf8)); settle()
        XCTAssertEqual(VitalsStubProtocol.requests.count, 1)
    }
    func testCloseIsIdempotent() {
        let t = transport(); t.close(); t.close()
    }

    /// Codex round-1, #9 — a server disable calls `stop()` on the collector, which POSTs the
    /// trailing chunk and the final summary, and then closed the sink. `close()` cancels every
    /// in-flight task, so with any ordinary connection delay neither request ever landed: the
    /// last chunk and the final summary of every server-disabled session were lost. `finish`
    /// lets them complete; `kill()` still cancels immediately, which is the half below.
    func testFinishLetsTheFinalRequestLandWhileCloseStillCancelsIt() {
        VitalsStubProtocol.responseDelay = 0.3
        // The POSITIVE half waits for the completion rather than sleeping past it (W5-M8).
        let landed = expectation(description: "the in-flight request completes")
        VitalsStubProtocol.onCompletion = { landed.fulfill() }
        let t = transport()
        t.send(Data("final-summary".utf8))
        waitForRequests(1)
        t.finish(timeoutMs: 5_000)
        wait(for: [landed], timeout: 3)
        XCTAssertEqual(VitalsStubProtocol.completions, 1, "a graceful finish must let the request already on the wire complete")

        // The NEGATIVE half is an absence, which no expectation can observe: it has to be a
        // quiet window longer than the response delay.
        VitalsStubProtocol.reset(); VitalsStubProtocol.responseDelay = 0.3
        let k = transport()
        k.send(Data("final-summary".utf8))
        waitForRequests(1)
        k.close()
        settle(0.8)
        XCTAssertEqual(VitalsStubProtocol.completions, 0, "kill() still cancels the in-flight task immediately")
    }
    /// Codex round-2, #2 — the retry work item closed over the mutable `item` variable, whose
    /// heap capture box holds the work item strongly (`item → block → box → item`), and
    /// `DispatchWorkItem` retains its block however it ends. Removing it from `scheduled` broke
    /// only the transport's own edge, so every network error and every 503 permanently leaked
    /// the item, the request body and the strongly captured transport. Keying `scheduled` by a
    /// UUID and capturing that value instead is what makes both halves below reclaim.
    func testAScheduledRetryDoesNotOutliveTheTransportOnceItFiresOrIsCancelled() {
        weak var afterRetry: VitalsTransport?
        VitalsStubProtocol.outcomes = [.status(503), .status(200)]
        autoreleasepool {
            let t = transport(retryDelayMs: 30)
            afterRetry = t
            t.send(Data("x".utf8))
            waitForRequests(2)
            settle(0.3)
        }
        settle(0.3)
        XCTAssertNil(afterRetry, "a retry that has fired must leave nothing holding the transport")

        VitalsStubProtocol.reset()
        weak var afterCancel: VitalsTransport?
        VitalsStubProtocol.outcomes = [.status(503)]
        autoreleasepool {
            let t = transport(retryDelayMs: 200)
            afterCancel = t
            t.send(Data("x".utf8))
            waitForRequests(1)
            settle(0.1)
            t.close()
        }
        settle(0.5)
        XCTAssertNil(afterCancel, "and neither must a retry close() cancelled")
    }
    /// Codex round-5, W5-I2 — a `close()` landing between the task's CREATION and its
    /// registration in `inFlight`. The branch used to return without cancelling, and the task
    /// belongs to a process-lifetime session: it never entered `inFlight`, so the `close()` that
    /// just ran could not reclaim it and no later one ever could. It sat `.suspended` for the
    /// life of the process, holding its completion handler — and through it the transport and
    /// the request body.
    ///
    /// The kill predicate is the last customer-supplied callback `attempt` reads before creating
    /// its task, so closing from inside it puts the close exactly in that window, with no test
    /// scaffolding in the transport itself.
    func testACloseRacingTaskCreationCancelsTheTaskItWouldOtherwiseAbandon() {
        let box = CloseOnFirstKillCheck()
        weak var reclaimed: VitalsTransport?
        autoreleasepool {
            let t = VitalsTransport(session: session, endpoint: endpoint, apiKey: "txx_live_k",
                                    isKilled: { box.closeAndAnswerNotKilled() }, queue: VitalsQueue.shared,
                                    retryDelayMs: 20, maxRetryAfterMs: 60_000)
            box.transport = t
            reclaimed = t
            t.send(Data("x".utf8))
            settle(0.2)
        }
        settle(0.3)
        XCTAssertEqual(VitalsStubProtocol.requests.count, 0, "a task closed before registration is never resumed")
        // Cancelling is what runs the completion handler (with `.cancelled`) and so releases the
        // transport and the request body it captured. Without the cancel the task never
        // completes, and nothing else can reach it: this assertion is the leak.
        XCTAssertNil(reclaimed, "nothing may keep holding the transport through an abandoned task's completion handler")
    }
    func testFinishSuppressesRetriesAndLaterSendsAndStillClosesAfterItsTimeout() {
        VitalsStubProtocol.outcomes = [.status(503)]
        let t = transport(retryDelayMs: 100)
        let finishStarted = expectation(description: "finish seals the transport before the 503 is delivered")
        VitalsStubProtocol.onRequest = { [weak t] in
            t?.finish(timeoutMs: 50)
            finishStarted.fulfill()
        }
        t.send(Data("x".utf8))
        wait(for: [finishStarted], timeout: 3)
        settle(0.5)
        XCTAssertEqual(VitalsStubProtocol.requests.count, 1, "the 5xx retry is suppressed, not awaited")
        t.send(Data("y".utf8)); settle(0.2)
        XCTAssertEqual(VitalsStubProtocol.requests.count, 1, "and no later send is accepted")
    }
}
