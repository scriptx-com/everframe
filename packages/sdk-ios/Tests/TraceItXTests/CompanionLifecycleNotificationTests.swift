// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// PR-fix 5, Finding 2 — the companion lifecycle protection must be ACTIVE on
// tvOS, not merely compiled.
//
// `RelayWSClientCompanionTests` drives `handleDidEnterBackground()` /
// `handleWillEnterForeground()` directly, which proves what the handlers do but
// says nothing about whether anything ever calls them on a given platform.
// That gap is exactly the defect this file exists for: the observers used to be
// registered under `#if canImport(UIKit) && !os(tvOS)`, so on the one device
// class companion is built for — Apple TV — a backgrounded app kept its relay
// socket, an announce in flight still opened one, and coming back to the
// foreground never re-announced the single-use ticket it had lost.
//
// So these tests post the REAL `UIApplication` notifications through
// `NotificationCenter.default` and assert on the client's observable behaviour.
// Nothing here is stubbed except the announce transport and the socket
// factory; the registration in `RelayWSClient.init` is the code under test.
//
// *** THIS SUITE ONLY RUNS ON A UIKIT PLATFORM. *** `swift test` on macOS
// compiles it out entirely (`canImport(UIKit)` is false there), which is
// precisely why CI runs it on a tvOS simulator — see
// `.github/workflows/swift.yml`, job `lifecycle-tests-tvOS`:
//
//     xcodebuild test -scheme TraceItX-Package \
//       -destination 'platform=tvOS Simulator,id=<udid>' \
//       -only-testing:TraceItXTests/CompanionLifecycleNotificationTests
//
// Run it on an iOS simulator the same way — the invariant is identical on both
// and the notifications are the same two.
#if canImport(UIKit)
import Testing
import Foundation
import UIKit

@testable import TraceItXKit

@Suite(.serialized)
final class CompanionLifecycleNotificationTests {

    private static let endpoint = URL(string: "https://relay.example.com")!

    /// Hands out `tkt_1`, `tkt_2`, … and counts how many announces went out.
    private final class AnnounceSpy: @unchecked Sendable {
        private let lock = NSLock()
        private var _issued = 0
        let delayNanos: UInt64

        init(delayNanos: UInt64 = 0) { self.delayNanos = delayNanos }

        var requestCount: Int {
            lock.lock(); defer { lock.unlock() }
            return _issued
        }

        private func nextTicket() -> Int {
            lock.lock(); defer { lock.unlock() }
            _issued += 1
            return _issued
        }

        func transport() -> AnnounceTransport {
            return { [self] request in
                let n = nextTicket()
                if delayNanos > 0 { try? await Task.sleep(nanoseconds: delayNanos) }
                let body = Data(#"{"ticket":"tkt_\#(n)","code":"CODE\#(n)"}"#.utf8)
                let response = HTTPURLResponse(
                    url: request.url!, statusCode: 200,
                    httpVersion: "HTTP/1.1", headerFields: nil)!
                return (body, response)
            }
        }
    }

    /// Records the URL of every socket the client tried to open.
    private final class SocketSpy: @unchecked Sendable {
        private let lock = NSLock()
        private var _urls: [URL] = []
        var urls: [URL] {
            lock.lock(); defer { lock.unlock() }
            return _urls
        }
        func record(_ url: URL) { lock.lock(); _urls.append(url); lock.unlock() }
    }

    /// The real client, with the announce hop and socket creation seamed out.
    ///
    /// `__readApplicationBackgroundState` is overridden to answer "foreground"
    /// so these tests measure the NOTIFICATIONS and nothing else. The
    /// production reader is real on this platform and is covered separately by
    /// `theBackgroundStateReaderIsInstalledOnThisPlatform` — leaving it in
    /// would make every test here depend on the state of the simulator's test
    /// host app instead of on the behaviour under test.
    ///
    /// The two `willEnterForegroundNotification_…` tests near the bottom
    /// deliberately do NOT use this helper. An always-`false` reader cannot
    /// express the interleaving that wedges a foregrounding session, and
    /// reaching for this helper by habit is how that defect stayed open across
    /// a review that was looking for it.
    private func makeClient(
        announce: AnnounceSpy
    ) -> (RelayWSClient, CompanionAPI, SocketSpy) {
        let api = CompanionAPI()
        let client = RelayWSClient(
            endpoint: Self.endpoint,
            companion: api,
            sdkKey: "key",
            deviceLabel: nil,
            announceTransport: announce.transport())
        let sockets = SocketSpy()
        client.__openSocketHook = { sockets.record($0) }
        client.__readApplicationBackgroundState = { answer in answer(false) }
        return (client, api, sockets)
    }

