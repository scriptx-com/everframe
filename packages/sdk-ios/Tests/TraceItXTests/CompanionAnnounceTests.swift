// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// `CompanionAnnounce` unit tests (spec 2026-08-07).
//
// The transport is injected, so nothing here touches the network. The bar
// these tests are written to: each one must fail if the behaviour it names
// were replaced with a constant. "Returns nil on 401" is only meaningful
// alongside "returns a ticket on 200" — the pairs below exist for that
// reason.
import Testing
import Foundation
@testable import TraceItXKit

@Suite
struct CompanionAnnounceTests {

    private static let endpoint = URL(string: "https://relay.example.com")!

    /// Records every request the announcer makes and replies with a canned
    /// (status, body) pair.
    private final class TransportSpy: @unchecked Sendable {
        private let lock = NSLock()
        private var _requests: [URLRequest] = []
        var requests: [URLRequest] {
            lock.lock(); defer { lock.unlock() }
            return _requests
        }

        let status: Int
        let body: Data
        /// When set, the transport throws instead of responding (offline).
        let thrownError: Error?

        init(status: Int = 200, body: Data = Data(), thrownError: Error? = nil) {
            self.status = status
            self.body = body
            self.thrownError = thrownError
        }

        func transport() -> AnnounceTransport {
            return { [self] request in
                lock.lock()
                _requests.append(request)
                lock.unlock()
                if let thrownError = thrownError { throw thrownError }
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: status,
                    httpVersion: "HTTP/1.1",
                    headerFields: nil)!
                return (body, response)
            }
        }
    }

    private static func json(_ raw: String) -> Data { Data(raw.utf8) }

    // MARK: - Success

    @Test func announce_returnsTicketAndCode_on200() async {
        let spy = TransportSpy(
            status: 200,
            body: Self.json(#"{"ticket":"tkt_abc","code":"7Q4K","expiresInMs":60000}"#))
        let announcer = CompanionAnnounce(
            endpoint: Self.endpoint, sdkKey: "key", transport: spy.transport())

        let result = await announcer.announce(label: "Lobby TV")

        #expect(result?.ticket == "tkt_abc")
        #expect(result?.code == "7Q4K")
    }

    @Test func announce_postsToAnnounceRouteWithBearerKeyAndJSONBody() async {
        let spy = TransportSpy(
            status: 200, body: Self.json(#"{"ticket":"t","code":"c"}"#))
        let announcer = CompanionAnnounce(
            endpoint: Self.endpoint, sdkKey: "sdk_live_123", transport: spy.transport())

        _ = await announcer.announce(label: "Lobby TV")

        let req = spy.requests.first
        #expect(req?.url?.absoluteString == "https://relay.example.com/api/companion/announce")
        #expect(req?.httpMethod == "POST")
        #expect(req?.value(forHTTPHeaderField: "Authorization") == "Bearer sdk_live_123")
        #expect(req?.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(req?.httpBody == Self.json(#"{"label":"Lobby TV"}"#))
    }

    @Test func announce_withoutLabel_sendsEmptyObjectBody() async {
        let spy = TransportSpy(
            status: 200, body: Self.json(#"{"ticket":"t","code":"c"}"#))
        let announcer = CompanionAnnounce(
            endpoint: Self.endpoint, sdkKey: "key", transport: spy.transport())

        _ = await announcer.announce(label: nil)

        #expect(spy.requests.first?.httpBody == Self.json("{}"))
    }

    @Test func announce_appliesTimeoutToTheRequest() async {
        // A hung announce would stall companion start with no QR on screen —
        // the timeout has to be on the request, not merely a constructor arg.
        let spy = TransportSpy(
            status: 200, body: Self.json(#"{"ticket":"t","code":"c"}"#))
        let announcer = CompanionAnnounce(
            endpoint: Self.endpoint, sdkKey: "key", timeout: 2.5, transport: spy.transport())

        _ = await announcer.announce(label: nil)

        #expect(spy.requests.first?.timeoutInterval == 2.5)
    }

    @Test func announce_defaultTimeoutIsFiveSeconds() async {
        let spy = TransportSpy(
            status: 200, body: Self.json(#"{"ticket":"t","code":"c"}"#))
        let announcer = CompanionAnnounce(
            endpoint: Self.endpoint, sdkKey: "key", transport: spy.transport())

        _ = await announcer.announce(label: nil)

        #expect(spy.requests.first?.timeoutInterval == 5)
    }

    @Test func announce_preservesBasePathOnTheEndpoint() async {
        let spy = TransportSpy(
            status: 200, body: Self.json(#"{"ticket":"t","code":"c"}"#))
        let announcer = CompanionAnnounce(
            endpoint: URL(string: "https://relay.example.com/traceitx")!,
            sdkKey: "key",
            transport: spy.transport())

        _ = await announcer.announce(label: nil)

        #expect(spy.requests.first?.url?.absoluteString
                == "https://relay.example.com/traceitx/api/companion/announce")
    }

    // MARK: - Every failure mode is nil (never an error, never a throw)

    @Test func announce_returnsNil_on401RevokedKey() async {
        let spy = TransportSpy(status: 401, body: Self.json(#"{"error":"invalid_sdk_key"}"#))
        let announcer = CompanionAnnounce(
            endpoint: Self.endpoint, sdkKey: "revoked", transport: spy.transport())

        #expect(await announcer.announce(label: nil) == nil)
    }

    @Test func announce_returnsNil_on404OlderServerWithoutTheRoute() async {
        let spy = TransportSpy(status: 404, body: Self.json(#"{"message":"Route not found"}"#))
        let announcer = CompanionAnnounce(
            endpoint: Self.endpoint, sdkKey: "key", transport: spy.transport())

        #expect(await announcer.announce(label: nil) == nil)
    }

    @Test func announce_returnsNil_on500() async {
        let spy = TransportSpy(status: 500, body: Self.json(#"{"ticket":"t","code":"c"}"#))
        let announcer = CompanionAnnounce(
            endpoint: Self.endpoint, sdkKey: "key", transport: spy.transport())

        // Body would decode fine — the status alone must disqualify it.
        #expect(await announcer.announce(label: nil) == nil)
    }

    @Test func announce_returnsNil_whenTransportThrows() async {
        let spy = TransportSpy(thrownError: URLError(.notConnectedToInternet))
        let announcer = CompanionAnnounce(
            endpoint: Self.endpoint, sdkKey: "key", transport: spy.transport())

        #expect(await announcer.announce(label: nil) == nil)
        // Still made the attempt — nil here means "failed", not "skipped".
        #expect(spy.requests.count == 1)
    }

    @Test func announce_returnsNil_onNonJSONBody() async {
        let spy = TransportSpy(status: 200, body: Self.json("<html>gateway</html>"))
        let announcer = CompanionAnnounce(
            endpoint: Self.endpoint, sdkKey: "key", transport: spy.transport())

        #expect(await announcer.announce(label: nil) == nil)
    }

    @Test func announce_returnsNil_whenCodeMissing() async {
        let spy = TransportSpy(status: 200, body: Self.json(#"{"ticket":"tkt_abc"}"#))
        let announcer = CompanionAnnounce(
            endpoint: Self.endpoint, sdkKey: "key", transport: spy.transport())

        #expect(await announcer.announce(label: nil) == nil)
    }

    @Test func announce_returnsNil_whenTicketIsNotAString() async {
        let spy = TransportSpy(status: 200, body: Self.json(#"{"ticket":42,"code":"7Q4K"}"#))
        let announcer = CompanionAnnounce(
            endpoint: Self.endpoint, sdkKey: "key", transport: spy.transport())

        #expect(await announcer.announce(label: nil) == nil)
    }

    // A present-but-blank ticket is the dangerous case: it decodes cleanly, so
    // without an explicit guard the caller composes `/relay/tv/` — a path the
    // relay answers with a 4004 TERMINAL close. That costs the device its
    // reporting outright, which is worse than every failure above (all of which
    // fall through to the ticketless socket). Ported from the Android guard
    // (`CompanionAnnounce.kt`); `sdk-react`'s `announce.ts` has the same guard.
    @Test func announce_returnsNil_onBlankTicket() async {
        let spy = TransportSpy(status: 200, body: Self.json(#"{"ticket":"","code":"7Q4K"}"#))
        let announcer = CompanionAnnounce(
            endpoint: Self.endpoint, sdkKey: "key", transport: spy.transport())

        #expect(await announcer.announce(label: nil) == nil)
    }

    @Test func announce_returnsNil_onBlankCode() async {
        let spy = TransportSpy(status: 200, body: Self.json(#"{"ticket":"tkt_abc","code":""}"#))
        let announcer = CompanionAnnounce(
            endpoint: Self.endpoint, sdkKey: "key", transport: spy.transport())

        #expect(await announcer.announce(label: nil) == nil)
    }

    @Test func announce_returnsNil_onWhitespaceOnlyTicket() async {
        // `isBlank()` on Android is whitespace-aware; " " must not become a URL
        // path segment either.
        let spy = TransportSpy(status: 200, body: Self.json(#"{"ticket":"   ","code":"7Q4K"}"#))
        let announcer = CompanionAnnounce(
            endpoint: Self.endpoint, sdkKey: "key", transport: spy.transport())

        #expect(await announcer.announce(label: nil) == nil)
    }

    // MARK: - supportsAttachPin body encoding (spec 2026-08-19)

    @Test func body_withSupportsAttachPinTrue_includesTheField() {
        let body = CompanionAnnounce.body(label: nil, supportsAttachPin: true)
        #expect(body == Self.json(#"{"supportsAttachPin":true}"#))
    }

    @Test func body_withSupportsAttachPinFalse_omitsTheField() {
        // false must NOT be sent as `"supportsAttachPin":false` — omitted
        // entirely, so the body stays byte-identical to a pre-attach-PIN SDK
        // when the label is also nil.
        let body = CompanionAnnounce.body(label: nil, supportsAttachPin: false)
        #expect(body == Self.json("{}"))
    }

    @Test func announce_returnsNil_onNonHTTPResponse() async {
        // A transport that yields a bare URLResponse (no status) must not be
        // mistaken for success.
        let announcer = CompanionAnnounce(
            endpoint: Self.endpoint,
            sdkKey: "key",
            transport: { request in
                (Self.json(#"{"ticket":"t","code":"c"}"#),
                 URLResponse(url: request.url!,
                             mimeType: nil,
                             expectedContentLength: 0,
                             textEncodingName: nil))
            })

        #expect(await announcer.announce(label: nil) == nil)
    }

    // MARK: - `device` block encoding (naming spec 2026-08-24)

    private static let fullDevice = AnnounceDevice(
        id: "ab12cd34-0000-4000-8000-000000000000",
        platform: "tvos",
        model: "AppleTV14,1",
        osName: "tvOS",
        osVersion: "17.4",
        emulator: false)

    @Test func body_withoutDevice_isByteIdenticalToBefore() {
        // The load-bearing regression: a client that never resolves a device
        // (Keychain unavailable, no explicit override) must produce EXACTLY
        // the pre-Task-2 body — no `"device"` key at all, in any position.
        let body = CompanionAnnounce.body(label: "Lobby TV", supportsAttachPin: true, device: nil)
        #expect(body == Self.json(#"{"label":"Lobby TV","supportsAttachPin":true}"#))
    }

    @Test func body_withDevice_includesFullDeviceBlock() {
        // `.sortedKeys` (see `body(...)`'s doc comment) — the nested `Device`
        // object's keys come out alphabetical, not declaration order.
        let body = CompanionAnnounce.body(label: nil, supportsAttachPin: false, device: Self.fullDevice)
        #expect(body == Self.json(
            #"{"device":{"emulator":false,"id":"ab12cd34-0000-4000-8000-000000000000","model":"AppleTV14,1","osName":"tvOS","osVersion":"17.4","platform":"tvos"}}"#))
    }

    @Test func body_withDevice_omitsNilOptionalFactsButAlwaysSendsIdPlatformEmulator() {
        let device = AnnounceDevice(
            id: "11112222-0000-4000-8000-333344445555",
            platform: "ios",
            model: nil,
            osName: nil,
            osVersion: nil,
            emulator: true)
        let body = CompanionAnnounce.body(label: nil, supportsAttachPin: false, device: device)
        #expect(body == Self.json(
            #"{"device":{"emulator":true,"id":"11112222-0000-4000-8000-333344445555","platform":"ios"}}"#))
    }

    @Test func announce_sendsResolvedDeviceBlockInTheRequestBody() async {
        let spy = TransportSpy(status: 200, body: Self.json(#"{"ticket":"t","code":"c"}"#))
        let announcer = CompanionAnnounce(
            endpoint: Self.endpoint, sdkKey: "key", transport: spy.transport())

        _ = await announcer.announce(label: nil, supportsAttachPin: false, device: Self.fullDevice)

        #expect(spy.requests.first?.httpBody == Self.json(
            #"{"device":{"emulator":false,"id":"ab12cd34-0000-4000-8000-000000000000","model":"AppleTV14,1","osName":"tvOS","osVersion":"17.4","platform":"tvos"}}"#))
    }

    // MARK: - `resolvedName` response parsing (naming spec 2026-08-24)

    @Test func announce_returnsResolvedName_whenPresent() async {
        let spy = TransportSpy(
            status: 200,
            body: Self.json(#"{"ticket":"t","code":"c","resolvedName":"Lobby TV (tvOS)"}"#))
        let announcer = CompanionAnnounce(
            endpoint: Self.endpoint, sdkKey: "key", transport: spy.transport())

        let result = await announcer.announce(label: nil)

        #expect(result?.resolvedName == "Lobby TV (tvOS)")
    }

    @Test func announce_resolvedNameIsNil_whenAbsent() async {
        // Older server, or a legacy announce with no device block — the field
        // is simply missing. Must not be confused with a decode failure.
        let spy = TransportSpy(status: 200, body: Self.json(#"{"ticket":"t","code":"c"}"#))
        let announcer = CompanionAnnounce(
            endpoint: Self.endpoint, sdkKey: "key", transport: spy.transport())

        let result = await announcer.announce(label: nil)

        #expect(result?.ticket == "t")
        #expect(result?.resolvedName == nil)
    }

    @Test func announce_resolvedNameIsNil_whenExplicitJSONNull() async {
        let spy = TransportSpy(
            status: 200, body: Self.json(#"{"ticket":"t","code":"c","resolvedName":null}"#))
        let announcer = CompanionAnnounce(
            endpoint: Self.endpoint, sdkKey: "key", transport: spy.transport())

        let result = await announcer.announce(label: nil)

        #expect(result?.resolvedName == nil)
    }

    @Test func announce_resolvedNameIsNil_whenBlank() async {
        // Mirrors the ticket/code blank guard above — present-but-blank must
        // not be treated as a usable name.
        let spy = TransportSpy(
            status: 200, body: Self.json(#"{"ticket":"t","code":"c","resolvedName":"   "}"#))
        let announcer = CompanionAnnounce(
            endpoint: Self.endpoint, sdkKey: "key", transport: spy.transport())

        let result = await announcer.announce(label: nil)

        #expect(result?.resolvedName == nil)
    }
}
