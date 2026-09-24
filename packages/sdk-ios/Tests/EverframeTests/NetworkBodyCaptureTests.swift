// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// NetworkBodyCapture: pure, synchronous body-capture builder driven directly
// against constructed URLRequest/HTTPURLResponse values — no live HTTP,
// matching NetworkCaptureProtocolTests's style. Each test injects a fresh
// `NetworkBodyCaptureGate` instance (never the process-wide `.shared`) so
// suites can run without cross-test gate-state races.
import Testing
import Foundation
import EverframeProtocol
@testable import EverframeKit

@MainActor
@Suite(.serialized)
struct NetworkBodyCaptureTests {
    private let testAppId = "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"

    // MARK: - Helpers

    private func activeGate(
        bodyByteCap: Int? = nil, bodyContentTypes: [String]? = nil
    ) -> NetworkBodyCaptureGate {
        let gate = NetworkBodyCaptureGate()
        gate.applyConfig(
            NetworkBodiesConfigWire(
                captureBodies: true, bodyByteCap: bodyByteCap, bodyContentTypes: bodyContentTypes,
                bodyTotalBudget: nil),
            samplingRate: 1.0, locallyDisabled: false, random: { 0.0 })
        return gate
    }

    private func getRequest() -> URLRequest {
        URLRequest(url: URL(string: "https://example.com/api")!)
    }

    private func httpResponse(contentType: String, status: Int = 200) -> HTTPURLResponse {
        HTTPURLResponse(
            url: URL(string: "https://example.com/api")!, statusCode: status, httpVersion: nil,
            headerFields: ["Content-Type": contentType])!
    }

    // MARK: - Gate / response guards

    @Test func gateOffProducesNoEntry() {
        let gate = NetworkBodyCaptureGate() // fresh, inactive by default
        let e = NetworkBodyCapture.makeEntry(
            reqId: 1, tEpochMs: 1000, request: getRequest(),
            response: httpResponse(contentType: "application/json"), responseData: nil,
            reqHeaders: [:], resHeaders: [:], gate: gate)
        #expect(e == nil)
    }

    @Test func nilResponseProducesNoEntry() {
        let gate = activeGate()
        let e = NetworkBodyCapture.makeEntry(
            reqId: 1, tEpochMs: 1000, request: getRequest(),
            response: nil, responseData: nil,
            reqHeaders: [:], resHeaders: [:], gate: gate)
        #expect(e == nil)
    }

    // MARK: - Redaction

    @Test func jsonResponseBodyCapturedAndRedacted() {
        let gate = activeGate()
        let body = #"{"card":"4242424242424242"}"#.data(using: .utf8)!
        let e = NetworkBodyCapture.makeEntry(
            reqId: 1, tEpochMs: 1000, request: getRequest(),
            response: httpResponse(contentType: "application/json"), responseData: body,
            reqHeaders: [:], resHeaders: ["content-type": "application/json"], gate: gate)
        #expect(e?.resBody?.contains("[REDACTED:luhn-cc]") == true)
        #expect(e?.resBody?.contains("4242") == false)
        #expect(e?.ref == 1)
        #expect(e?.t == 1000)
    }

    // MARK: - Content-type allowlist

    @Test func disallowedContentTypeSkips() {
        let gate = activeGate()
        let e = NetworkBodyCapture.makeEntry(
            reqId: 1, tEpochMs: 1000, request: getRequest(),
            response: httpResponse(contentType: "image/png"), responseData: Data([0, 1, 2, 3]),
            reqHeaders: [:], resHeaders: ["content-type": "image/png"], gate: gate)
        #expect(e?.resBody == nil)
        #expect(e?.resBodySkipped == .contentType)
    }