    /// UIKit notifications are posted on the main thread in production; match
    /// that, and wait for delivery so the assertion that follows is not racing
    /// a hop it never saw.
    private func post(_ name: Notification.Name) async {
        await MainActor.run {
            NotificationCenter.default.post(name: name, object: nil)
        }
    }

    @discardableResult
    private func waitUntil(
        timeout: TimeInterval = 3,
        _ condition: @Sendable () -> Bool
    ) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return condition()
    }

    // MARK: - The background transition is observed on this platform

    @Test func didEnterBackgroundNotification_supersedesTheInFlightAnnounce() async {
        // THE tvOS defect, end to end. The announce is an awaited HTTP call in
        // front of every socket open, so at the moment the app backgrounds
        // there is usually no socket to cancel — only an attempt in flight. If
        // the notification is not observed on this platform, that continuation
        // opens a socket with the app away: the device stays listed in the
        // dashboard and keeps accepting capture requests with no UI behind it.
        let announce = AnnounceSpy(delayNanos: 400_000_000)
        let (client, api, sockets) = makeClient(announce: announce)
        defer { client.disconnect() }

        client.connect()
        // Anti-vacuity: the announce really is in flight before we background.
        #expect(await waitUntil { announce.requestCount == 1 })
        #expect(sockets.urls.isEmpty)

        await post(UIApplication.didEnterBackgroundNotification)

        // Well past the 400ms announce and past the 1s first backoff step, so
        // a resurrection by either route would have been recorded.
        try? await Task.sleep(nanoseconds: 1_800_000_000)
        #expect(sockets.urls.isEmpty)
        // A losing attempt must not publish its already-dead display code.
        #expect(api.code == nil)
        #expect(announce.requestCount == 1)
    }

    @Test func didEnterBackgroundNotification_dropsTheLiveSession() async {
        // The other entry state: a socket is already open when the app leaves.
        let announce = AnnounceSpy()
        let (client, api, sockets) = makeClient(announce: announce)
        defer { client.disconnect() }

        client.connect()
        #expect(await waitUntil { sockets.urls.count == 1 })

        await post(UIApplication.didEnterBackgroundNotification)

        #expect(await waitUntil { api.state == .phoneDisconnected })
        // Nothing may dial while away, for as long as it stays away.
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        #expect(sockets.urls.count == 1)
        #expect(announce.requestCount == 1)
    }

    @Test func willEnterForegroundNotification_announcesAfreshAndOpensExactlyOne() async {
        // Recovery must announce AGAIN — the ticket it lost was single-use with
        // a 60s TTL — and exactly once: zero leaves the TV permanently
        // invisible in the dashboard, two spends a ticket to list one device
        // twice.
        let announce = AnnounceSpy()
        let (client, api, sockets) = makeClient(announce: announce)
        defer { client.disconnect() }

        client.connect()
        #expect(await waitUntil { sockets.urls.count == 1 })
        await post(UIApplication.didEnterBackgroundNotification)
        try? await Task.sleep(nanoseconds: 300_000_000)

        await post(UIApplication.willEnterForegroundNotification)

        #expect(await waitUntil(timeout: 5) { sockets.urls.count == 2 })
        #expect(announce.requestCount == 2)
        // A FRESH ticket, not a resumed one.
        #expect(sockets.urls.last?.absoluteString
            == "wss://relay.example.com/relay/tv/tkt_2")
        #expect(api.code == "CODE2")

