// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The invariant: a token is attached only when its `sub` equals the identity
// the report was CAPTURED under — not the identity active at submit or drain
// time.
//
// Web enforces a narrower version of this at enqueue time (enqueuedSubjects +
// subjectGatedReader, sdk-react/src/transport/submit.ts:73,91). Capture time is
// strictly stronger and costs less here, because captureUserSnapshot() already
// exists and is already correct about atomicity. It also closes a gap web does
// not have: the native reporter modal stays open while the user annotates and
// types, often for a minute, and a setIdentityToken(Bob) landing in that window
// would otherwise repoint Alice's in-progress report.
//
// Decode path note (fix — the plan's inline listing does not compile):
// `ReplayConfig` is deliberately NOT `Decodable` — only the file-private
// `ReplayConfigWire` in ReplayConfigProvider.swift is, so the fail-closed wire
// validation can never be bypassed by a caller decoding the public type
// directly (see IdentityConfigGateTests.swift's identical note). This suite
// therefore builds its fixture configs through a real
// `ReplayConfigProvider.refresh()` against a stub fetcher, exactly like every
// other ReplayConfig-consuming suite in this package, rather than
// `JSONDecoder().decode(ReplayConfig.self, ...)` as originally sketched. No
// assertion below is weakened by this — only how the two fixture configs are
// constructed.
import XCTest
@testable import TraceItXKit

private final class SingleResponseFetcher: URLSessionFetching, @unchecked Sendable {
    private let body: Data
    init(_ json: String) { self.body = Data(json.utf8) }
    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: nil
        )!
        return (body, response)
    }
}

final class IdentitySubjectGateTests: XCTestCase {

    private func jwt(sub: String, exp: Date) -> String {
        let header = #"{"alg":"HS256","typ":"JWT"}"#.data(using: .utf8)!
        let payload = try! JSONSerialization.data(withJSONObject: ["sub": sub, "exp": Int(exp.timeIntervalSince1970)])
        func b64(_ d: Data) -> String {
            d.base64EncodedString()
                .replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
        }
        return "\(b64(header)).\(b64(payload)).sig"
    }

    private func decode(_ json: String) async -> ReplayConfig {
        let provider = ReplayConfigProvider(
            configUrl: URL(string: "https://traceitx.com/api/config")!,
            apiKey: "tx_test_key",
            fetcher: SingleResponseFetcher(json)
        )
        await provider.refresh()
        return await provider.current
    }

    private func enabledConfig() async -> ReplayConfig {
        await decode(#"{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1,"identity":{"enabled":true}}"#)
    }

    private func disabledConfig() async -> ReplayConfig {
        await decode(#"{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1}"#)
    }

    func testAttachesWhenTheSubjectMatches() async {
        let now = Date()
        let holder = IdentityTokenHolder()
        let t = jwt(sub: "alice", exp: now.addingTimeInterval(300))
        holder.set(.token(t))
        let cfg = await enabledConfig()
        let got = await resolveIdentityHeader(capturedSubject: "alice", holder: holder, config: cfg, now: now)
        XCTAssertEqual(got, t)
    }

    func testWithholdsWhenTheIdentityChangedAfterCapture() async {
        // Alice opens the reporter and starts typing; Bob signs in before she
        // hits Send. Her report must not ship carrying Bob's credential.
        let now = Date()
        let holder = IdentityTokenHolder()
        holder.set(.token(jwt(sub: "bob", exp: now.addingTimeInterval(300))))
        let cfg = await enabledConfig()
        let got = await resolveIdentityHeader(capturedSubject: "alice", holder: holder, config: cfg, now: now)
        XCTAssertNil(got)
    }

    func testWithholdsForAReportCapturedAnonymously() async {
        // Captured with nobody signed in. A token acquired afterwards must not
        // retroactively attribute it.
        let now = Date()
        let holder = IdentityTokenHolder()
        holder.set(.token(jwt(sub: "alice", exp: now.addingTimeInterval(300))))
        let cfg = await enabledConfig()
        let got = await resolveIdentityHeader(capturedSubject: nil, holder: holder, config: cfg, now: now)
        XCTAssertNil(got)
    }

    func testWithholdsWhenIdentityIsDisabledForTheProject() async {
        let now = Date()
        let holder = IdentityTokenHolder()
        holder.set(.token(jwt(sub: "alice", exp: now.addingTimeInterval(300))))
        let cfg = await disabledConfig()
        let got = await resolveIdentityHeader(capturedSubject: "alice", holder: holder, config: cfg, now: now)
        XCTAssertNil(got)
    }

    func testWithholdsWhenTheTokenHasGoneStale() async {
        let now = Date()
        let holder = IdentityTokenHolder()
        holder.set(.token(jwt(sub: "alice", exp: now.addingTimeInterval(-1))))
        let cfg = await enabledConfig()
        let got = await resolveIdentityHeader(capturedSubject: "alice", holder: holder, config: cfg, now: now)
        XCTAssertNil(got)
    }

    func testOutboxEntryRoundTripsTheSubject() throws {
        let entry = OutboxEntry(
            reportId: UUID(),
            createdAt: Date(),
            envelopeBytes: Data("{}".utf8),
            idempotencyKey: "k",
            attachmentRefs: [],
            sdkKey: "sdk_test",
            endpoint: "https://example.test",
            identitySubject: "alice")
        let encoded = try JSONEncoder().encode(entry)
        let decoded = try JSONDecoder().decode(OutboxEntry.self, from: encoded)
        XCTAssertEqual(decoded.identitySubject, "alice")
    }

    func testALegacyEntryWithoutTheFieldStillDecodes() throws {
        // Deliberately UNLIKE sdkKey/endpoint, whose absence drops the entry
        // (PR #63): here a missing subject means "anonymous", which is the
        // fail-closed direction, so an older queued report keeps submitting
        // instead of being discarded.
        let legacy = """
        {"reportId":"\(UUID().uuidString)","createdAt":0,"envelopeBytes":"e30=","idempotencyKey":"k",\
        "attachmentRefs":[],"sdkKey":"sdk_test","endpoint":"https://example.test"}
        """
        let decoded = try JSONDecoder().decode(OutboxEntry.self, from: Data(legacy.utf8))
        XCTAssertNil(decoded.identitySubject)
    }
}
