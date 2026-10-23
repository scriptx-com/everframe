// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
@testable import EverframeKit

/// Serves scripted hello and check results in order and records each call.
/// A check can be parked on `checkGate` until the test releases it.
private final class ScriptedTransport: DeviceLinkTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var helloResults: [DeviceLinkHelloResult]
    private var checkResults: [DeviceLinkCheckResult]
    private var helloNonces: [String] = []
    private var checkCalls: [(UUID, String)] = []
    var checkGate: CoordinatorTestGate?

    init(hello: [DeviceLinkHelloResult] = [], checks: [DeviceLinkCheckResult] = []) {
        helloResults = hello
        checkResults = checks
    }

    var hellos: Int { lock.lock(); defer { lock.unlock() }; return helloNonces.count }
    var helloNonceList: [String] { lock.lock(); defer { lock.unlock() }; return helloNonces }
    var checks: [(UUID, String)] { lock.lock(); defer { lock.unlock() }; return checkCalls }

    func hello(nonce: String, device: DeviceLinkHelloRequest.Device) async -> DeviceLinkHelloResult {
        nextHello(nonce: nonce)
    }

    func check(attemptId: UUID, nonce: String) async -> DeviceLinkCheckResult {
        if let gate = recordCheck(attemptId: attemptId, nonce: nonce) { await gate.wait() }
        return nextCheck()
    }

    private func nextHello(nonce: String) -> DeviceLinkHelloResult {
        lock.lock(); defer { lock.unlock() }
        helloNonces.append(nonce)
        return helloResults.isEmpty ? .failed : helloResults.removeFirst()
    }

    private func recordCheck(attemptId: UUID, nonce: String) -> CoordinatorTestGate? {
        lock.lock(); defer { lock.unlock() }
        checkCalls.append((attemptId, nonce))
        return checkGate
    }

    /// The last result repeats once the script runs out.
    private func nextCheck() -> DeviceLinkCheckResult {
        lock.lock(); defer { lock.unlock() }
        if checkResults.count > 1 { return checkResults.removeFirst() }
        return checkResults.first ?? .stop
    }
}

actor CoordinatorTestGate {
    private var open = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
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

private final class FakeClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: TimeInterval = 0
    private var slept: [TimeInterval] = []
    var now: TimeInterval {
        get { lock.lock(); defer { lock.unlock() }; return value }
        set { lock.lock(); value = newValue; lock.unlock() }
    }
    var sleeps: [TimeInterval] { lock.lock(); defer { lock.unlock() }; return slept }
    func sleep(_ seconds: TimeInterval) {
        lock.lock(); value += seconds; slept.append(seconds); lock.unlock()
    }
}

@MainActor
final class DeviceLinkCoordinatorTests: XCTestCase {
    private let ingest = URL(string: "https://ingest.example")!
    private var secure: InMemoryDeviceLinkSecureStore!
    private var store: DeviceLinkStore!
    private var clock: FakeClock!
    private var banners: [Int] = []
    private var hides = 0
    private var toasts: [String] = []
    private var linkChanges: [Bool] = []

    override func setUp() async throws {
        secure = InMemoryDeviceLinkSecureStore()
        store = DeviceLinkStore(secure: secure)
        clock = FakeClock()
        banners = []
        hides = 0
        toasts = []
        linkChanges = []
    }

    private func makeCoordinator() -> DeviceLinkCoordinator {
        let clock = self.clock!
        let seams = DeviceLinkCoordinator.Seams(
            showBanner: { [unowned self] in self.banners.append($0) },
            hideBanner: { [unowned self] in self.hides += 1 },
            showToast: { [unowned self] in self.toasts.append($0) },
            sleep: { clock.sleep($0) },
            now: { clock.now },
            deviceInfo: { .init(model: "iPhone16,1", os: "iOS", osVersion: "18.2", appVersion: "1.0.0",
                                sdk: "ios/test", formFactor: "phone") },
            makeNonce: { DeviceLinkNonce.make() },
            linkChanged: { [unowned self] linked, _ in self.linkChanges.append(linked) })
        return DeviceLinkCoordinator(store: store, seams: seams)
    }

