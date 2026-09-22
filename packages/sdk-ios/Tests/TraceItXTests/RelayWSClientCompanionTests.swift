// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Companion-discovery behaviour of `RelayWSClient` (spec 2026-08-07).
//
// These drive the REAL connect and reconnect paths — including the real
// `scheduleReconnect()` timer — with two seams: an injected announce
// transport (no network) and `__openSocketHook` (no WebSocket). What each
// attempt resolved to is then read off the recorded URLs, which is the only
// way to prove the properties that matter here:
//   • a failed announce still opens the plain `/relay/tv` socket,
//   • EVERY attempt announces again with a fresh ticket (a cached ticket
//     would close 4004 forever after the first reconnect),
//   • no SDK key means no HTTP call at all.
import Testing
import Foundation

import TraceItXProtocol
@testable import TraceItXKit

@Suite(.serialized)
final class RelayWSClientCompanionTests {

    private static let endpoint = URL(string: "https://relay.example.com")!

    /// Announce transport that hands out `tkt_1`, `tkt_2`, … (or fails), and
    /// records every request it saw.
    private final class AnnounceSpy: @unchecked Sendable {
        private let lock = NSLock()
        private var _requests: [URLRequest] = []
        private var _issued = 0

        /// nil → succeed with an incrementing ticket; non-nil → that status.
        let failStatus: Int?
        /// Simulated round-trip time, so a test can keep an announce in flight
        /// while it starts a competing attempt.
        let delayNanos: UInt64
        /// When non-nil, every success response carries this as the wire
        /// `resolvedName` (naming spec 2026-08-24) — lets a test drive
        /// `RelayWSClient.beginConnect()`'s real
        /// `self.companion?.__setResolvedName(result.resolvedName)` line
        /// rather than only exercising it via `CompanionAnnounce` directly.
        let resolvedName: String?

        init(failStatus: Int? = nil, delayNanos: UInt64 = 0, resolvedName: String? = nil) {
            self.failStatus = failStatus
            self.delayNanos = delayNanos
            self.resolvedName = resolvedName
        }

        var requestCount: Int {
            lock.lock(); defer { lock.unlock() }
            return _requests.count
        }
        var requests: [URLRequest] {
            lock.lock(); defer { lock.unlock() }
            return _requests
        }

        /// Synchronous so the async transport closure below never touches
        /// `NSLock` directly (unavailable from async contexts).
        private func record(_ request: URLRequest) -> Int {
            lock.lock(); defer { lock.unlock() }
            _requests.append(request)
            _issued += 1
            return _issued
        }