    @Test func wildcardAllowlistMatchesTextPlain() {
        #expect(
            NetworkBodyCapture.contentTypeAllowed(
                "text/plain; charset=utf-8", allowlist: ["application/json", "text/*"]))
        #expect(
            !NetworkBodyCapture.contentTypeAllowed(
                "application/octet-stream", allowlist: ["application/json", "text/*"]))
    }

    /// Regression: `"".split(separator: ";")` (and `";"`, `";;"`) all yield
    /// an EMPTY array — `.split` omits empty subsequences by default — so
    /// indexing `[0]` used to trap. A malformed/empty Content-Type header is
    /// reachable from live traffic via the URLProtocol completion handler,
    /// making this a real crash vector, not just a theoretical one.
    @Test func emptyOrSeparatorOnlyContentTypeNeverCrashes() {
        #expect(!NetworkBodyCapture.contentTypeAllowed("", allowlist: ["application/json"]))
        #expect(!NetworkBodyCapture.contentTypeAllowed(";", allowlist: ["application/json"]))
        #expect(!NetworkBodyCapture.contentTypeAllowed(";;", allowlist: ["application/json"]))
    }

    // MARK: - Truncation

    @Test func oversizedBodyTruncatedAtCapWithOriginalByteCount() {
        let gate = activeGate() // default cap: 8192
        let body = Data(String(repeating: "a", count: 20_000).utf8)
        let e = NetworkBodyCapture.makeEntry(
            reqId: 1, tEpochMs: 1000, request: getRequest(),
            response: httpResponse(contentType: "text/plain"), responseData: body,
            reqHeaders: [:], resHeaders: ["content-type": "text/plain"], gate: gate)
        #expect(e?.resBodyTruncated == true)
        #expect(e?.resBodyBytes == 20_000)
        #expect((e?.resBody?.utf8.count ?? .max) <= 8192)
    }

    // MARK: - Final-review Finding 6 (cap-before-redaction leaks boundary-straddling secrets)

    /// Regression: the OLD pipeline order was cap -> redact. A secret that
    /// starts just before the cap gets cut mid-secret by the cap, and the
    /// leftover partial digit run is too short to match the luhn-cc regex
    /// (`\b\d[\d\s-]{11,21}\d\b`, which needs 13-23 total digit chars) — so
    /// it ships in the captured body completely unredacted. This constructs
    /// exactly that shape: a Luhn-valid 16-digit card starting 8 bytes
    /// before a small custom cap and extending 8 bytes past it, and asserts
    /// NO run of 8+ consecutive digits from the card survives in the
    /// captured (and cap-truncated) resBody.
    @Test func luhnCCStraddlingTheByteCapIsFullyRedactedNotPartiallyLeaked() {
        let cap = 100
        let gate = activeGate(bodyByteCap: cap)
        // `.` (not a `\w` char) rather than a letter, so a regex word
        // boundary (`\b`) exists right before the card — matching the shape
        // of `redact_replacesLuhnValidCC`'s "card: 4242 ... " fixture, where
        // the digits are set off from adjoining text.
        let filler = String(repeating: ".", count: cap - 8) // card starts 8 bytes before the cap
        let card = "4242424242424242" // Luhn-valid, 16 digits — extends 8 bytes past the cap
        let bodyString = filler + card
        let body = Data(bodyString.utf8)
        #expect(body.count == cap + 8) // sanity: straddles the cap by 8 bytes on each side

        let e = NetworkBodyCapture.makeEntry(
            reqId: 1, tEpochMs: 1000, request: getRequest(),
            response: httpResponse(contentType: "text/plain"), responseData: body,
            reqHeaders: [:], resHeaders: ["content-type": "text/plain"], gate: gate)

        let resBody = e?.resBody ?? ""
        // No 8+ consecutive digit run survives anywhere in the output — the
        // OLD pipeline leaked exactly an 8-digit prefix ("42424242") of the
        // card because the cap cut the other 8 digits away before redaction
        // ever ran.
        let digitRun = try! NSRegularExpression(pattern: "[0-9]{8,}")
        let hasLongDigitRun = digitRun.firstMatch(
            in: resBody, range: NSRange(resBody.startIndex..., in: resBody)) != nil
        #expect(!hasLongDigitRun, "captured body still leaks part of the card: \(resBody)")
        #expect(!resBody.contains(card))
        // The redaction marker itself can land right at the cap and get
        // cut mid-marker (e.g. "[REDACTE" instead of the full
        // "[REDACTED:CC]") — that's fine per Finding 6's contract ("a cut-
        // in-half marker is harmless"), since redaction already ran over
        // the FULL window before this truncation. Check a short enough
        // prefix that it survives regardless of exactly where the cap
        // lands.
        #expect(resBody.contains("[REDACT"))

        // Truncation flags/byte counts stay keyed on the ORIGINAL body size,
        // unaffected by the wider overlap-scan window.
        #expect(e?.resBodyTruncated == true)
        #expect(e?.resBodyBytes == Double(body.count))
        #expect(resBody.utf8.count <= cap)
    }

    // MARK: - UTF-8 boundary safety

    @Test func utf8PrefixNeverSplitsCodepoint() {
        let s = String(repeating: "é", count: 100) // 2-byte codepoints
        let cut = NetworkBodyCapture.utf8Prefix(s.data(using: .utf8)!, cap: 101)
        #expect(cut != nil && !cut!.contains("\u{FFFD}") && cut!.utf8.count <= 101)
    }

    // MARK: - Request body: data vs stream-only

    @Test func httpBodyDataCaptured_streamOnlySkipsUnsupported() {
        let gate = activeGate()

        var reqWithData = getRequest()
        reqWithData.httpMethod = "POST"
        reqWithData.httpBody = #"{"name":"x"}"#.data(using: .utf8)!
        let e1 = NetworkBodyCapture.makeEntry(
            reqId: 1, tEpochMs: 1000, request: reqWithData,
            response: httpResponse(contentType: "application/json"), responseData: nil,
            reqHeaders: ["content-type": "application/json"], resHeaders: [:], gate: gate)
        #expect(e1?.reqBody == #"{"name":"x"}"#)
        #expect(e1?.reqBodySkipped == nil)

        var reqWithStream = getRequest()
        reqWithStream.httpMethod = "POST"
        reqWithStream.httpBodyStream = InputStream(data: Data("stream-only".utf8))
        let e2 = NetworkBodyCapture.makeEntry(
            reqId: 2, tEpochMs: 1000, request: reqWithStream,
            response: httpResponse(contentType: "application/json"), responseData: nil,
            reqHeaders: ["content-type": "application/json"], resHeaders: [:], gate: gate)
        #expect(e2?.reqBody == nil)
        #expect(e2?.reqBodySkipped == .unsupported)
    }

    /// Regression: web parity (packages/sdk-react/src/capture/network.ts's
    /// `readRequestBody`) checks body EXISTENCE before anything else — a
    /// body-less GET (no `httpBody`, no `httpBodyStream`, and deliberately
    /// no Content-Type header either) must get NO skip reason at all, since
    /// nothing was actually skipped. The response side is unaffected and
    /// still captures/redacts normally.
    @Test func bodylessRequestGetsNoSkipReason() {
        let gate = activeGate()
        let responseBody = #"{"ok":true}"#.data(using: .utf8)!
        let e = NetworkBodyCapture.makeEntry(
            reqId: 1, tEpochMs: 1000, request: getRequest(),
            response: httpResponse(contentType: "application/json"), responseData: responseBody,
            reqHeaders: [:], resHeaders: ["content-type": "application/json"], gate: gate)
        #expect(e?.reqBody == nil)
        #expect(e?.reqBodySkipped == nil)
        #expect(e?.reqBodyBytes == nil)
        #expect(e?.reqBodyTruncated == nil)
        #expect(e?.resBody == #"{"ok":true}"#)
        #expect(e?.resBodySkipped == nil)
    }

    // MARK: - EverframeBreadcrumb dual-write reqId linkage

    private func resetBreadcrumbState() {
        BreadcrumbSharedStateTestLock.lock.lock()
        defer { BreadcrumbSharedStateTestLock.lock.unlock() }
        BreadcrumbRingBuffer.shared.applyConfig(nil)
        BreadcrumbRingBuffer.shared.clear()
    }

    private func noLogCaptureConfig() -> EverframeConfig {
        EverframeConfig(appId: testAppId, capture: CaptureConfig(logs: false))
    }

    private func matchingCrumb(message: String) -> EverframeBreadcrumb? {
        BreadcrumbRingBuffer.shared.freeze()
        return BreadcrumbRingBuffer.shared.takeFrozen()?.first { $0.message == message }
    }

    // Round-6 review Finding F31: drives `Everframe.shared.start()` for real
    // — wrapped in `withGlobalCaptureStateLock` so it cannot interleave with
    // any other suite doing the same (see
    // Helpers/GlobalCaptureStateTestLock.swift).
    @Test func dualWriteAddsReqIdOnlyWhenProvided() async throws {
        try await withGlobalCaptureStateLock {
            resetBreadcrumbState()
            try Everframe.shared.start(config: noLogCaptureConfig())

            let urlNoReqId = "https://example.com/no-reqid-\(UUID().uuidString)"
            let entryNoReqId = NetworkLogEntry(
                timestamp: Date(), method: "GET", url: urlNoReqId,
                status: 200, durationMs: 5, requestHeaders: [:], responseHeaders: [:])
            NetworkBreadcrumbAdapter.dualWrite(entry: entryNoReqId)
            let crumbNoReqId = matchingCrumb(message: "GET \(urlNoReqId) 200")
            #expect(crumbNoReqId?.data?["reqId"] == nil)

            let urlWithReqId = "https://example.com/with-reqid-\(UUID().uuidString)"
            let entryWithReqId = NetworkLogEntry(
                timestamp: Date(), method: "GET", url: urlWithReqId,
                status: 200, durationMs: 5, requestHeaders: [:], responseHeaders: [:])
            NetworkBreadcrumbAdapter.dualWrite(entry: entryWithReqId, reqId: 42)
            let crumbWithReqId = matchingCrumb(message: "GET \(urlWithReqId) 200")
            #expect(crumbWithReqId?.data?["reqId"]?.value as? Int64 == 42)

            resetBreadcrumbState()
        }
    }
}