    /// A coordinator in a `.device` session whose config has linking on.
    private func makeEnabled(_ transport: ScriptedTransport, hostMode: QuickCaptureHostMode = .device,
                             remote: DeviceLinkingConfigWire? = .init(enabled: true)) -> DeviceLinkCoordinator {
        let c = makeCoordinator()
        c.beginSession(endpoint: ingest, sdkKey: "k", hostMode: hostMode, transport: transport)
        c.publish(remote: remote)
        return c
    }

    private func storedToken() -> String? { store.link(endpoint: ingest, sdkKey: "k")?.token }

    func testHelloOnlyWhenLinkingEnabledOnDevice() async {
        let cases: [(QuickCaptureHostMode, DeviceLinkingConfigWire?, Bool)] = [
            (.device, nil, false), (.device, .init(enabled: false), false),
            (.simulator, .init(enabled: true), false), (.unsupported, .init(enabled: true), false),
            (.device, .init(enabled: true), true),
        ]
        for (index, (mode, remote, linked)) in cases.enumerated() {
            let transport = ScriptedTransport(hello: [.reply(.none)])
            if linked { store.save(DeviceLink(token: fixtureToken, owner: .team), endpoint: ingest, sdkKey: "k") }
            let c = makeEnabled(transport, hostMode: mode, remote: remote)
            XCTAssertNil(c.sendHelloIfIdle(), "case \(index)")
            XCTAssertEqual(transport.hellos, 0, "case \(index)")
            store.clear(endpoint: ingest, sdkKey: "k", ifFingerprint: DeviceLinkToken.fingerprint(fixtureToken))
        }
        let transport = ScriptedTransport(hello: [.reply(.none)])
        let c = makeEnabled(transport)
        XCTAssertTrue(c.isLinkingEnabled)
        await c.sendHelloIfIdle()?.value
        XCTAssertEqual(transport.hellos, 1)
        XCTAssertEqual(transport.helloNonceList.first?.count, 32)
    }

    func testNoSessionMeansNoHello() {
        let c = makeCoordinator()
        XCTAssertFalse(c.isLinkingEnabled)
        XCTAssertNil(c.currentLink)
        XCTAssertNil(c.sendHelloIfIdle())
    }

    func testNonePendingNothingShown() async {
        let transport = ScriptedTransport(hello: [.reply(.none)])
        let c = makeEnabled(transport)
        await c.sendHelloIfIdle()?.value
        XCTAssertEqual(banners, [])
        XCTAssertEqual(hides, 0)
        XCTAssertEqual(toasts, [])
        XCTAssertFalse(c.isAttemptActive)
        XCTAssertEqual(transport.checks.count, 0)
    }

    func testFailedHelloStops() async {
        let transport = ScriptedTransport(hello: [.failed])
        let c = makeEnabled(transport)
        await c.sendHelloIfIdle()?.value
        XCTAssertEqual(banners, [])
        XCTAssertFalse(c.isAttemptActive)
        // No silence after an ordinary failure.
        await c.sendHelloIfIdle()?.value
        XCTAssertEqual(transport.hellos, 2)
    }

    func testPendingShowsBannerAndPollsEveryThreeSeconds() async {
        let id = UUID()
        let transport = ScriptedTransport(
            hello: [.reply(.pending(attemptId: id, number: 47))],
            checks: [.reply(.pending), .reply(.pending), .reply(.linked(token: fixtureToken, owner: .user(name: "Aurimas")))])
        let c = makeEnabled(transport)
        await c.sendHelloIfIdle()?.value
        XCTAssertEqual(clock.sleeps, [3, 3, 3])
        XCTAssertEqual(banners, [47])
        XCTAssertEqual(hides, 1)
        XCTAssertEqual(toasts, ["Linked to Aurimas"])
        XCTAssertTrue(storedToken() == fixtureToken)
        XCTAssertEqual(store.link(endpoint: ingest, sdkKey: "k")?.owner, .user(name: "Aurimas"))
        XCTAssertEqual(linkChanges, [true])
        XCTAssertEqual(transport.checks.map(\.0), [id, id, id])
        XCTAssertTrue(transport.checks.allSatisfy { $0.1 == transport.helloNonceList.first })
        XCTAssertFalse(c.isAttemptActive)
        XCTAssertEqual(c.currentLink?.token.count, fixtureToken.count)
    }