        func transport() -> AnnounceTransport {
            return { [self] request in
                let n = record(request)
                if delayNanos > 0 { try? await Task.sleep(nanoseconds: delayNanos) }
                let status = failStatus ?? 200
                let body: Data
                if failStatus != nil {
                    body = Data(#"{"error":"invalid_sdk_key"}"#.utf8)
                } else if let resolvedName {
                    body = Data(#"{"ticket":"tkt_\#(n)","code":"CODE\#(n)","resolvedName":"\#(resolvedName)"}"#.utf8)
                } else {
                    body = Data(#"{"ticket":"tkt_\#(n)","code":"CODE\#(n)"}"#.utf8)
                }
                let response = HTTPURLResponse(
                    url: request.url!, statusCode: status,
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
        func record(_ url: URL) {
            lock.lock(); _urls.append(url); lock.unlock()
        }
    }

    private func makeClient(
        sdkKey: String?,
        deviceLabel: String? = nil,
        announce: AnnounceSpy
    ) -> (RelayWSClient, CompanionAPI, SocketSpy) {
        let api = CompanionAPI()
        let client = RelayWSClient(
            endpoint: Self.endpoint,
            companion: api,
            sdkKey: sdkKey,
            deviceLabel: deviceLabel,
            announceTransport: announce.transport())
        let sockets = SocketSpy()
        client.__openSocketHook = { sockets.record($0) }
        // Deterministic "no device" — this suite's assertions are about
        // ticket/code/reconnect behaviour, none of them about the naming-spec
        // `device` block, and real resolution touches Keychain (availability
        // genuinely varies by host — see `__deviceResolverOverride`'s doc).
        client.__deviceResolverOverride = { nil }
        return (client, api, sockets)
    }

    /// Poll until `condition` holds or the timeout elapses. Returns the final
    /// verdict so the caller can `#expect` on it.
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

    /// Drive the real `didCloseWith` delegate entry point. `task` defaults to a
    /// throwaway one, which the client treats as current only while it owns no
    /// socket of its own (the `__openSocketHook` tests); the real-socket tests
    /// below pass the installed task explicitly.
    private func simulateSocketClose(
        _ client: RelayWSClient,
        code: Int,
        task: URLSessionWebSocketTask? = nil
    ) {
        client.urlSession(
            URLSession.shared,
            webSocketTask: task
                ?? URLSession.shared.webSocketTask(with: URL(string: "wss://example/")!),
            didCloseWith: URLSessionWebSocketTask.CloseCode(rawValue: code)!,
            reason: nil)
    }

    // MARK: - URL composition

    @Test func wsURLForTicket_percentEncodesTheTicket() {
        let url = RelayWSClient.wsURLForTicket(
            endpoint: Self.endpoint, ticket: "tkt/ab?c d")
        #expect(url.absoluteString == "wss://relay.example.com/relay/tv/tkt%2Fab%3Fc%20d")
    }

    @Test func wsURLForTicket_httpEndpointBecomesWs() {
        let url = RelayWSClient.wsURLForTicket(
            endpoint: URL(string: "http://localhost:8787")!, ticket: "tkt_1")
        #expect(url.absoluteString == "ws://localhost:8787/relay/tv/tkt_1")
    }

    // MARK: - Connect

    @Test func connect_withSdkKey_announcesThenOpensTicketedSocket() async {
        let announce = AnnounceSpy()
        let (client, api, sockets) = makeClient(sdkKey: "key", deviceLabel: "Lobby TV", announce: announce)

        client.connect()

        #expect(await waitUntil { sockets.urls.count == 1 })
        #expect(sockets.urls.first?.absoluteString == "wss://relay.example.com/relay/tv/tkt_1")
        #expect(api.code == "CODE1")
        #expect(announce.requests.first?.httpBody == Data(#"{"label":"Lobby TV"}"#.utf8))
        client.disconnect()
    }

    // MARK: - Device identity + resolvedName wiring (naming spec 2026-08-24,
    // fix round 1 of Task 2's review: pin the RelayWSClient-level wiring so
    // reverting either the `device: device` announce-call-site line or the
    // `result.resolvedName` publish line fails a test, not just the
    // lower-level `CompanionAnnounce` unit tests.)

    @Test func connect_withAResolvedDevice_includesItInTheAnnounceRequestBody() async {
        let announce = AnnounceSpy()
        let (client, _, sockets) = makeClient(sdkKey: "key", announce: announce)
        // Overrides `makeClient`'s default `{ nil }` — proves the device this
        // override hands back is the one that actually rides the real
        // `announcer.announce(...)` call inside `beginConnect()`, not merely
        // one `CompanionAnnounce.body(...)` can encode in isolation.
        let device = AnnounceDevice(
            id: "11112222-3333-4444-8888-999900001111",
            platform: "tvos",
            model: nil, osName: nil, osVersion: nil,
            emulator: true)
        client.__deviceResolverOverride = { device }

        client.connect()

        #expect(await waitUntil { sockets.urls.count == 1 })
        #expect(announce.requests.first?.httpBody == Data(
            #"{"device":{"emulator":true,"id":"11112222-3333-4444-8888-999900001111","platform":"tvos"}}"#.utf8))
        client.disconnect()
    }

    @available(iOS 16.0, tvOS 16.0, *)
    @Test(.timeLimit(.minutes(1)))
    func connect_publishesResolvedNameFromTheAnnounceResponse() async {
        let announce = AnnounceSpy(resolvedName: "Samsung TV · Tizen 7.0")
        let (client, api, sockets) = makeClient(sdkKey: "key", announce: announce)
        let (opened, continuation) = AsyncStream<URL>.makeStream()
        client.__openSocketHook = { url in
            sockets.record(url)
            continuation.yield(url)
        }
        defer {
            client.disconnect()
            continuation.finish()
        }

        client.connect()

        // Opening the socket follows the synchronous resolved-name publish.
        // Await that real completion rather than spending a 3-second polling
        // budget while unrelated full-suite work occupies the executors.
        // The test time limit still fails a missing callback.
        var iterator = opened.makeAsyncIterator()
        #expect(await iterator.next()?.absoluteString == "wss://relay.example.com/relay/tv/tkt_1")
        #expect(sockets.urls.count == 1)
        #expect(api.resolvedName == "Samsung TV · Tizen 7.0")
    }

    @Test func connect_announceFailure_fallsBackToTicketlessAndStillPairs() async {
        // THE load-bearing property: a revoked key (or an offline device, or
        // an older server) costs discovery and nothing else.
        let announce = AnnounceSpy(failStatus: 401)
        let (client, api, sockets) = makeClient(sdkKey: "revoked", announce: announce)

        client.connect()

        #expect(await waitUntil { sockets.urls.count == 1 })
        #expect(sockets.urls.first?.absoluteString == "wss://relay.example.com/relay/tv")
        #expect(api.code == nil)

        // …and the pairing flow that follows is untouched.
        client.handleControl(#"{"type":"pair.created","pair_id":"p","pair_token":"tok_xyz"}"#)
        #expect(api.state == .unpaired)
        #expect(api.pairUrl == "https://relay.example.com/r/tok_xyz")
        client.disconnect()
    }

    @Test func connect_withoutSdkKey_makesNoHTTPCallAtAll() async {
        // The transport is wired but the key is absent — nothing may call it.
        let announce = AnnounceSpy()
        let (client, api, sockets) = makeClient(sdkKey: nil, announce: announce)

        client.connect()

        #expect(await waitUntil { sockets.urls.count == 1 })
        #expect(sockets.urls.first?.absoluteString == "wss://relay.example.com/relay/tv")
        #expect(announce.requestCount == 0)
        #expect(api.code == nil)
        client.disconnect()
    }

    @Test func disconnectDuringAnnounce_doesNotOpenASocket() async {
        // `disconnect()` while the announce is in flight must not resurrect
        // the socket the host just closed.
        let announce = AnnounceSpy()
        let (client, _, sockets) = makeClient(sdkKey: "key", announce: announce)

        client.connect()
        client.disconnect()

        #expect(await waitUntil { announce.requestCount == 1 })
        // Give the continuation every chance to (wrongly) open the socket.
        try? await Task.sleep(nanoseconds: 200_000_000)
        #expect(sockets.urls.isEmpty)
    }

    // MARK: - Reconnect

    @Test func everyReconnectAttemptAnnouncesAgainWithAFreshTicket() async {
        // Tickets are single-use with a 60s TTL. If announce ran only on cold
        // start, the first reconnect would reuse (or omit) the ticket and the
        // device would drop out of the dashboard permanently. Drive the REAL
        // scheduleReconnect timer — first backoff step is 1s.
        let announce = AnnounceSpy()
        let (client, _, sockets) = makeClient(sdkKey: "key", announce: announce)

        client.connect()
        #expect(await waitUntil { sockets.urls.count == 1 })

        simulateSocketClose(client, code: 4006)

        #expect(await waitUntil(timeout: 5) { sockets.urls.count == 2 })
        #expect(announce.requestCount == 2)
        #expect(sockets.urls.map(\.absoluteString) == [
            "wss://relay.example.com/relay/tv/tkt_1",
            "wss://relay.example.com/relay/tv/tkt_2",
        ])
        client.disconnect()
    }

    @Test func reconnectAfterTerminalClose_alsoReAnnounces() async {
        // 4001..4004 scrub the pair and reconnect from scratch — that path
        // schedules its own reconnect and must announce too.
        let announce = AnnounceSpy()
        let (client, api, sockets) = makeClient(sdkKey: "key", announce: announce)

        client.connect()
        #expect(await waitUntil { sockets.urls.count == 1 })

        simulateSocketClose(client, code: 4004)

        #expect(await waitUntil(timeout: 5) { sockets.urls.count == 2 })
        #expect(sockets.urls[1].absoluteString == "wss://relay.example.com/relay/tv/tkt_2")
        #expect(api.code == "CODE2")
        client.disconnect()
    }

    @Test func reconnectWhenAnnounceStartsFailing_fallsBackToTicketless() async {
        // Announce succeeding once must not pin the client to the ticketed
        // path — a key revoked mid-session still reconnects and keeps
        // reporting.
        let announce = AnnounceSpy(failStatus: 500)
        let (client, _, sockets) = makeClient(sdkKey: "key", announce: announce)

        client.connect()
        #expect(await waitUntil { sockets.urls.count == 1 })

        simulateSocketClose(client, code: 4006)

        #expect(await waitUntil(timeout: 5) { sockets.urls.count == 2 })
        #expect(announce.requestCount == 2)
        #expect(sockets.urls.map(\.absoluteString) == [
            "wss://relay.example.com/relay/tv",
            "wss://relay.example.com/relay/tv",
        ])
        client.disconnect()
    }

    // MARK: - At most one in-flight attempt, at most one live socket

    @Test func oneDropSignalledTwice_opensExactlyOneSocket() async {
        // A real drop signals TWICE within ~ms: `receiveLoop`'s `.failure`
        // branch and the delegate's `didCloseWith` both call
        // `scheduleReconnect()` (see the comment at that failure branch).
        // Both signals are driven here through the delegate entry point they
        // converge on. Two armed timers would mean two announces, two
        // single-use tickets spent, and the SAME device listed twice in the
        // dashboard under two identities — the feature's own output degrading.
        let announce = AnnounceSpy()
        let (client, _, sockets) = makeClient(sdkKey: "key", announce: announce)

        client.connect()
        #expect(await waitUntil { sockets.urls.count == 1 })

        simulateSocketClose(client, code: 4006)
        simulateSocketClose(client, code: 4006)

        // Backoff steps are 1s then 2s: wait past BOTH so a second armed timer
        // would have fired and been counted.
        try? await Task.sleep(nanoseconds: 2_600_000_000)

        #expect(sockets.urls.count == 2)     // one cold start + one reconnect
        #expect(announce.requestCount == 2)  // exactly one ticket spent per socket
        #expect(sockets.urls.map(\.absoluteString) == [
            "wss://relay.example.com/relay/tv/tkt_1",
            "wss://relay.example.com/relay/tv/tkt_2",
        ])
        client.disconnect()
    }

