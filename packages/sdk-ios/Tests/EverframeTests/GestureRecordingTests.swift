// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
@testable import EverframeKit

/// Records every post it is asked for.
private final class FakeRecordingTransport: GestureRecordingTransport, @unchecked Sendable {
    struct Post: Equatable {
        let endpoint: URL
        let sdkKey: String
        let recordingId: String
        let token: String
        let events: [RecordedKey]
    }

    private let lock = NSLock()
    private var stored: [Post] = []
    let endpoint: URL
    let sdkKey: String
    let succeeds: Bool

    init(endpoint: URL, sdkKey: String, succeeds: Bool) {
        self.endpoint = endpoint
        self.sdkKey = sdkKey
        self.succeeds = succeeds
    }

    var posts: [Post] {
        lock.lock(); defer { lock.unlock() }
        return stored
    }

    private func record(_ post: Post) {
        lock.lock(); defer { lock.unlock() }
        stored.append(post)
    }

    func postRecording(recordingId: String, token: String, events: [RecordedKey]) async -> Bool {
        record(Post(endpoint: endpoint, sdkKey: sdkKey, recordingId: recordingId, token: token, events: events))
        return succeeds
    }
}

/// Holds `sleep` until the test releases it.
private actor RecordingSleepGate {
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var open = false
    private(set) var arrivals = 0

    func wait() async {
        arrivals += 1
        if open { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func release() {
        open = true
        waiters.forEach { $0.resume() }
        waiters = []
    }
}

@MainActor
final class GestureRecordingTests: XCTestCase {
    private let endpoint = URL(string: "https://ingest.example")!
    private var toasts: [String] = []
    private var uptime: TimeInterval = 100
    private var wall = Date(timeIntervalSince1970: 1_000_000)
    private var snapshot: (token: String, endpoint: URL, sdkKey: String)?
    private var transports: [FakeRecordingTransport] = []
    private var succeeds = true
    private var gate: RecordingSleepGate!
    private var slept: [TimeInterval] = []
    private var objects: [NSObject] = []
    private var foreground = true
    private var activations: [@MainActor () -> Void] = []
    private var removedObservers = 0

    override func setUp() async throws {
        foreground = true
        activations = []
        removedObservers = 0
        toasts = []
        uptime = 100
        wall = Date(timeIntervalSince1970: 1_000_000)
        snapshot = (fixtureToken, endpoint, "k")
        transports = []
        succeeds = true
        gate = RecordingSleepGate()
        slept = []
        objects = []
    }

    private func make() -> GestureRecording {
        let gate = self.gate!
        return GestureRecording(seams: GestureRecording.Seams(
            now: { [unowned self] in self.uptime },
            wallNow: { [unowned self] in self.wall },
            sleep: { [unowned self] seconds in
                self.slept.append(seconds)
                await gate.wait()
            },
            showToast: { [unowned self] in self.toasts.append($0) },
            snapshot: { [unowned self] in self.snapshot },
            transport: { [unowned self] endpoint, sdkKey in
                let transport = FakeRecordingTransport(endpoint: endpoint, sdkKey: sdkKey, succeeds: self.succeeds)
                self.transports.append(transport)
                return transport
            },
            isForegroundActive: { [unowned self] in self.foreground },
            observeActivation: { [unowned self] body in
                self.activations.append(body)
                return GestureRecording.Observation { [unowned self] in self.removedObservers += 1 }
            }))
    }

    private func request(_ id: String = "rec-1", expiresIn seconds: TimeInterval = 120) -> DeviceLinkRecordingRequest {
        DeviceLinkRecordingRequest(id: id, expiresAt: wall.addingTimeInterval(seconds))
    }

    private func press() -> ObjectIdentifier {
        let object = NSObject()
        objects.append(object)
        return ObjectIdentifier(object)
    }

    /// Lets the recording task reach its sleep, then releases it and lets it finish.
    private func finishWindow(_ recording: GestureRecording) async {
        while await gate.arrivals == 0 { await Task.yield() }
        await gate.release()
        for _ in 0..<50 { await Task.yield() }
        await recording.__awaitFinishForTesting()
    }

    func testRecordsForTenSecondsThenPosts() async {
        let recording = make()
        recording.onRequest(request(), isCurrent: { true })
        XCTAssertTrue(recording.isActive)
        let p = press()
        recording.feed(TvKeyEvent(key: "MEDIA_PLAY_PAUSE", phase: .down, press: p, at: 101))
        recording.feed(TvKeyEvent(key: "MEDIA_PLAY_PAUSE", phase: .up, press: p, at: 102.62))
        uptime = 110
        await finishWindow(recording)
        XCTAssertEqual(slept, [10])
        XCTAssertEqual(toasts, ["Recording remote keys for 10 seconds", "Keys sent to Everframe"])
        XCTAssertEqual(transports.count, 1)
        let post = transports.first?.posts.first
        XCTAssertEqual(post?.recordingId, "rec-1")
        XCTAssertTrue(post?.token == fixtureToken)
        XCTAssertEqual(post?.endpoint, endpoint)
        XCTAssertEqual(post?.sdkKey, "k")
        XCTAssertEqual(post?.events, [RecordedKey(key: "MEDIA_PLAY_PAUSE", downMs: 0, upMs: 1620)])
        XCTAssertFalse(recording.isActive)
    }

    func testIgnoresAHandledId() async {
        let recording = make()
        recording.onRequest(request(), isCurrent: { true })
        await finishWindow(recording)
        recording.onRequest(request(), isCurrent: { true })
        XCTAssertFalse(recording.isActive)
        XCTAssertEqual(transports.count, 1)
        XCTAssertEqual(toasts, ["Recording remote keys for 10 seconds", "Keys sent to Everframe"])
    }

    func testIgnoresAnExpiredRequest() {
        let recording = make()
        recording.onRequest(request(expiresIn: -1), isCurrent: { true })
        XCTAssertFalse(recording.isActive)
        XCTAssertEqual(toasts, [])
    }

    func testIgnoresARequestWhileOneIsActive() async {
        let recording = make()
        recording.onRequest(request("rec-1"), isCurrent: { true })
        recording.onRequest(request("rec-2"), isCurrent: { true })
        XCTAssertEqual(toasts, ["Recording remote keys for 10 seconds"])
        await finishWindow(recording)
        XCTAssertEqual(transports.flatMap(\.posts).map(\.recordingId), ["rec-1"])
    }

    func testIgnoresAnUnlinkedDevice() {
        snapshot = nil
        let recording = make()
        recording.onRequest(request(), isCurrent: { true })
        XCTAssertFalse(recording.isActive)
        XCTAssertEqual(toasts, [])
    }

    func testLinkChangedBeforeTheEndPostsNothing() async {
        let recording = make()
        recording.onRequest(request(), isCurrent: { true })
        snapshot = (otherToken, endpoint, "k")
        await finishWindow(recording)
        XCTAssertTrue(transports.isEmpty)
        XCTAssertEqual(toasts, ["Recording remote keys for 10 seconds"])
    }

    func testAReplacedSessionPostsNothing() async {
        let recording = make()
        recording.onRequest(request(), isCurrent: { false })
        await finishWindow(recording)
        XCTAssertTrue(transports.isEmpty)
    }

    func testUploadUsesTheInstallationThatStartedTheRecording() async {
        let recording = make()
        recording.onRequest(request(), isCurrent: { true })
        // Same token, but the live snapshot now names another origin: posting
        // would send this token to it.
        snapshot = (fixtureToken, URL(string: "https://other.example")!, "k2")
        await finishWindow(recording)
        XCTAssertTrue(transports.isEmpty)
    }

    func testFailedPostShowsNoSentToast() async {
        succeeds = false
        let recording = make()
        recording.onRequest(request(), isCurrent: { true })
        await finishWindow(recording)
        XCTAssertEqual(transports.count, 1)
        XCTAssertEqual(toasts, ["Recording remote keys for 10 seconds"])
    }

    /// A request that arrives while the app is in the background waits for a
    /// foreground-active scene: the prompt must be seen, and the 10 s window
    /// starts only then. It is not marked handled meanwhile.
    func testDefersUntilAForegroundSceneThenStarts() async {
        foreground = false
        let recording = make()
        recording.onRequest(request(), isCurrent: { true })
        XCTAssertFalse(recording.isActive)
        XCTAssertEqual(toasts, [])
        XCTAssertEqual(slept, [])
        XCTAssertEqual(activations.count, 1)
        // A second request while waiting replaces the first; one observer.
        recording.onRequest(request("rec-2"), isCurrent: { true })
        XCTAssertEqual(activations.count, 1)
        foreground = true
        activations[0]()
        XCTAssertTrue(recording.isActive)
        XCTAssertEqual(toasts, ["Recording remote keys for 10 seconds"])
        XCTAssertEqual(removedObservers, 1)
        await finishWindow(recording)
        XCTAssertEqual(transports.flatMap(\.posts).map(\.recordingId), ["rec-2"])
        XCTAssertEqual(toasts, ["Recording remote keys for 10 seconds", "Keys sent to Everframe"])
    }

    func testADeferredRequestThatExpiresNeverStarts() {
        foreground = false
        let recording = make()
        recording.onRequest(request(expiresIn: 30), isCurrent: { true })
        wall = wall.addingTimeInterval(60)
        foreground = true
        activations.first?()
        XCTAssertFalse(recording.isActive)
        XCTAssertEqual(toasts, [])
    }

    func testTeardownDropsADeferredRequest() {
        foreground = false
        let recording = make()
        recording.onRequest(request(), isCurrent: { true })
        recording.teardown()
        XCTAssertEqual(removedObservers, 1)
        foreground = true
        activations.first?()
        XCTAssertFalse(recording.isActive)
        XCTAssertEqual(toasts, [])
    }

    func testTeardownDropsTheRecording() async {
        let recording = make()
        recording.onRequest(request(), isCurrent: { true })
        recording.teardown()
        XCTAssertFalse(recording.isActive)
        await finishWindow(recording)
        XCTAssertTrue(transports.isEmpty)
        XCTAssertEqual(toasts, ["Recording remote keys for 10 seconds"])
    }
}
