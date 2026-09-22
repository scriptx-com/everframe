// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Attach-PIN challenge surface (spec 2026-08-19): `RelayWSClient.handleControl`
// on `attach.challenge` / `attach.challenge.cleared`, terminal-close cleanup,
// and the `supportsAttachPin` announce capability rule. Follows
// `RelayWSClientCompanionTests.swift`'s harness — frames fed straight into
// `handleControl(_:)` on a client built with test seams, no real network or
// socket.
import Testing
import Foundation

import TraceItXProtocol
@testable import TraceItXKit

@Suite(.serialized)
final class CompanionAttachChallengeTests {

    private static let endpoint = URL(string: "https://relay.example.com")!

    /// A plain client with no SDK key — same shape as
    /// `RelayWSClientCompanionTests.makeFrameClient()` — for driving
    /// `handleControl(_:)` directly with no announce/socket traffic at all.
    private func makeFrameClient(attachPinUi: AttachPinUi = .builtin) -> (RelayWSClient, CompanionAPI) {
        let api = CompanionAPI()
        let client = RelayWSClient(
            endpoint: Self.endpoint, companion: api,
            sdkKey: nil, deviceLabel: nil, attachPinUi: attachPinUi,
            announceTransport: nil)
        return (client, api)
    }

    /// Drives the real `didCloseWith` delegate entry point, mirroring
    /// `RelayWSClientCompanionTests.simulateSocketClose`.
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

    // MARK: - Case 1: attach.challenge sets the property + posts a notification