    @Test func overlappingConnectAttempts_openOnlyTheNewest() async {
        // The announce hop is up to 5s wide, so two attempts can genuinely be
        // in flight at once (host `connect()` racing a reconnect timer, or the
        // iOS didBecomeActive hook). The loser must drop — not open a second
        // socket, and not publish its already-dead display code.
        let announce = AnnounceSpy(delayNanos: 300_000_000)
        let (client, api, sockets) = makeClient(sdkKey: "key", announce: announce)

        client.connect()
        client.connect()

        #expect(await waitUntil { announce.requestCount == 2 })
        // Both announces resolve ~300ms in; give them well past that.
        try? await Task.sleep(nanoseconds: 900_000_000)

        // Both attempts really did announce — the race was real…
        #expect(announce.requestCount == 2)
        // …and exactly one of them reached the socket.
        #expect(sockets.urls.count == 1)
        // The surviving attempt's ticket and the published display code must
        // come from the SAME announce result: the loser opens no socket AND
        // publishes no code. Asserted as a pairing rather than a fixed ticket
        // number because which of two concurrent announces the spy numbers
        // first is not deterministic — only the pairing is a client invariant.
        let opened = sockets.urls.first?.absoluteString ?? ""
        #expect(opened.hasPrefix("wss://relay.example.com/relay/tv/tkt_"))
        let ticketNumber = opened.split(separator: "_").last.map(String.init) ?? "?"
        #expect(api.code == "CODE\(ticketNumber)")
        client.disconnect()
    }

    @Test func staleReconnectTimerCannotSupersedeAFreshConnectOrSwallowANewDrop() async {
        // A reconnect timer armed for one attempt must not act on a later one.
        // The host can reconnect by hand between arming and firing — on iOS the
        // `didBecomeActive` hook calls `connect()` for exactly this reason.
        let announce = AnnounceSpy()
        let (client, _, sockets) = makeClient(sdkKey: "key", announce: announce)

        client.connect()
        #expect(await waitUntil { sockets.urls.count == 1 })

        // A drop arms a 1s timer…
        simulateSocketClose(client, code: 4006)
        // …but the host reconnects first, superseding it.
        client.connect()
        #expect(await waitUntil { sockets.urls.count == 2 })

        // The stale timer must not fire into a healthy connection it knows
        // nothing about — that would cancel a working socket and spend another
        // single-use ticket to replace it.
        try? await Task.sleep(nanoseconds: 1_600_000_000)
        #expect(sockets.urls.count == 2)
        #expect(announce.requestCount == 2)

        // …and the dedup marker must not be left stuck: a genuine drop of the
        // NEW socket still has to be able to arm a timer of its own.
        let before = sockets.urls.count
        simulateSocketClose(client, code: 4006)
        #expect(await waitUntil(timeout: 6) { sockets.urls.count == before + 1 })
        client.disconnect()
    }

    // MARK: - Backgrounding must supersede the in-flight connect attempt
    //
    // `handleDidEnterBackground` / `handleWillEnterForeground` are the bodies
    // of the `UIApplication.didEnterBackgroundNotification` /
    // `willEnterForegroundNotification` hooks. They are compiled
    // unconditionally so this macOS slice — the widest one CI runs these suites
    // on — can drive them; the `@objc` selectors and `addObserver` calls stay
    // `#if canImport(UIKit)` (no tvOS exclusion any more). Calling the handlers
    // directly skips exactly one thing: NotificationCenter delivery, which is
    // what `CompanionLifecycleNotificationTests` covers on a real simulator.

    @Test func backgroundingDuringAnAnnounce_opensNoSocket() async {
        // THE defect. The announce is an awaited HTTP call in front of every
        // socket open, so at the moment the app backgrounds there is usually
        // no socket to cancel — only an attempt in flight. If backgrounding
        // does not supersede that attempt, its continuation passes every guard
        // and dials: the device stays listed in the dashboard and keeps
        // accepting capture requests with no UI behind it.
        let announce = AnnounceSpy(delayNanos: 400_000_000)
        let (client, api, sockets) = makeClient(sdkKey: "key", announce: announce)

        client.connect()
        // Anti-vacuity: the announce really is in flight before we background.
        #expect(await waitUntil { announce.requestCount == 1 })
        #expect(sockets.urls.isEmpty)

        client.handleDidEnterBackground()

        // Well past the 400ms announce and past the 1s first backoff step, so
        // a resurrection by either route would have been recorded.
        try? await Task.sleep(nanoseconds: 1_800_000_000)
        #expect(sockets.urls.isEmpty)
        // A losing attempt must not publish its already-dead display code either.
        #expect(api.code == nil)
        #expect(announce.requestCount == 1)
        client.disconnect()
    }

    @Test func foregroundingAfterBackgrounding_announcesAfreshAndOpensExactlyOne() async {
        // The complementary half. The superseded ticket is single-use with a
        // 60s TTL, so recovery must announce AGAIN — and exactly once: zero
        // leaves the device permanently invisible, two spends a ticket to list
        // one device twice.
        let announce = AnnounceSpy(delayNanos: 400_000_000)
        let (client, api, sockets) = makeClient(sdkKey: "key", announce: announce)

        client.connect()
        #expect(await waitUntil { announce.requestCount == 1 })
        client.handleDidEnterBackground()
        try? await Task.sleep(nanoseconds: 700_000_000)  // let the loser resolve
        #expect(sockets.urls.isEmpty)

        client.handleWillEnterForeground()

        #expect(await waitUntil(timeout: 5) { sockets.urls.count == 1 })
        #expect(announce.requestCount == 2)
        // A FRESH ticket — not the one the backgrounded attempt had minted.
        #expect(sockets.urls.first?.absoluteString
            == "wss://relay.example.com/relay/tv/tkt_2")
        #expect(api.code == "CODE2")

        // …and only one. Nothing else appears once the loser has resolved.
        try? await Task.sleep(nanoseconds: 1_200_000_000)
        #expect(sockets.urls.count == 1)
        #expect(announce.requestCount == 2)
        client.disconnect()
    }