    func testStopsAfterOneHundredFiftySeconds() async {
        let transport = ScriptedTransport(hello: [.reply(.pending(attemptId: UUID(), number: 5))], checks: [.reply(.pending)])
        let c = makeEnabled(transport)
        await c.sendHelloIfIdle()?.value
        XCTAssertEqual(transport.checks.count, 50)
        XCTAssertEqual(hides, 1)
        XCTAssertEqual(toasts, [])
        XCTAssertNil(storedToken())
    }

    func testExpiredHidesBanner() async {
        let transport = ScriptedTransport(hello: [.reply(.pending(attemptId: UUID(), number: 5))],
                                          checks: [.reply(.pending), .reply(.expired)])
        let c = makeEnabled(transport)
        await c.sendHelloIfIdle()?.value
        XCTAssertEqual(transport.checks.count, 2)
        XCTAssertEqual(hides, 1)
        XCTAssertNil(storedToken())
        XCTAssertEqual(toasts, [])
        XCTAssertEqual(linkChanges, [])
    }

    func testRetryOnTransientCheckErrors() async {
        let transport = ScriptedTransport(hello: [.reply(.pending(attemptId: UUID(), number: 5))],
                                          checks: [.retry, .retry, .reply(.linked(token: fixtureToken, owner: .team))])
        let c = makeEnabled(transport)
        await c.sendHelloIfIdle()?.value
        XCTAssertEqual(toasts, ["Linked as team device"])
        XCTAssertEqual(store.link(endpoint: ingest, sdkKey: "k")?.owner, .team)
    }

    func testStopOnTerminalCheckError() async {
        let transport = ScriptedTransport(hello: [.reply(.pending(attemptId: UUID(), number: 5))], checks: [.stop])
        let c = makeEnabled(transport)
        await c.sendHelloIfIdle()?.value
        XCTAssertEqual(hides, 1)
        XCTAssertEqual(transport.checks.count, 1)
        XCTAssertFalse(c.isAttemptActive)
    }

    func testSingleFlight() async {
        let gate = CoordinatorTestGate()
        let transport = ScriptedTransport(hello: [.reply(.pending(attemptId: UUID(), number: 5))], checks: [.reply(.expired)])
        transport.checkGate = gate
        let c = makeEnabled(transport)
        let task = c.sendHelloIfIdle()
        XCTAssertNotNil(task)
        XCTAssertTrue(c.isAttemptActive)
        while await gate.arrivals == 0 { await Task.yield() }
        XCTAssertNil(c.sendHelloIfIdle())
        XCTAssertNil(c.followIngestPending(.init(attemptId: UUID(), number: 9), nonce: DeviceLinkNonce.make()))
        await gate.release()
        await task?.value
        XCTAssertEqual(transport.hellos, 1)
        XCTAssertEqual(banners, [5])
        XCTAssertEqual(hides, 1)
    }

    func testRateLimitedSilencesHellosForSixtySeconds() async {
        let transport = ScriptedTransport(hello: [.rateLimited, .reply(.none)])
        let c = makeEnabled(transport)
        await c.sendHelloIfIdle()?.value
        XCTAssertEqual(transport.hellos, 1)
        clock.now = 59
        XCTAssertNil(c.sendHelloIfIdle())
        clock.now = 61
        await c.sendHelloIfIdle()?.value
        XCTAssertEqual(transport.hellos, 2)
    }