        // …and only one. Nothing else appears afterwards.
        try? await Task.sleep(nanoseconds: 1_200_000_000)
        #expect(sockets.urls.count == 2)
        #expect(announce.requestCount == 2)
    }

    // MARK: - A transient interruption is NOT a backgrounding

    @Test func willResignActiveNotification_leavesALiveSessionAlone() async {
        // Resign-active is not backgrounding: a notification banner, Control
        // Center, an incoming call, a tvOS system overlay. A companion session
        // is long-lived and frequently mid-report, so tearing it down here
        // would be a visible regression — the socket dies, the state drops to
        // `.phoneDisconnected`, and the return trip announces a DIFFERENT pair
        // token, i.e. the QR on screen is swapped out from under whoever is
        // scanning it. This is the half of the trade-off that keeps the
        // notification pair honest; without it, "observe more notifications"
        // would look strictly safer than it is.
        let announce = AnnounceSpy()
        let (client, api, sockets) = makeClient(announce: announce)
        defer { client.disconnect() }

        client.connect()
        #expect(await waitUntil { sockets.urls.count == 1 })
        #expect(await waitUntil { api.code == "CODE1" })

        await post(UIApplication.willResignActiveNotification)
        await post(UIApplication.didBecomeActiveNotification)

        // Nothing was superseded: no second announce, no second socket, no
        // state change, and the display code the dashboard is showing survives.
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        #expect(sockets.urls.count == 1)
        #expect(announce.requestCount == 1)
        #expect(api.state != .phoneDisconnected)
        #expect(api.code == "CODE1")
    }

    @Test func didBecomeActiveNotification_aloneDoesNotReconnect() async {
        // `didBecomeActive` fires at cold launch too, right after a host that
        // started companion from `didFinishLaunchingWithOptions`. Observing it
        // meant that launch immediately announced a second ticket and
        // superseded the socket it had just opened. `willEnterForeground` is
        // not sent at launch, and this asserts we no longer react to the one
        // that is.
        let announce = AnnounceSpy()
        let (client, _, sockets) = makeClient(announce: announce)
        defer { client.disconnect() }

        client.connect()
        #expect(await waitUntil { sockets.urls.count == 1 })

        await post(UIApplication.didBecomeActiveNotification)

        try? await Task.sleep(nanoseconds: 1_000_000_000)
        #expect(sockets.urls.count == 1)
        #expect(announce.requestCount == 1)
    }

    // MARK: - The already-backgrounded read exists here too

    @Test func theBackgroundStateReaderIsInstalledOnThisPlatform() async {
        // `connect()` consults this because the notifications only ever fire on
        // a TRANSITION: a host that restarts companion while the process is
        // already away produces none. It was installed under the same
        // `!os(tvOS)` exclusion, so on a TV it was nil and that whole guard was
        // dead. Assert it is present AND that it answers — a reader that never
        // calls back would leave `connect()` silently unguarded.
        let announce = AnnounceSpy()
        let api = CompanionAPI()
        let client = RelayWSClient(
            endpoint: Self.endpoint, companion: api, sdkKey: "key",
            deviceLabel: nil, announceTransport: announce.transport())
        defer { client.disconnect() }

        guard let read = client.__readApplicationBackgroundState else {
            Issue.record("no application-state reader installed on this platform")
            return
        }
        let answered = UnsafeAnswerBox()
        read { backgrounded in answered.set(backgrounded) }
        #expect(await waitUntil { answered.value != nil })
    }

    // MARK: - The foreground transition must not ask "am I already backgrounded?"
    //
    // `connect()` ends by consulting `__readApplicationBackgroundState`, which
    // reads `UIApplication.shared.applicationState` on a DEFERRED main-queue
    // block. That read is meaningful for a host that calls `connect()` out of
    // the blue. It is not meaningful on the way back IN, and worse, it answers
    // wrong: `applicationState` is still `.background` when
    // `willEnterForeground` is delivered and only advances later in the same
    // transition. Land the deferred block before that advance and the client
    // backgrounds itself while coming to the foreground — `isBackgrounded` set,
    // no socket, no timer, and `beginConnect()` refusing every later attempt.
    //
    // Every other test in this file stubs that reader to answer `false`, which
    // is exactly why this was invisible: a reader that always says "foreground"
    // cannot express the failing interleaving. Neither test below uses that
    // stub.

    /// Counts consultations without replacing what runs.
    private final class ProbeCounter: @unchecked Sendable {
        private let lock = NSLock()
        private var _count = 0
        var count: Int { lock.lock(); defer { lock.unlock() }; return _count }
        func bump() { lock.lock(); _count += 1; lock.unlock() }
    }

    /// Stands in for `UIApplication.shared.applicationState`, which a test host
    /// cannot drive — a simulator's host app is `.active` for the whole run, so
    /// the live reader can only ever return the harmless answer.
    private final class ApplicationStateBox: @unchecked Sendable {
        private let lock = NSLock()
        private var _value: UIApplication.State
        init(_ value: UIApplication.State) { _value = value }
        var value: UIApplication.State {
            lock.lock(); defer { lock.unlock() }
            return _value
        }
        func set(_ v: UIApplication.State) { lock.lock(); _value = v; lock.unlock() }
    }

    private func makeUnstubbedClient(
        announce: AnnounceSpy
    ) -> (RelayWSClient, CompanionAPI, SocketSpy) {
        let api = CompanionAPI()
        let client = RelayWSClient(
            endpoint: Self.endpoint, companion: api, sdkKey: "key",
            deviceLabel: nil, announceTransport: announce.transport())
        let sockets = SocketSpy()
        client.__openSocketHook = { sockets.record($0) }
        return (client, api, sockets)
    }

    @Test func willEnterForegroundNotification_doesNotConsultTheBackgroundStateReader() async {
        // The structural half: whatever the reader would answer, the foreground
        // path must not ask it. This runs the REAL reader `init` installed on
        // this platform — the decorator wraps it, it does not replace it — so
        // the anti-vacuity assertion below is a genuine production read.
        let announce = AnnounceSpy()
        let (client, _, sockets) = makeUnstubbedClient(announce: announce)
        defer { client.disconnect() }

        guard let production = client.__readApplicationBackgroundState else {
            Issue.record("no application-state reader installed on this platform")
            return
        }
        let probes = ProbeCounter()
        client.__readApplicationBackgroundState = { answer in
            probes.bump()
            production(answer)
        }

        client.connect()
        #expect(await waitUntil { sockets.urls.count == 1 })
        // Anti-vacuity: a host `connect()` DOES consult it. Without this the
        // test would pass against a client that had lost the probe entirely.
        #expect(await waitUntil { probes.count == 1 })

        await post(UIApplication.didEnterBackgroundNotification)
        try? await Task.sleep(nanoseconds: 300_000_000)
        let beforeForeground = probes.count

        await post(UIApplication.willEnterForegroundNotification)
        #expect(await waitUntil(timeout: 5) { sockets.urls.count == 2 })
        // Well past any deferred main-queue hop the probe would have taken.
        try? await Task.sleep(nanoseconds: 500_000_000)

        #expect(probes.count == beforeForeground)
    }

    @Test func willEnterForegroundNotification_recoversWhileApplicationStateStillReadsBackground() async {
        // The behavioural half, and the one that actually wedges a session.
        //
        // The reader here is not a stubbed constant: it is the PRODUCTION
        // decision (`RelayWSClient.__isAlreadyBackgrounded`, the same function
        // the live reader calls) applied to the state UIKit really reports at
        // each moment, on the same deferred main-queue hop production uses. The
        // only thing substituted is the one value a test host cannot control.
        let announce = AnnounceSpy()
        let (client, api, sockets) = makeUnstubbedClient(announce: announce)
        defer { client.disconnect() }

        let uikitState = ApplicationStateBox(.active)
        client.__readApplicationBackgroundState = { answer in
            DispatchQueue.main.async {
                answer(RelayWSClient.__isAlreadyBackgrounded(uikitState.value))
            }
        }

        client.connect()
        #expect(await waitUntil { sockets.urls.count == 1 })

        uikitState.set(.background)
        await post(UIApplication.didEnterBackgroundNotification)
        #expect(await waitUntil { api.state == .phoneDisconnected })

        // `willEnterForeground` is delivered with `applicationState` STILL
        // `.background`; it advances later in the same transition. This is the
        // interleaving, not a contrived one.
        await post(UIApplication.willEnterForegroundNotification)

        // Recovery happened: a fresh single-use ticket, a socket opened.
        #expect(await waitUntil(timeout: 5) { sockets.urls.count == 2 })
        #expect(announce.requestCount == 2)

        // …and the client is not wedged. Under the defect `isBackgrounded` was
        // left set by the self-inflicted background, so `beginConnect()` refused
        // everything afterwards — including this host connect — until a full
        // background/foreground cycle happened to land the probe the other way.
        uikitState.set(.active)
        client.connect()
        #expect(await waitUntil(timeout: 5) { sockets.urls.count == 3 })
        #expect(announce.requestCount == 3)
    }

    private final class UnsafeAnswerBox: @unchecked Sendable {
        private let lock = NSLock()
        private var _value: Bool?
        var value: Bool? {
            lock.lock(); defer { lock.unlock() }
            return _value
        }
        func set(_ v: Bool) { lock.lock(); _value = v; lock.unlock() }
    }
}
#endif