    @Test func repeatedBackgroundForegroundCycles_leaveExactlyOneLiveAttempt() async {
        // Background→foreground→background in quick succession, twice: each
        // bounce must supersede the previous attempt and the final foreground
        // must still produce exactly one socket, from an announce of its own.
        let announce = AnnounceSpy(delayNanos: 300_000_000)
        let (client, _, sockets) = makeClient(sdkKey: "key", announce: announce)

        client.connect()
        #expect(await waitUntil { announce.requestCount == 1 })
        client.handleDidEnterBackground()
        client.handleWillEnterForeground()
        #expect(await waitUntil { announce.requestCount == 2 })
        client.handleDidEnterBackground()
        client.handleWillEnterForeground()
        #expect(await waitUntil { announce.requestCount == 3 })
        client.handleDidEnterBackground()

        // Every one of the three announces resolves during this window.
        try? await Task.sleep(nanoseconds: 1_800_000_000)
        #expect(sockets.urls.isEmpty)

        client.handleWillEnterForeground()
        #expect(await waitUntil(timeout: 5) { sockets.urls.count == 1 })
        #expect(announce.requestCount == 4)
        #expect(sockets.urls.first?.absoluteString
            == "wss://relay.example.com/relay/tv/tkt_4")
        try? await Task.sleep(nanoseconds: 1_200_000_000)
        #expect(sockets.urls.count == 1)
        client.disconnect()
    }

    @Test func connectWhileBackgrounded_opensNothingUntilForegrounded() async {
        // A host calling connect() is the one path into `beginConnect` that
        // the generation bump alone cannot stop — it claims a NEW generation,
        // so nothing is stale about it. `beginConnect` refuses outright while
        // backgrounded, and refusing must not wedge the client.
        let announce = AnnounceSpy()
        let (client, _, sockets) = makeClient(sdkKey: "key", announce: announce)

        client.handleDidEnterBackground()
        client.connect()

        try? await Task.sleep(nanoseconds: 400_000_000)
        #expect(sockets.urls.isEmpty)
        #expect(announce.requestCount == 0)  // not even an HTTP call

        client.handleWillEnterForeground()
        #expect(await waitUntil(timeout: 5) { sockets.urls.count == 1 })
        #expect(announce.requestCount == 1)
        client.disconnect()
    }

    @Test func aReconnectTimerArmedBeforeBackgrounding_doesNotFireWhileBackgrounded() async {
        // The second resurrection route, independent of the announce race: a
        // drop arms a 1s timer, the app backgrounds inside that second, and
        // the timer fires into `beginConnect()` with the app still away.
        let announce = AnnounceSpy()
        let (client, _, sockets) = makeClient(sdkKey: "key", announce: announce)

        client.connect()
        #expect(await waitUntil { sockets.urls.count == 1 })

        simulateSocketClose(client, code: 4006)  // arms the 1s backoff
        client.handleDidEnterBackground()

        // Past the 1s step the drop armed, and past the 2s one after it.
        try? await Task.sleep(nanoseconds: 2_400_000_000)
        #expect(sockets.urls.count == 1)
        #expect(announce.requestCount == 1)

        client.handleWillEnterForeground()
        #expect(await waitUntil(timeout: 5) { sockets.urls.count == 2 })
        #expect(announce.requestCount == 2)
        client.disconnect()
    }

    @Test func backgroundingCancelsTheLiveTaskWithoutArmingAReconnect() async throws {
        // Backgrounding cancels the installed socket, and that cancel comes
        // back as a close on a task the client no longer owns. Reading it as a
        // drop arms a timer that announces and connects while backgrounded —
        // so `handleDidEnterBackground` clears `currentTaskStamp` along with
        // `task`, which is what makes the callback identifiably stale.
        let server = try ParkedWebSocketServer()
        defer { server.stop() }
        let (client, _) = makeRealSocketClient(server: server)

        client.connect()
        let live = client.__currentTaskForTesting
        #expect(live != nil)

        let delays = UnsafeBox<[TimeInterval]>([])
        client.__scheduleReconnectHook = { delays.appendDelay($0) }

        client.handleDidEnterBackground()
        #expect(client.__currentTaskForTesting == nil)
        simulateSocketClose(client, code: 1001, task: live)

        // The cancel really did take effect — URLSession tears the task down
        // asynchronously, so this is polled rather than read straight away.
        #expect(await waitUntil(timeout: 5) {
            live?.state == .canceling || live?.state == .completed
        })
        // …and nothing read that teardown as a drop.
        #expect(delays.value.isEmpty)
        client.disconnect()
    }

    @Test func foregroundingAfterDisconnect_doesNotResurrectTheClient() async {
        // `stop()` racing the lifecycle: a host that disconnected must stay
        // disconnected, not come back the moment the user returns to the app.
        let announce = AnnounceSpy()
        let (client, _, sockets) = makeClient(sdkKey: "key", announce: announce)

        client.connect()
        #expect(await waitUntil { sockets.urls.count == 1 })
        client.disconnect()

        client.handleWillEnterForeground()

        try? await Task.sleep(nanoseconds: 600_000_000)
        #expect(sockets.urls.count == 1)
        #expect(announce.requestCount == 1)
    }

    @Test func deviceTokenReconnect_opensNoSocketWhileBackgrounded() async {
        // `connectWithDeviceToken` is the ONE path that installs a socket
        // without going through `beginConnect`, so `beginConnect`'s
        // `isBackgrounded` guard does not cover it. The generation check in
        // the reconnect timer is not a substitute: it releases the lock before
        // calling here, so backgrounding in that window leaves this path a
        // freshly claimed, perfectly current generation to dial on.
        //
        // That interleaving cannot be staged deterministically from outside
        // (there is no seam between the timer's unlock and this call), so the
        // test drives the entry point directly — which is why the POSITIVE
        // half is not optional: without it a green negative would only prove
        // the branch is dead, and it IS dead on this leg (the relay never
        // sends `device_token` to a TV). The pair together prove a live path
        // that refuses only because of the guard.
        let announce = AnnounceSpy()
        let (client, _, sockets) = makeClient(sdkKey: "key", announce: announce)

        client.connectWithDeviceToken("dev_tok_1")
        #expect(await waitUntil { sockets.urls.count == 1 })
        #expect(sockets.urls.first?.absoluteString
            == "wss://relay.example.com/relay/phone/reconnect/dev_tok_1")

        client.handleDidEnterBackground()
        client.connectWithDeviceToken("dev_tok_1")

        try? await Task.sleep(nanoseconds: 400_000_000)
        #expect(sockets.urls.count == 1)
        // …and it never announced either — this path deliberately skips that.
        #expect(announce.requestCount == 0)
        client.disconnect()
    }

    // MARK: - Already backgrounded when the host called connect()

    @Test func connectWhileTheProcessIsAlreadyInTheBackground_opensNoSocket() async {
        // `isBackgrounded` flips on a TRANSITION only, and a host that
        // connects from the background never produces one: `stopCompanion()`
        // drops the client and `startCompanion()` builds a FRESH
        // RelayWSClient whose flag initialises to false. Without the
        // application-state read in `connect()` this session would announce,
        // dial, and stay dialled until the next full background/foreground
        // cycle.
        //
        // `__readApplicationBackgroundState` stands in for the UIKit read that
        // `init` installs in production; that installation is
        // `#if canImport(UIKit)` and so absent from this macOS slice, but the
        // DECISION it feeds is compiled everywhere and is what this test
        // drives — including `connect()`'s call to it.
        let announce = AnnounceSpy(delayNanos: 300_000_000)
        let (client, api, sockets) = makeClient(sdkKey: "key", announce: announce)
        let backgrounded = UnsafeBox<Bool>(true)
        client.__readApplicationBackgroundState = { answer in answer(backgrounded.value) }

        client.connect()

        // Well past the announce and past the 1s first backoff step. Note what
        // is NOT claimed: the announce POST still goes out (the read is async,
        // so it lands after `beginConnect()` launched it). What must not
        // happen is a socket — a device is listed in the dashboard when it
        // opens one, not when it announces.
        try? await Task.sleep(nanoseconds: 1_600_000_000)
        #expect(sockets.urls.isEmpty)
        #expect(api.code == nil)

        // Not wedged: once the process really is in the foreground, the client
        // announces afresh and opens exactly one socket.
        backgrounded.set(false)
        client.handleWillEnterForeground()

        #expect(await waitUntil(timeout: 5) { sockets.urls.count == 1 })
        #expect(announce.requestCount == 2)
        try? await Task.sleep(nanoseconds: 800_000_000)
        #expect(sockets.urls.count == 1)
        client.disconnect()
    }

    @Test func connectWhileTheProcessIsForegrounded_connectsExactlyAsBefore() async {
        // The other side of the same branch: an active process must change
        // nothing at all, or the state read would have disabled companion for
        // every ordinary host.
        let announce = AnnounceSpy()
        let (client, api, sockets) = makeClient(sdkKey: "key", announce: announce)
        client.__readApplicationBackgroundState = { answer in answer(false) }

        client.connect()

        #expect(await waitUntil { sockets.urls.count == 1 })
        #expect(sockets.urls.first?.absoluteString
            == "wss://relay.example.com/relay/tv/tkt_1")
        #expect(api.code == "CODE1")
        client.disconnect()
    }

    // MARK: - Real installed sockets (no `__openSocketHook`)
    //
    // Every other test in this file routes socket creation through
    // `__openSocketHook`, which returns BEFORE `openSocket` installs the task —
    // so `task` stays nil throughout and the guards below are unobservable.
    // These tests let the real `openSocket` body run against a loopback
    // listener that accepts the TCP connection and never completes the
    // WebSocket upgrade (`ParkedWebSocketServer`), so the client installs a
    // REAL task that parks in `.running` and the only state changes are the
    // ones the test drives by hand.

    private func makeRealSocketClient(
        server: ParkedWebSocketServer,
        sdkKey: String? = nil,
        announce: AnnounceSpy? = nil
    ) -> (RelayWSClient, CompanionAPI) {
        let api = CompanionAPI()
        // With no sdkKey the ticketless path installs the socket synchronously.
        let client = RelayWSClient(
            endpoint: server.endpoint, companion: api,
            sdkKey: sdkKey, deviceLabel: nil,
            announceTransport: announce?.transport())
        return (client, api)
    }

    @Test func supersededTask_isCancelledRatherThanOrphaned() async throws {
        let server = try ParkedWebSocketServer()
        defer { server.stop() }
        let (client, _) = makeRealSocketClient(server: server)

        client.connect()
        let first = client.__currentTaskForTesting
        #expect(first != nil)
        #expect(first?.state == .running)

        // Drop the real installed task, then let the real 1s backoff timer run:
        // the reconnect installs a second task over the first.
        simulateSocketClose(client, code: 4006, task: first)
        // `!== first` alone is satisfied by the window in which the client owns
        // NO task: `beginConnect()` disowns the predecessor before it dials, so
        // between the cancel and the install `__currentTaskForTesting` is nil.
        // That window is the fix for the delayed-callback defect, not an
        // accident — so the wait has to be for the REPLACEMENT, not merely for
        // "not the old one".
        #expect(await waitUntil(timeout: 5) {
            let t = client.__currentTaskForTesting
            return t != nil && t !== first
        })

        let second = client.__currentTaskForTesting
        #expect(second != nil)
        // URLSession keeps a task alive that we merely stop referencing, so
        // overwriting without cancelling leaves a second live /relay/tv socket
        // — and a duplicate row for this device in the dashboard.
        #expect(first?.state == .canceling || first?.state == .completed)
        #expect(second?.state == .running)
        client.disconnect()
    }

    @Test func closeFromASupersededTask_isIgnoredWhileTheLiveTaskIsHandled() async throws {
        let server = try ParkedWebSocketServer()
        defer { server.stop() }
        let (client, api) = makeRealSocketClient(server: server)
        client.connect()
        let live = client.__currentTaskForTesting
        #expect(live != nil)
        api.__setPairUrl("https://relay.example.com/r/tok_1")
        api.__setState(.paired)

        let delays = UnsafeBox<[TimeInterval]>([])
        client.__scheduleReconnectHook = { delays.appendDelay($0) }

        // A close from a task we no longer own — precisely what our own
        // supersede-cancel inside `openSocket` delivers. Handling it would read
        // our own bookkeeping as a drop: it would scrub the pair state and
        // schedule a reconnect that cancels the socket just opened.
        // Same URL, different task object — one this client never installed.
        let superseded = URLSession.shared.webSocketTask(
            with: RelayWSClient.wsURLForTV(endpoint: server.endpoint))
        simulateSocketClose(client, code: 4002, task: superseded)

        #expect(delays.value.isEmpty)
        #expect(api.pairUrl == "https://relay.example.com/r/tok_1")
        #expect(api.state == .paired)

        // The guard must not be a blanket "ignore": a close from the task we DO
        // own is still handled exactly as before.
        simulateSocketClose(client, code: 4002, task: live)

        #expect(delays.value.count == 1)
        #expect(api.pairUrl == nil)
        #expect(api.state == .unpaired)
        client.disconnect()
    }

    @Test func closeFromThePredecessorDuringTheAnnounceWindow_isIgnored() async throws {
        // `connect()` cancels the live socket and then waits on the announce
        // hop — seconds, potentially — during which the client owns no task at
        // all. The cancelled predecessor's close callback lands inside exactly
        // that window. Reading it as a drop arms a reconnect under the NEW
        // generation, which the generation guard cannot catch (nothing bumped
        // it again), and that timer later cancels the socket this attempt
        // opened cleanly: a wasted single-use ticket and a healthy connection
        // dropped.
        let server = try ParkedWebSocketServer()
        defer { server.stop() }
        let announce = AnnounceSpy(delayNanos: 400_000_000)
        let (client, _) = makeRealSocketClient(server: server, sdkKey: "key", announce: announce)

        client.connect()
        #expect(await waitUntil { client.__currentTaskForTesting != nil })
        let predecessor = client.__currentTaskForTesting

        client.connect()  // cancels `predecessor`; no task installed for ~400ms
        simulateSocketClose(client, code: 4006, task: predecessor)

        // Past the announce hop AND past the 1s backoff a spurious reconnect
        // would have used.
        try? await Task.sleep(nanoseconds: 2_000_000_000)

        #expect(announce.requestCount == 2)  // no third ticket spent
        let live = client.__currentTaskForTesting
        #expect(live != nil)
        #expect(live !== predecessor)
        #expect(live?.state == .running)  // not cancelled out from under us
        client.disconnect()
    }

    @Test func closeFromThePredecessorDuringAReconnectAnnounceWindow_armsNothing() async throws {
        // The sibling above covers the `connect()` entry point, which clears
        // `task` AND `currentTaskStamp` before it hands off. The RECONNECT
        // entry point did not: `beginConnect()` bumped the generation and left
        // the predecessor named by `currentTaskStamp`, so for the whole
        // announce window `isCurrentTask` still said yes to it.
        //
        // That window is where the predecessor's SECOND drop signal lands. Every
        // drop signals twice ~ms apart (`receiveLoop`'s failure and the
        // delegate's `didCloseWith`); the first arms the timer that brings us
        // here, and the second arrives with the timer already fired. Accepted,
        // it arms another reconnect under the NEW generation — which nothing can
        // then catch, because that generation IS current — and that timer later
        // cancels the socket this attempt opened cleanly and announces again.
        // Reconnect churn, a spent single-use ticket, and a second dashboard row
        // for one device.
        let server = try ParkedWebSocketServer()
        defer { server.stop() }
        let announce = AnnounceSpy(delayNanos: 800_000_000)
        let (client, _) = makeRealSocketClient(server: server, sdkKey: "key", announce: announce)

        client.connect()
        #expect(await waitUntil(timeout: 5) { client.__currentTaskForTesting != nil })
        let predecessor = client.__currentTaskForTesting

        // Drop it. This arms the real 1 s backoff timer, whose firing is what
        // takes `beginConnect()` — and only that path.
        simulateSocketClose(client, code: 4006, task: predecessor)
        // The second announce request IS the timer having fired: the client is
        // now inside the announce window, owning no task.
        #expect(await waitUntil(timeout: 5) { announce.requestCount == 2 })
        #expect(client.__currentTaskForTesting == nil)

        // Arming is observed directly rather than waited out — the property is
        // "a superseded attempt's callbacks can no longer arm anything", and
        // the hook makes that the assertion instead of a sleep long enough to
        // notice the churn.
        let delays = UnsafeBox<[TimeInterval]>([])
        client.__scheduleReconnectHook = { delays.appendDelay($0) }

        simulateSocketClose(client, code: 4006, task: predecessor)
        #expect(delays.value.isEmpty)

        // Not a blanket ignore: once the attempt installs its own socket, THAT
        // socket's close is handled exactly as before.
        #expect(await waitUntil(timeout: 5) { client.__currentTaskForTesting != nil })
        let live = client.__currentTaskForTesting
        #expect(live !== predecessor)
        simulateSocketClose(client, code: 4006, task: live)
        #expect(delays.value.count == 1)

        client.disconnect()
    }

    // (The no-orphan half of the same disown — the predecessor must be
    // CANCELLED, not merely dereferenced — is already covered by
    // `supersededTask_isCancelledRatherThanOrphaned` above, which drives the
    // identical reconnect path and asserts on the predecessor's task state.
    // Moving the cancel from `openSocket` into `beginConnect` keeps that green
    // by doing the cancelling, and it goes red if the disown ever drops the
    // reference without one.)

    // MARK: - pair.bonded companion fields

    private func makeFrameClient() -> (RelayWSClient, CompanionAPI) {
        let api = CompanionAPI()
        let client = RelayWSClient(
            endpoint: Self.endpoint, companion: api,
            sdkKey: nil, deviceLabel: nil, announceTransport: nil)
        return (client, api)
    }

    @Test func pairBonded_withCompanionFields_setsAttachedUserNameAndToken() {
        let (client, api) = makeFrameClient()

        client.handleControl(#"""
        {"type":"pair.bonded","pair_id":"p","attribution_token":"attr_1","companion_user":{"display_name":"Ada L.","email":"ada@example.com"}}
        """#)

        #expect(api.state == .paired)
        #expect(api.attachedUserName == "Ada L.")
        #expect(client.getCompanionAttribution() == "attr_1")
    }

    @Test func pairBonded_withoutCompanionFields_resetsBothToNil() {
        // An ordinary QR bond carries neither field. A later bond on the same
        // session must NOT inherit the previous dashboard attach's identity.
        let (client, api) = makeFrameClient()
        client.handleControl(#"""
        {"type":"pair.bonded","pair_id":"p","attribution_token":"attr_1","companion_user":{"display_name":"Ada L."}}
        """#)
        #expect(api.attachedUserName == "Ada L.")
        #expect(client.getCompanionAttribution() == "attr_1")

        client.handleControl(#"{"type":"pair.bonded","pair_id":"p2"}"#)

        #expect(api.attachedUserName == nil)
        #expect(client.getCompanionAttribution() == nil)
        #expect(api.state == .paired)
    }

    // MARK: - report.request attribution refresh

    @Test func reportRequest_withToken_overwritesTheBondTimeToken() {
        let (client, _) = makeFrameClient()
        client.handleControl(#"""
        {"type":"pair.bonded","pair_id":"p","attribution_token":"attr_bond"}
        """#)

        client.handleControl(#"""
        {"type":"report.request","correlation_id":"c1","attribution_token":"attr_fresh"}
        """#)

        #expect(client.getCompanionAttribution() == "attr_fresh")
    }

    @Test func reportRequest_withoutToken_leavesTheExistingTokenIntact() {
        // Older relay, or a request frame that simply doesn't carry one.
        let (client, api) = makeFrameClient()
        client.handleControl(#"""
        {"type":"pair.bonded","pair_id":"p","attribution_token":"attr_bond"}
        """#)

        client.handleControl(#"{"type":"report.request","correlation_id":"c1"}"#)

        #expect(client.getCompanionAttribution() == "attr_bond")
        #expect(api.state == .reportInProgress)
    }

    @Test func reportRequest_onAnOrdinaryPair_leavesAttributionNil() {
        let (client, _) = makeFrameClient()
        client.handleControl(#"{"type":"pair.bonded","pair_id":"p"}"#)

        client.handleControl(#"{"type":"report.request","correlation_id":"c1"}"#)

        #expect(client.getCompanionAttribution() == nil)
    }

    // MARK: - Serial-report invariant: one report at a time per pair
    //
    // Android has enforced this since its `is ReportRequest` branch was
    // written; iOS accepted overlapping requests unconditionally. The damage is
    // not theoretical: `.reportInProgress` is what freezes the shared
    // replay/breadcrumb snapshot, so a second request re-freezes it under the
    // first report's composer, and whichever report finishes first flips the
    // pair to `.paired` — cancelling the other one's "in progress" UI while it
    // is still running.

    /// Every frame the client tried to put on the wire, in order.
    private func recordSends(_ client: RelayWSClient) -> UnsafeBox<[RelayMessage]> {
        let sent = UnsafeBox<[RelayMessage]>([])
        client.__sendHook = { sent.appendMessage($0) }
        return sent
    }

    /// Correlation ids the capture bridge was asked to start work for.
    ///
    /// Scoped to ONE client, because `.traceItXCompanionReportRequested` is a
    /// process-wide broadcast and suites run in parallel with each other
    /// (`.serialized` orders this suite internally and nothing more). An
    /// unscoped observer picks up the requests another suite's client is
    /// driving at the same moment, which shows up as an extra correlation_id in
    /// the recorded list — a flake, not a finding.
    private func observeReportRequested(
        for client: RelayWSClient
    ) -> (UnsafeBox<[String?]>, NSObjectProtocol) {
        let seen = UnsafeBox<[String?]>([])
        let token = NotificationCenter.default.addObserver(
            forName: .traceItXCompanionReportRequested, object: client, queue: nil
        ) { note in
            seen.append(note.userInfo?["correlation_id"] as? String)
        }
        return (seen, token)
    }

    @Test func secondReportRequestWhileOneIsInFlight_isRejectedAndChangesNothing() {
        let (client, api) = makeFrameClient()
        let sent = recordSends(client)
        let (requested, token) = observeReportRequested(for: client)
        defer { NotificationCenter.default.removeObserver(token) }

        client.handleControl(#"""
        {"type":"pair.bonded","pair_id":"p","attribution_token":"attr_bond"}
        """#)
        client.handleControl(#"""
        {"type":"report.request","correlation_id":"c1","attribution_token":"attr_c1"}
        """#)
        // Anti-vacuity: the FIRST request really was accepted, so what follows
        // is measuring the guard and not a client that ignores every request.
        #expect(api.state == .reportInProgress)
        #expect(client.getCompanionAttribution() == "attr_c1")
        #expect(requested.value == ["c1"])
        #expect(sent.value.isEmpty)

        client.handleControl(#"""
        {"type":"report.request","correlation_id":"c2","attribution_token":"attr_c2"}
        """#)

        // Nothing about the in-flight report may move.
        #expect(api.state == .reportInProgress)
        #expect(requested.value == ["c1"])
        // The token belongs to the report it was minted for. `attr_c2` was
        // minted for a report that will never run; storing it would leave the
        // session holding a single-use credential that the NEXT request (one
        // that carries none, i.e. an older relay) would fall back to and spend
        // on the wrong report.
        #expect(client.getCompanionAttribution() == "attr_c1")
        // …and the phone is told, rather than left waiting on a report the TV
        // silently declined to start.
        #expect(sent.value.count == 1)
        guard case .reportRejected(let rejected)? = sent.value.first else {
            Issue.record("expected a report.rejected frame, got \(sent.value)")
            return
        }
        #expect(rejected.correlationId == "c2")
        #expect(rejected.reason == "in_flight")
        #expect(rejected.type == "report.rejected")
    }

    @Test func reportRequestAfterTheFirstOneFinishes_isAcceptedNormally() {
        // The guard must be a STATE read, not a latch: once the pair is back to
        // `.paired` the next request is an ordinary one. Without this, a fix
        // that simply refused every request after the first would pass the test
        // above and disable companion reporting after a single report.
        let (client, api) = makeFrameClient()
        let sent = recordSends(client)
        let (requested, token) = observeReportRequested(for: client)
        defer { NotificationCenter.default.removeObserver(token) }

        client.handleControl(#"{"type":"pair.bonded","pair_id":"p"}"#)
        client.handleControl(#"""
        {"type":"report.request","correlation_id":"c1","attribution_token":"attr_c1"}
        """#)
        client.handleControl(#"""
        {"type":"report.completed","correlation_id":"c1","event_id":"evt_1"}
        """#)
        #expect(api.state == .paired)

        client.handleControl(#"""
        {"type":"report.request","correlation_id":"c2","attribution_token":"attr_c2"}
        """#)

        #expect(api.state == .reportInProgress)
        #expect(requested.value == ["c1", "c2"])
        #expect(client.getCompanionAttribution() == "attr_c2")
        #expect(sent.value.isEmpty)
    }

    // MARK: - A completion ends only ITS OWN report (PR-fix 7)
    //
    // The serial-report guard above rejects an overlapping request while one is
    // in flight. It does NOT cover the case that produced this finding, because
    // there the overlap is legal: re-bonding sets the shared state back to
    // `.paired`, so the new user's request is accepted exactly as intended. The
    // damage came from the OTHER end — the older report's terminal frame, which
    // flipped the pair to `.paired` unconditionally and so cleared a report
    // that was still running. A third request was then accepted over the
    // second, re-freezing the replay/breadcrumb snapshot its composer was about
    // to consume.

    @Test func aStaleCompletionFromASupersededBond_doesNotEndTheLiveReport() {
        let (client, api) = makeFrameClient()
        let sent = recordSends(client)
        let (requested, token) = observeReportRequested(for: client)
        defer { NotificationCenter.default.removeObserver(token) }

        // User A attaches and starts a report.
        client.handleControl(#"""
        {"type":"pair.bonded","pair_id":"p","attribution_token":"attr_a"}
        """#)
        client.handleControl(#"""
        {"type":"report.request","correlation_id":"c1","attribution_token":"attr_c1"}
        """#)
        #expect(api.state == .reportInProgress)
        #expect(api.__reportInProgressCorrelationIdForTesting() == "c1")

        // A's upload is still running when the pair is released and user B
        // attaches: the relay force-closes only the phone leg, so this same
        // client gets a fresh `pair.bonded` and the state legitimately returns
        // to `.paired`. B then starts their own report, which is accepted.
        client.handleControl(#"""
        {"type":"pair.bonded","pair_id":"p","attribution_token":"attr_b"}
        """#)
        #expect(api.state == .paired)
        client.handleControl(#"""
        {"type":"report.request","correlation_id":"c2","attribution_token":"attr_c2"}
        """#)
        // Anti-vacuity: B's report really is the live one now, so what follows
        // measures the guard rather than a client that ignored B.
        #expect(api.state == .reportInProgress)
        #expect(api.__reportInProgressCorrelationIdForTesting() == "c2")
        #expect(requested.value == ["c1", "c2"])

        // NOW A's report finishes.
        client.handleControl(#"""
        {"type":"report.completed","correlation_id":"c1","event_id":"evt_1"}
        """#)

        #expect(api.state == .reportInProgress)
        #expect(api.__reportInProgressCorrelationIdForTesting() == "c2")
        // …so a third request is still refused, which is the damage the
        // unconditional flip caused: it re-freezes shared capture state under
        // c2's composer.
        client.handleControl(#"""
        {"type":"report.request","correlation_id":"c3","attribution_token":"attr_c3"}
        """#)
        #expect(requested.value == ["c1", "c2"])
        guard case .reportRejected(let rejected)? = sent.value.last else {
            Issue.record("expected c3 to be rejected, got \(sent.value)")
            return
        }
        #expect(rejected.correlationId == "c3")

        // The guard is not a blanket refusal: c2's OWN completion ends it.
        client.handleControl(#"""
        {"type":"report.completed","correlation_id":"c2","event_id":"evt_2"}
        """#)
        #expect(api.state == .paired)
        #expect(api.__reportInProgressCorrelationIdForTesting() == nil)
    }

    @Test func aStaleFailureFromASupersededBond_doesNotEndTheLiveReport() {
        // A stale FAILURE clearing a live report is the same bug as a stale
        // completion — the branch is separate, so it gets its own case.
        let (client, api) = makeFrameClient()

        client.handleControl(#"{"type":"pair.bonded","pair_id":"p"}"#)
        client.handleControl(#"{"type":"report.request","correlation_id":"c1"}"#)
        client.handleControl(#"{"type":"pair.bonded","pair_id":"p"}"#)
        client.handleControl(#"{"type":"report.request","correlation_id":"c2"}"#)
        #expect(api.__reportInProgressCorrelationIdForTesting() == "c2")

        client.handleControl(#"""
        {"type":"report.failed","correlation_id":"c1","reason":"ingest_error"}
        """#)

        #expect(api.state == .reportInProgress)

        client.handleControl(#"""
        {"type":"report.failed","correlation_id":"c2","reason":"ingest_error"}
        """#)
        #expect(api.state == .paired)
    }

    @Test func aStaleCancelFromASupersededBond_doesNotEndTheLiveReport() async {
        // Same shape on the phone-side Discard branch. That one also discards
        // the frozen replay snapshot, which by now belongs to the LIVE report —
        // so the state assertion here stands in for both halves, which the fix
        // keeps inside one ownership claim.
        let (client, api) = makeFrameClient()

        client.handleControl(#"{"type":"pair.bonded","pair_id":"p"}"#)
        client.handleControl(#"{"type":"report.request","correlation_id":"c1"}"#)
        client.handleControl(#"{"type":"pair.bonded","pair_id":"p"}"#)
        client.handleControl(#"{"type":"report.request","correlation_id":"c2"}"#)

        client.handleControl(#"{"type":"report.cancelled","correlation_id":"c1"}"#)
        // The cancel branch hops to @MainActor, so give it a moment to land.
        try? await Task.sleep(nanoseconds: 200_000_000)
        #expect(api.state == .reportInProgress)
        #expect(api.__reportInProgressCorrelationIdForTesting() == "c2")

        client.handleControl(#"{"type":"report.cancelled","correlation_id":"c2"}"#)
        #expect(await waitUntil(timeout: 3) { api.state == .paired })
    }

    // MARK: - Mid-session re-issue: pair.expired → pair.created

    @Test func pairExpiredThenCreated_leavesALivePairUrl() async {
        // Release rotates the pair token: `pair.expired` (released, NOT dead)
        // followed by a fresh `pair.created` on the SAME socket. The host must
        // end up showing a live QR, never none.
        let (client, api) = makeFrameClient()
        client.handleControl(#"{"type":"pair.created","pair_id":"p","pair_token":"tok_1"}"#)
        client.handleControl(#"{"type":"pair.bonded","pair_id":"p"}"#)

        client.handleControl(#"{"type":"pair.expired","pair_id":"p","reason":"inactivity"}"#)
        #expect(api.pairUrl == "https://relay.example.com/r/tok_1")

        client.handleControl(#"{"type":"pair.created","pair_id":"p2","pair_token":"tok_2"}"#)

        #expect(api.pairUrl == "https://relay.example.com/r/tok_2")
        #expect(api.state == .unpaired)
    }

    // MARK: - External review, finding N2: attach state clears on
    // detach/reconnect, parity with the web ws-client's three
    // attachedUserName-clearing boundaries (pair.created, pair.expired,
    // client teardown).

    @Test func pairExpired_afterAnAttributedBond_clearsAttachedUserName() {
        let (client, api) = makeFrameClient()
        client.handleControl(#"""
        {"type":"pair.bonded","pair_id":"p","attribution_token":"attr_1","companion_user":{"display_name":"Ada L."}}
        """#)
        #expect(api.attachedUserName == "Ada L.")

        client.handleControl(#"{"type":"pair.expired","pair_id":"p","reason":"inactivity"}"#)

        #expect(api.attachedUserName == nil)
    }

    @Test func pairCreated_afterAnAttributedBond_clearsAttachedUserName() {
        // Simulates a reconnect on the same socket: a fresh `pair.created`
        // is by construction unbonded, so any attach state a previous bond
        // left behind is stale and must not survive it.
        let (client, api) = makeFrameClient()
        client.handleControl(#"""
        {"type":"pair.bonded","pair_id":"p","attribution_token":"attr_1","companion_user":{"display_name":"Ada L."}}
        """#)
        #expect(api.attachedUserName == "Ada L.")

        client.handleControl(#"{"type":"pair.created","pair_id":"p2","pair_token":"tok_2"}"#)

        #expect(api.attachedUserName == nil)
    }

    @Test func disconnect_afterAnAttributedBond_clearsAttachedUserName() {
        let (client, api) = makeFrameClient()
        client.handleControl(#"""
        {"type":"pair.bonded","pair_id":"p","attribution_token":"attr_1","companion_user":{"display_name":"Ada L."}}
        """#)
        #expect(api.attachedUserName == "Ada L.")

        client.disconnect()

        #expect(api.attachedUserName == nil)
    }

    // MARK: - Terminal close clears the companion surface

    @Test func terminalClose_clearsCodeAttachedUserNameAndAttribution() async {
        let announce = AnnounceSpy()
        let (client, api, sockets) = makeClient(sdkKey: "key", announce: announce)
        client.connect()
        #expect(await waitUntil { sockets.urls.count == 1 })
        client.handleControl(#"""
        {"type":"pair.bonded","pair_id":"p","attribution_token":"attr_1","companion_user":{"display_name":"Ada L."}}
        """#)
        #expect(api.code == "CODE1")

        simulateSocketClose(client, code: 4002)

        #expect(api.pairUrl == nil)
        #expect(api.code == nil)
        #expect(api.attachedUserName == nil)
        #expect(client.getCompanionAttribution() == nil)
        client.disconnect()
    }

    // MARK: - Notification surface (Task 20 forwards these over the RN bridge)

    @Test func codeAndAttachedUserName_postNotificationsOnEveryFlip() async {
        let api = CompanionAPI()
        let codes = UnsafeBox<[String?]>([])
        let names = UnsafeBox<[String?]>([])
        let codeToken = NotificationCenter.default.addObserver(
            forName: .traceItXCompanionCodeChange, object: api, queue: nil
        ) { note in codes.append(note.userInfo?["code"] as? String) }
        let nameToken = NotificationCenter.default.addObserver(
            forName: .traceItXCompanionAttachedUserNameChange, object: api, queue: nil
        ) { note in names.append(note.userInfo?["attachedUserName"] as? String) }
        defer {
            NotificationCenter.default.removeObserver(codeToken)
            NotificationCenter.default.removeObserver(nameToken)
        }

        api.__setCode("AB12")
        api.__setCode("AB12")   // no-op write — must NOT re-post
        api.__setCode(nil)
        api.__setAttachedUserName("Ada L.")
        api.__setAttachedUserName(nil)

        #expect(codes.value == ["AB12", nil])
        #expect(names.value == ["Ada L.", nil])
    }
}

/// A loopback TCP listener that accepts connections and then answers nothing:
/// a `URLSessionWebSocketTask` pointed at it finishes its TCP connect, sends the
/// HTTP upgrade request, and parks in `.running` waiting for a 101 that never
/// arrives. That gives the tests a REAL installed task with no timing noise —
/// no receive callback, no delegate callback — so the only state changes are
/// the ones they drive by hand.
///
/// This replaces an earlier unroutable-IP (TEST-NET-1) trick whose outcome
/// depended on the surrounding network: a network that RSTs or returns ICMP
/// unreachable — corporate networks and VPNs routinely do — flips the task
/// straight to `.completed` and destroys the precondition. Nothing here leaves
/// the machine.
/// Plain POSIX sockets rather than `NWListener`: inside the `xctest` host
/// process `NWListener` fails to bind at all — `failed(POSIXErrorCode(rawValue:
/// 22): Invalid argument)`, port 0 — while `socket`/`bind`/`listen` on
/// 127.0.0.1 succeeds there. Measured, not assumed.
private final class ParkedWebSocketServer: @unchecked Sendable {
    enum Failure: Error {
        case socketFailed(Int32)
        case bindFailed(Int32)
        case listenFailed(Int32)
        case portUnavailable(Int32)
    }

    private let listenFD: Int32
    private let lock = NSLock()
    private var acceptedFDs: [Int32] = []
    private var stopped = false

    /// `http://127.0.0.1:<port>` — `RelayWSClient` maps http → ws.
    let endpoint: URL

    init() throws {
        // Kept in a local through the whole initializer: the pointer closures
        // below would otherwise capture `self` before `endpoint` is assigned.
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        listenFD = fd
        guard fd >= 0 else { throw Failure.socketFailed(errno) }

        var reuse: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR,
                   &reuse, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0  // ephemeral — never collides with a parallel test
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let didBind = withUnsafePointer(to: &addr) { raw in
            raw.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard didBind == 0 else {
            let err = errno; close(fd); throw Failure.bindFailed(err)
        }
        guard listen(fd, 8) == 0 else {
            let err = errno; close(fd); throw Failure.listenFailed(err)
        }

        var bound = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let didRead = withUnsafeMutablePointer(to: &bound) { raw in
            raw.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                getsockname(fd, $0, &length)
            }
        }
        guard didRead == 0 else {
            let err = errno; close(fd); throw Failure.portUnavailable(err)
        }
        endpoint = URL(string: "http://127.0.0.1:\(UInt16(bigEndian: bound.sin_port))")!

        // Accept and HOLD every connection, writing nothing back: closing it
        // would fail the client's task instead of parking it.
        Thread.detachNewThread { [self] in acceptLoop() }
    }

    private func acceptLoop() {
        while true {
            let fd = accept(listenFD, nil, nil)
            if fd < 0 {
                if errno == EINTR { continue }
                return  // listening socket closed by stop() — we're done
            }
            lock.lock()
            if stopped {
                lock.unlock(); close(fd); return
            }
            acceptedFDs.append(fd)
            lock.unlock()
        }
    }

    func stop() {
        lock.lock()
        if stopped { lock.unlock(); return }
        stopped = true
        let open = acceptedFDs
        acceptedFDs = []
        lock.unlock()
        close(listenFD)  // unblocks acceptLoop
        for fd in open { close(fd) }
    }
}

/// Tiny mutable box for notification observers (the closures escape).
private final class UnsafeBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var _value: T
    init(_ value: T) { _value = value }
    var value: T {
        lock.lock(); defer { lock.unlock() }
        return _value
    }
}

private extension UnsafeBox where T == [String?] {
    func append(_ element: String?) {
        lock.lock(); _value.append(element); lock.unlock()
    }
}

private extension UnsafeBox where T == [RelayMessage] {
    func appendMessage(_ element: RelayMessage) {
        lock.lock(); _value.append(element); lock.unlock()
    }
}

private extension UnsafeBox where T == [TimeInterval] {
    func appendDelay(_ element: TimeInterval) {
        lock.lock(); _value.append(element); lock.unlock()
    }
}

private extension UnsafeBox where T == Bool {
    func set(_ newValue: Bool) {
        lock.lock(); _value = newValue; lock.unlock()
    }
}