    func testIngestPendingFollowsWithSameNonceAndReplacesToken() async {
        store.save(DeviceLink(token: fixtureToken, owner: .user(name: "Jonas")), endpoint: ingest, sdkKey: "k")
        let id = UUID()
        let nonce = String(repeating: "N", count: 32)
        let transport = ScriptedTransport(checks: [.reply(.pending), .reply(.linked(token: otherToken, owner: .user(name: "Aurimas")))])
        let c = makeEnabled(transport)
        await c.followIngestPending(.init(attemptId: id, number: 12), nonce: nonce)?.value
        XCTAssertEqual(transport.checks.count, 2)
        XCTAssertTrue(transport.checks.allSatisfy { $0.0 == id && $0.1 == nonce })
        XCTAssertEqual(transport.hellos, 0)
        XCTAssertEqual(banners, [12])
        XCTAssertEqual(hides, 1)
        XCTAssertTrue(storedToken() == otherToken)
        XCTAssertEqual(toasts, ["Linked to Aurimas"])
        XCTAssertEqual(linkChanges, [true])
    }

    func testIngestPendingIgnoredWhileAttemptActive() async {
        let gate = CoordinatorTestGate()
        let transport = ScriptedTransport(hello: [.reply(.pending(attemptId: UUID(), number: 5))], checks: [.reply(.expired)])
        transport.checkGate = gate
        let c = makeEnabled(transport)
        let task = c.sendHelloIfIdle()
        while await gate.arrivals == 0 { await Task.yield() }
        XCTAssertNil(c.followIngestPending(.init(attemptId: UUID(), number: 9), nonce: DeviceLinkNonce.make()))
        await gate.release()
        await task?.value
        XCTAssertEqual(banners, [5])
        XCTAssertEqual(transport.checks.count, 1)
    }

    func testIngestPendingIgnoredOutsideDevice() {
        let c = makeEnabled(ScriptedTransport(), hostMode: .simulator)
        XCTAssertNil(c.followIngestPending(.init(attemptId: UUID(), number: 9), nonce: DeviceLinkNonce.make()))
    }

    func testConfigUnlinkedClearsOnlyMatchingToken() {
        store.save(DeviceLink(token: fixtureToken, owner: .team), endpoint: ingest, sdkKey: "k")
        let c = makeEnabled(ScriptedTransport())
        c.publish(remote: .init(enabled: true, link: .init(status: .unlinked, owner: nil),
                                requestTokenFingerprint: DeviceLinkToken.fingerprint(fixtureToken)))
        XCTAssertNil(storedToken())
        XCTAssertEqual(linkChanges, [false])
        XCTAssertEqual(toasts, [])

        store.save(DeviceLink(token: otherToken, owner: .team), endpoint: ingest, sdkKey: "k")
        c.publish(remote: .init(enabled: true, link: .init(status: .unlinked, owner: nil),
                                requestTokenFingerprint: DeviceLinkToken.fingerprint(fixtureToken)))
        XCTAssertTrue(storedToken() == otherToken)
        XCTAssertEqual(linkChanges, [false])

        // A reply that names no token changes nothing.
        c.publish(remote: .init(enabled: true, link: .init(status: .unlinked, owner: nil), requestTokenFingerprint: nil))
        XCTAssertTrue(storedToken() == otherToken)
    }

    func testConfigLinkIgnoredOutsideDevice() {
        store.save(DeviceLink(token: fixtureToken, owner: .team), endpoint: ingest, sdkKey: "k")
        let c = makeEnabled(ScriptedTransport(), hostMode: .simulator)
        c.publish(remote: .init(enabled: true, link: .init(status: .unlinked, owner: nil),
                                requestTokenFingerprint: DeviceLinkToken.fingerprint(fixtureToken)))
        XCTAssertTrue(storedToken() == fixtureToken)
        XCTAssertNil(c.currentLink)
    }

    func testConfigLinkedUpdatesOwnerName() {
        store.save(DeviceLink(token: fixtureToken, owner: .user(name: "Aurimas")), endpoint: ingest, sdkKey: "k")
        let c = makeEnabled(ScriptedTransport())
        c.publish(remote: .init(enabled: true, link: .init(status: .linked, owner: .user(name: "Aurimas M.")),
                                requestTokenFingerprint: DeviceLinkToken.fingerprint(otherToken)))
        XCTAssertEqual(c.currentLink?.owner, .user(name: "Aurimas"))
        c.publish(remote: .init(enabled: true, link: .init(status: .linked, owner: .user(name: "Aurimas M.")),
                                requestTokenFingerprint: DeviceLinkToken.fingerprint(fixtureToken)))
        XCTAssertEqual(c.currentLink?.owner, .user(name: "Aurimas M."))
        XCTAssertEqual(linkChanges, [])
        // An absent link changes nothing.
        c.publish(remote: .init(enabled: true))
        XCTAssertEqual(c.currentLink?.owner, .user(name: "Aurimas M."))
    }