    @Test func attachChallenge_setsPropertyAndPostsNotification() {
        let (client, api) = makeFrameClient()

        var posted: Notification?
        let observer = NotificationCenter.default.addObserver(
            forName: .traceItXCompanionAttachChallengeChange, object: api, queue: nil
        ) { note in posted = note }
        defer { NotificationCenter.default.removeObserver(observer) }

        client.handleControl(#"""
        {"type":"attach.challenge","code":"0427","ttl_ms":60000,"requested_by_name":"Aurimas"}
        """#)

        #expect(api.attachChallenge == CompanionAttachChallenge(
            code: "0427", requestedByName: "Aurimas", ttlMs: 60000))
        #expect(posted != nil)
        #expect(posted?.userInfo?["code"] as? String == "0427")
        #expect(posted?.userInfo?["requestedByName"] as? String == "Aurimas")
        #expect(posted?.userInfo?["ttlMs"] as? Int == 60000)
    }

    // MARK: - Case 2: attach.challenge.cleared clears the property

    @Test func attachChallengeCleared_clearsProperty() {
        let (client, api) = makeFrameClient()
        client.handleControl(#"""
        {"type":"attach.challenge","code":"0427","ttl_ms":60000,"requested_by_name":"Aurimas"}
        """#)
        #expect(api.attachChallenge != nil)

        client.handleControl(#"{"type":"attach.challenge.cleared","reason":"attached"}"#)

        #expect(api.attachChallenge == nil)
    }

    // MARK: - Case 3: a terminal close clears the challenge

    @Test func terminalClose_clearsAttachChallenge() {
        let (client, api) = makeFrameClient()
        client.handleControl(#"""
        {"type":"attach.challenge","code":"9911","ttl_ms":60000,"requested_by_name":"Priya"}
        """#)
        #expect(api.attachChallenge != nil)

        // 4002 = pair_expired, one of the terminal codes that resets the pair.
        simulateSocketClose(client, code: 4002)

        #expect(api.attachChallenge == nil)
    }

    // MARK: - Case 3b: a NON-terminal close also clears the challenge (review finding 2)

    @Test func nonTerminalClose_clearsAttachChallenge() {
        let (client, api) = makeFrameClient()
        client.handleControl(#"""
        {"type":"attach.challenge","code":"9911","ttl_ms":60000,"requested_by_name":"Priya"}
        """#)
        #expect(api.attachChallenge != nil)

        // 4006 = malformed_frame — transient, `didCloseWith`'s `default`
        // branch (not the terminal 4001..4004 branch). The server still
        // deleted the pair on this TV-socket close, so no
        // `attach.challenge.cleared` frame can ever arrive for it — the
        // challenge must clear immediately rather than wait for a terminal
        // code or the reconnect-budget to exhaust.
        simulateSocketClose(client, code: 4006)

        #expect(api.attachChallenge == nil)
    }

    // MARK: - Case 3c: disconnect() also clears the challenge (review finding 2)

    @Test func disconnect_clearsAttachChallenge() {
        let (client, api) = makeFrameClient()
        client.handleControl(#"""
        {"type":"attach.challenge","code":"0427","ttl_ms":60000,"requested_by_name":"Aurimas"}
        """#)
        #expect(api.attachChallenge != nil)

        client.disconnect()

        #expect(api.attachChallenge == nil)
    }

    // MARK: - Case 4: supportsAttachPin announce capability

    /// Records every request the announcer makes and replies with a canned
    /// (status, body) pair — same shape as `RelayWSClientCompanionTests`'s
    /// `AnnounceSpy`, trimmed to just what the capability assertions need.
    private final class AnnounceSpy: @unchecked Sendable {
        private let lock = NSLock()
        private var _requests: [URLRequest] = []
        var requests: [URLRequest] {
            lock.lock(); defer { lock.unlock() }
            return _requests
        }
        func transport() -> AnnounceTransport {
            return { [self] request in
                lock.lock(); _requests.append(request); lock.unlock()
                let body = Data(#"{"ticket":"tkt_1","code":"CODE1"}"#.utf8)
                let response = HTTPURLResponse(
                    url: request.url!, statusCode: 200,
                    httpVersion: "HTTP/1.1", headerFields: nil)!
                return (body, response)
            }
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

    private func makeCapabilityClient(
        attachPinUi: AttachPinUi,
        builtinPinUiInstalled: Bool,
        announce: AnnounceSpy
    ) -> (RelayWSClient, CompanionAPI) {
        let api = CompanionAPI()
        api.__builtinPinUiInstalled = builtinPinUiInstalled
        let client = RelayWSClient(
            endpoint: Self.endpoint, companion: api,
            sdkKey: "key", deviceLabel: nil, attachPinUi: attachPinUi,
            announceTransport: announce.transport())
        // No real socket traffic — the assertions only need the announce body.
        client.__openSocketHook = { _ in }
        // Deterministic "no device" — these tests assert the exact
        // `supportsAttachPin` body bytes, not anything about the naming-spec
        // `device` block, and real resolution touches Keychain (availability
        // genuinely varies by host — see `__deviceResolverOverride`'s doc).
        client.__deviceResolverOverride = { nil }
        return (client, api)
    }

    @Test func capability_custom_alwaysAnnouncesTrue() async {
        let announce = AnnounceSpy()
        // `api` MUST stay bound here — RelayWSClient holds it only via a
        // `weak var companion`, so discarding it with `_` lets ARC free it
        // before `connect()`'s announce Task reads `__builtinPinUiInstalled`,
        // silently collapsing every one of these cases to "companion is nil".
        let (client, api) = makeCapabilityClient(
            attachPinUi: .custom, builtinPinUiInstalled: false, announce: announce)

        client.connect()

        #expect(await waitUntil { announce.requests.count == 1 })
        #expect(announce.requests.first?.httpBody == Data(#"{"supportsAttachPin":true}"#.utf8))
        client.disconnect()
        // `api` must stay referenced through here — not just bound at the top
        // — see the comment on the binding above for why the weak-companion
        // pointer makes early release a real risk, not a style nit.
        withExtendedLifetime(api) {}
    }

    @Test func capability_builtin_withoutInstalledPresenter_announcesFalse() async {
        let announce = AnnounceSpy()
        // `api` MUST stay bound here — RelayWSClient holds it only via a
        // `weak var companion`, so discarding it with `_` lets ARC free it
        // before `connect()`'s announce Task reads `__builtinPinUiInstalled`,
        // silently collapsing every one of these cases to "companion is nil".
        let (client, api) = makeCapabilityClient(
            attachPinUi: .builtin, builtinPinUiInstalled: false, announce: announce)

        client.connect()

        #expect(await waitUntil { announce.requests.count == 1 })
        #expect(announce.requests.first?.httpBody == Data("{}".utf8))
        client.disconnect()
        withExtendedLifetime(api) {}
    }

    @Test func capability_builtin_withInstalledPresenter_announcesTrue() async {
        let announce = AnnounceSpy()
        // `api` MUST stay bound here — RelayWSClient holds it only via a
        // `weak var companion`, so discarding it with `_` lets ARC free it
        // before `connect()`'s announce Task reads `__builtinPinUiInstalled`,
        // silently collapsing every one of these cases to "companion is nil".
        let (client, api) = makeCapabilityClient(
            attachPinUi: .builtin, builtinPinUiInstalled: true, announce: announce)

        client.connect()

        #expect(await waitUntil { announce.requests.count == 1 })
        #expect(announce.requests.first?.httpBody == Data(#"{"supportsAttachPin":true}"#.utf8))
        client.disconnect()
        withExtendedLifetime(api) {}
    }

    @Test func capability_off_alwaysAnnouncesFalse() async {
        let announce = AnnounceSpy()
        // `api` MUST stay bound here — RelayWSClient holds it only via a
        // `weak var companion`, so discarding it with `_` lets ARC free it
        // before `connect()`'s announce Task reads `__builtinPinUiInstalled`,
        // silently collapsing every one of these cases to "companion is nil".
        let (client, api) = makeCapabilityClient(
            attachPinUi: .off, builtinPinUiInstalled: true, announce: announce)

        client.connect()

        #expect(await waitUntil { announce.requests.count == 1 })
        #expect(announce.requests.first?.httpBody == Data("{}".utf8))
        client.disconnect()
        withExtendedLifetime(api) {}
        client.disconnect()
    }

    // MARK: - Case 5: CompanionAttachChallenge.remainingMs deadline arithmetic
    //
    // Round-2 review finding 3: `CompanionPinPresenter` (TraceItXReporterUI)
    // must re-present a challenge on app activation using time REMAINING
    // until an absolute deadline, never the original ttlMs. The presenter
    // itself is UIKit-bound (owns a real UIWindow + UIApplication scene
    // lookup) and out of reach from this target (TraceItXTests only depends
    // on TraceItXKit/TraceItXProtocol — see Package.swift), so the pure
    // deadline math lives on `CompanionAttachChallenge` in TraceItXKit
    // instead, where it's directly testable and the presenter just calls it.

    @Test func remainingMs_beforeDeadline_returnsWholeRemainder() {
        let now = Date(timeIntervalSince1970: 1_000)
        let deadline = now.addingTimeInterval(55) // e.g. a 60s challenge, 5s elapsed
        #expect(CompanionAttachChallenge.remainingMs(deadline: deadline, now: now) == 55_000)
    }

    @Test func remainingMs_atDeadline_returnsZero() {
        let now = Date(timeIntervalSince1970: 1_000)
        #expect(CompanionAttachChallenge.remainingMs(deadline: now, now: now) == 0)
    }

    @Test func remainingMs_pastDeadline_clampsToZeroNeverNegative() {
        let now = Date(timeIntervalSince1970: 1_000)
        let deadline = now.addingTimeInterval(-30) // already expired 30s ago
        #expect(CompanionAttachChallenge.remainingMs(deadline: deadline, now: now) == 0)
    }

    // MARK: - Case 6: companion.name sets resolvedName + posts a notification
    //
    // Device naming (spec 2026-08-24): server -> TV push after a dashboard
    // rename. Mirrors Case 1's attach.challenge harness — frame fed straight
    // into handleControl(_:), no real network or socket.

    @Test func companionName_setsResolvedNameAndPostsNotification() {
        let (client, api) = makeFrameClient()

        var posted: Notification?
        let observer = NotificationCenter.default.addObserver(
            forName: .traceItXCompanionResolvedNameChange, object: api, queue: nil
        ) { note in posted = note }
        defer { NotificationCenter.default.removeObserver(observer) }

        client.handleControl(#"{"type":"companion.name","name":"QA Lobby TV"}"#)

        #expect(api.resolvedName == "QA Lobby TV")
        #expect(posted != nil)
        #expect(posted?.userInfo?["resolvedName"] as? String == "QA Lobby TV")
    }

    // MARK: - Case 7: an out-of-range companion.name is ignored

    @Test func companionName_empty_isIgnored() {
        let (client, api) = makeFrameClient()
        client.handleControl(#"{"type":"companion.name","name":"Prior Name"}"#)
        #expect(api.resolvedName == "Prior Name")

        client.handleControl(#"{"type":"companion.name","name":""}"#)

        // Out-of-range frame must not clobber the last good value.
        #expect(api.resolvedName == "Prior Name")
    }

    @Test func companionName_tooLong_isIgnored() {
        let (client, api) = makeFrameClient()
        client.handleControl(#"{"type":"companion.name","name":"Prior Name"}"#)
        #expect(api.resolvedName == "Prior Name")

        let tooLong = String(repeating: "x", count: 81)
        client.handleControl(#"{"type":"companion.name","name":"\#(tooLong)"}"#)

        #expect(api.resolvedName == "Prior Name")
    }

    @Test func companionName_maxLength80_isAccepted() {
        let (client, api) = makeFrameClient()
        let max = String(repeating: "y", count: 80)

        client.handleControl(#"{"type":"companion.name","name":"\#(max)"}"#)

        #expect(api.resolvedName == max)
    }

    // MARK: - Case 8: a terminal close nulls resolvedName

    @Test func terminalClose_nullsResolvedName() {
        let (client, api) = makeFrameClient()
        client.handleControl(#"{"type":"companion.name","name":"QA Lobby TV"}"#)
        #expect(api.resolvedName != nil)

        // 4002 = pair_expired, one of the terminal codes that resets the pair.
        simulateSocketClose(client, code: 4002)

        #expect(api.resolvedName == nil)
    }
}