    func testDeviceUnlinkedClearsOnlyTheTokenSent() {
        store.save(DeviceLink(token: otherToken, owner: .team), endpoint: ingest, sdkKey: "k")
        let c = makeEnabled(ScriptedTransport())
        c.handleDeviceUnlinked(sentToken: fixtureToken)
        XCTAssertTrue(storedToken() == otherToken)
        XCTAssertEqual(linkChanges, [])
        c.handleDeviceUnlinked(sentToken: otherToken)
        XCTAssertNil(storedToken())
        XCTAssertEqual(linkChanges, [false])
        XCTAssertEqual(toasts, [])
    }

    /// The outbox drain cleared this session's stored link: the session drops
    /// its linked gate the way `handleDeviceUnlinked` does.
    func testStoredLinkClearedElsewhereUnlinksTheMatchingSession() {
        store.save(DeviceLink(token: fixtureToken, owner: .team), endpoint: ingest, sdkKey: "k")
        let c = makeEnabled(ScriptedTransport())
        store.clear(endpoint: ingest, sdkKey: "k", ifFingerprint: DeviceLinkToken.fingerprint(fixtureToken))
        c.handleStoredLinkCleared(endpoint: URL(string: "https://INGEST.example:443/api/ingest")!, sdkKey: "k")
        XCTAssertEqual(linkChanges, [false])
        XCTAssertEqual(toasts, [])
    }

    /// A clear for another origin or key, a session outside `.device`, or a
    /// link stored again since the clear, leaves the session's gate alone.
    func testStoredLinkClearedIsScopedToTheSessionAndToken() {
        let c = makeEnabled(ScriptedTransport())
        c.handleStoredLinkCleared(endpoint: ingest, sdkKey: "other")
        c.handleStoredLinkCleared(endpoint: URL(string: "https://elsewhere.example")!, sdkKey: "k")
        XCTAssertEqual(linkChanges, [])

        // A newer token was stored after the clear: that link stays.
        store.save(DeviceLink(token: otherToken, owner: .team), endpoint: ingest, sdkKey: "k")
        c.handleStoredLinkCleared(endpoint: ingest, sdkKey: "k")
        XCTAssertEqual(linkChanges, [])
        XCTAssertTrue(storedToken() == otherToken)

        store.clear(endpoint: ingest, sdkKey: "k", ifFingerprint: DeviceLinkToken.fingerprint(otherToken))
        let simulator = makeEnabled(ScriptedTransport(), hostMode: .simulator)
        simulator.handleStoredLinkCleared(endpoint: ingest, sdkKey: "k")
        let ended = makeEnabled(ScriptedTransport())
        ended.teardown()
        ended.handleStoredLinkCleared(endpoint: ingest, sdkKey: "k")
        XCTAssertEqual(linkChanges, [])
    }

    /// A background `start()` replaces session A while A's Keychain save is
    /// still writing. Session B (another SDK key) must end with the linked
    /// gate its own store answers, never A's late `linked` callback. A's
    /// token stays stored for A's origin and key: it was issued for exactly
    /// that scope.
    func testLinkCompletionDoesNotLeakIntoTheNextSession() async {
        let blocking = BlockingDeviceLinkSecureStore()
        store = DeviceLinkStore(secure: blocking)
        let gate = FakeLinkedGate()
        let transport = ScriptedTransport(hello: [.reply(.pending(attemptId: UUID(), number: 8))],
                                          checks: [.reply(.linked(token: fixtureToken, owner: .team))])
        let c = makeEnabled(transport)
        let ingest = self.ingest
        let sessionB = DispatchGroup()
        sessionB.enter()
        // The worst interleaving: A's callback lands after B has set its gate.
        c.seams.linkChanged = { linked, isCurrent in
            _ = sessionB.wait(timeout: .now() + 2)
            gate.apply(linked, ifCurrent: isCurrent)
        }
        // Session B's start(), as `Everframe.start()` orders it: begin the
        // link session, reset the quick-capture gate, then set it from B's store.
        DispatchQueue.global().async {
            blocking.waitUntilWriting()
            DispatchQueue.global().async {
                c.beginSession(endpoint: ingest, sdkKey: "k2", hostMode: .device, transport: ScriptedTransport())
                gate.reset(linked: c.currentLink != nil)
                sessionB.leave()
            }
            Thread.sleep(forTimeInterval: 0.05)
            blocking.releaseWrite()
        }
        await c.sendHelloIfIdle()?.value
        await withCheckedContinuation { done in sessionB.notify(queue: .global()) { done.resume() } }
        for _ in 0..<50 { await Task.yield() }
        XCTAssertNil(c.currentLink)
        XCTAssertFalse(gate.linked, "session B has no link but ended up armed as linked")
        XCTAssertTrue(store.link(endpoint: ingest, sdkKey: "k")?.token == fixtureToken)
    }

    /// A `start()` or `kill()` between queuing an ingest takeover and its task
    /// running ends that attempt before it begins: no banner is ever shown,
    /// so none is left on screen.
    func testIngestPendingQueuedBeforeASessionChangeShowsNoBanner() async {
        let transport = ScriptedTransport(checks: [.reply(.pending)])
        let c = makeEnabled(transport)
        let task = c.followIngestPending(.init(attemptId: UUID(), number: 21), nonce: DeviceLinkNonce.make())
        c.teardown()
        await task?.value
        XCTAssertEqual(banners, [])
        XCTAssertEqual(hides, 0)
        XCTAssertEqual(transport.checks.count, 0)

        let replaced = makeEnabled(ScriptedTransport(checks: [.reply(.pending)]))
        let second = replaced.followIngestPending(.init(attemptId: UUID(), number: 22), nonce: DeviceLinkNonce.make())
        replaced.beginSession(endpoint: ingest, sdkKey: "k2", hostMode: .device, transport: ScriptedTransport())
        await second?.value
        XCTAssertEqual(banners, [])
        XCTAssertEqual(hides, 0)
    }

    /// The Keychain refused the token: the device stays unlinked, the banner
    /// goes, and the device says linking failed instead of "Linked to …".
    func testFailedTokenWriteKeepsTheDeviceUnlinked() async {
        store = DeviceLinkStore(secure: RefusingDeviceLinkSecureStore())
        let transport = ScriptedTransport(hello: [.reply(.pending(attemptId: UUID(), number: 4))],
                                          checks: [.reply(.linked(token: fixtureToken, owner: .user(name: "Aurimas")))])
        let c = makeEnabled(transport)
        await c.sendHelloIfIdle()?.value
        XCTAssertNil(c.currentLink)
        XCTAssertEqual(linkChanges, [])
        XCTAssertEqual(banners, [4])
        XCTAssertEqual(hides, 1)
        XCTAssertEqual(toasts, ["Linking failed"])
        XCTAssertFalse(c.isAttemptActive)
    }

    /// A capture's link lookup answers only for this `.device` session's own
    /// origin and key.
    func testLinkForAScopeAnswersOnlyForThisSession() {
        store.save(DeviceLink(token: fixtureToken, owner: .team), endpoint: ingest, sdkKey: "k")
        store.save(DeviceLink(token: otherToken, owner: .team), endpoint: ingest, sdkKey: "k2")
        let c = makeEnabled(ScriptedTransport())
        XCTAssertTrue(c.link(endpoint: URL(string: "https://INGEST.example/api/ingest")!, sdkKey: "k")?.token == fixtureToken)
        XCTAssertNil(c.link(endpoint: ingest, sdkKey: "k2"))
        XCTAssertNil(c.link(endpoint: URL(string: "https://elsewhere.example")!, sdkKey: "k"))
        XCTAssertNil(makeEnabled(ScriptedTransport(), hostMode: .simulator).link(endpoint: ingest, sdkKey: "k"))
        c.teardown()
        XCTAssertNil(c.link(endpoint: ingest, sdkKey: "k"))
    }

    func testTeardownCancelsPollingAndHidesBanner() async {
        let gate = CoordinatorTestGate()
        let transport = ScriptedTransport(hello: [.reply(.pending(attemptId: UUID(), number: 5))],
                                          checks: [.reply(.linked(token: fixtureToken, owner: .team))])
        transport.checkGate = gate
        let c = makeEnabled(transport)
        let task = c.sendHelloIfIdle()
        while await gate.arrivals == 0 { await Task.yield() }
        c.teardown()
        XCTAssertEqual(hides, 1)
        XCTAssertFalse(c.isAttemptActive)
        XCTAssertFalse(c.isLinkingEnabled)
        XCTAssertNil(c.__sessionKeyForTesting)
        await gate.release()
        await task?.value
        XCTAssertEqual(transport.checks.count, 1)
        XCTAssertNil(storedToken())
        XCTAssertEqual(toasts, [])
        XCTAssertEqual(linkChanges, [])
        XCTAssertEqual(hides, 1)
    }

    func testANewSessionDropsTheOldAttempt() async {
        let gate = CoordinatorTestGate()
        let transport = ScriptedTransport(hello: [.reply(.pending(attemptId: UUID(), number: 5))],
                                          checks: [.reply(.linked(token: fixtureToken, owner: .team))])
        transport.checkGate = gate
        let c = makeEnabled(transport)
        let task = c.sendHelloIfIdle()
        while await gate.arrivals == 0 { await Task.yield() }
        c.beginSession(endpoint: ingest, sdkKey: "k", hostMode: .device, transport: transport)
        await gate.release()
        await task?.value
        XCTAssertNil(storedToken())
        XCTAssertEqual(hides, 1)
        XCTAssertEqual(c.__sessionKeyForTesting, "k")
    }

    func testIfCurrentGuardsSessionWrites() {
        let c = makeCoordinator()
        c.beginSession(endpoint: ingest, sdkKey: "k", hostMode: .device, transport: ScriptedTransport(), ifCurrent: { false })
        XCTAssertNil(c.__sessionKeyForTesting)
        c.beginSession(endpoint: ingest, sdkKey: "k", hostMode: .device, transport: ScriptedTransport())
        c.publish(remote: .init(enabled: true), ifCurrent: { false })
        XCTAssertFalse(c.isLinkingEnabled)
        c.teardown(ifCurrent: { false })
        XCTAssertEqual(c.__sessionKeyForTesting, "k")
    }
}

/// Lets the first write start, then holds it until `releaseWrite()`.
private final class BlockingDeviceLinkSecureStore: DeviceLinkSecureStore, @unchecked Sendable {
    private let inner = InMemoryDeviceLinkSecureStore()
    private let writing = DispatchSemaphore(value: 0)
    private let release = DispatchSemaphore(value: 0)

    func read(account: String) -> Data? { inner.read(account: account) }
    func delete(account: String) { inner.delete(account: account) }
    func write(_ data: Data, account: String) -> Bool {
        writing.signal()
        release.wait()
        return inner.write(data, account: account)
    }
    func waitUntilWriting() { writing.wait() }
    func releaseWrite() { release.signal() }
}

/// Quick capture's linked flag: a session reset and the coordinator's
/// callback serialize on one lock, as `QuickCapture`'s state lock does.
private final class FakeLinkedGate: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    var linked: Bool { lock.lock(); defer { lock.unlock() }; return value }
    func reset(linked: Bool) { lock.lock(); value = linked; lock.unlock() }
    func apply(_ linked: Bool, ifCurrent: () -> Bool) {
        lock.lock(); defer { lock.unlock() }
        if ifCurrent() { value = linked }
    }
}

/// A Keychain that refuses every write.
private final class RefusingDeviceLinkSecureStore: DeviceLinkSecureStore, @unchecked Sendable {
    func read(account: String) -> Data? { nil }
    func write(_ data: Data, account: String) -> Bool { false }
    func delete(account: String) {}
}
