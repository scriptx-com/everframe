// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Independent review, round 13, Serious — `MultipartUploader.upload`
// attaches `X-TX-Identity-Token` (a real person's bearer credential) to the
// ingest POST, and `URLSession` follows redirects by default. Foundation's
// handling of a CUSTOM header on a cross-origin redirect is undocumented
// and is NOT the same as its handling of `Authorization` — established
// empirically (see `ReportSubmitter.swift`'s `IdentityHeaderRedirectGuard`
// doc comment for the full write-up): a plain `URLSession` with no delegate
// strips `Authorization` on a cross-origin redirect but carries custom
// headers — including `X-TX-Identity-Token` AND, separately,
// `X-TX-Companion-Attribution` — straight through to the new host.
//
// This suite drives that fix end to end through the REAL production path
// (`ReportSubmitter.submit` -> `MultipartUploader.upload` ->
// `ReportSubmitter.makeIsolatedSession()`, the exact session a live submit
// uses) against TWO REAL local HTTP servers (`RecordingHTTPServer` — see
// its own doc comment for why a `URLProtocol` mock cannot answer this
// question at all). `Transport/ReportSubmitter.swift` is not UIKit-gated,
// so this runs on the macOS host build like `DrainIdentityHeaderTests`.
import XCTest
@testable import TraceItXKit

final class IdentityHeaderRedirectTests: XCTestCase {

    private var serverA: RecordingHTTPServer!
    private var serverB: RecordingHTTPServer!
    private var tempDir: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        serverA = try RecordingHTTPServer()
        serverB = try RecordingHTTPServer()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("traceitx-identity-redirect-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        serverA?.stop()
        serverB?.stop()
        try? FileManager.default.removeItem(at: tempDir)
        try super.tearDownWithError()
    }

    private func makeOutbox() -> JSONLOutbox {
        JSONLOutbox(testFileURL: tempDir.appendingPathComponent("outbox.jsonl"))
    }

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

    /// THE test: server A always redirects (302, cross-origin — a
    /// DIFFERENT port on 127.0.0.1, which is a different origin by the
    /// same scheme+host+port definition a browser uses) to server B.
    /// `ReportSubmitter.submit` must still report `.submitted` (identity is
    /// an enhancement, never a blocker — the report itself must always go
    /// through), and server B — the host the redirect actually pointed
    /// at — must NEVER see the identity header, even though server A did.
    func testACrossOriginRedirectStripsTheIdentityHeaderButTheReportStillSubmits() async throws {
        let now = Date()
        let token = jwt(sub: "alice", exp: now.addingTimeInterval(300))

        serverA.respond = { [serverB] _ in
            (302, ["Location": serverB!.url.appendingPathComponent("api/ingest").absoluteString], Data())
        }
        serverB.respond = { _ in (200, ["Content-Type": "application/json"], Data("{}".utf8)) }

        let submitter = ReportSubmitter(config: TraceItXConfig(appId: "app"), outbox: makeOutbox())

        let result = try await submitter.submit(
            envelopeBytes: Data("{}".utf8),
            idempotencyKey: "idem-redirect-1",
            attachments: [],
            endpoint: serverA.url.absoluteString,
            identitySubject: "alice",
            identityToken: token
        )

        guard case .submitted = result else {
            XCTFail("a cross-origin redirect must not prevent the report from submitting — got \(result)")
            return
        }

        let aRequests = serverA.recorded
        let bRequests = serverB.recorded
        XCTAssertEqual(aRequests.count, 1, "fixture sanity: exactly one request must reach server A")
        XCTAssertEqual(
            aRequests.first?.headers[IDENTITY_TOKEN_HEADER], token,
            "fixture sanity: server A (the ORIGINAL destination) must have received the identity header"
        )
        XCTAssertEqual(bRequests.count, 1, "fixture sanity: the redirect must actually have been followed to server B")
        XCTAssertNil(
            bRequests.first?.headers[IDENTITY_TOKEN_HEADER],
            "the identity header must NEVER reach a host the redirect carried the request to — it is a real person's bearer credential"
        )
    }

    /// Sanity/non-regression companion: a SAME-origin redirect (same
    /// scheme+host+port, only the path changes) must keep the header — this
    /// fix must not over-withhold on the common case of an ordinary
    /// same-host redirect (e.g. `/api/ingest` -> `/api/ingest/`).
    func testASameOriginRedirectKeepsTheIdentityHeader() async throws {
        let now = Date()
        let token = jwt(sub: "alice", exp: now.addingTimeInterval(300))

        var redirectedOnce = false
        serverA.respond = { request in
            if request.path == "/api/ingest" && !redirectedOnce {
                redirectedOnce = true
                return (302, ["Location": "/api/ingest/"], Data())
            }
            return (200, ["Content-Type": "application/json"], Data("{}".utf8))
        }

        let submitter = ReportSubmitter(config: TraceItXConfig(appId: "app"), outbox: makeOutbox())

        let result = try await submitter.submit(
            envelopeBytes: Data("{}".utf8),
            idempotencyKey: "idem-redirect-2",
            attachments: [],
            endpoint: serverA.url.absoluteString,
            identitySubject: "alice",
            identityToken: token
        )

        guard case .submitted = result else {
            XCTFail("a same-origin redirect must not prevent the report from submitting — got \(result)")
            return
        }

        let aRequests = serverA.recorded
        XCTAssertEqual(aRequests.count, 2, "fixture sanity: the original request plus the followed same-origin redirect")
        XCTAssertEqual(
            aRequests.last?.headers[IDENTITY_TOKEN_HEADER], token,
            "a same-origin redirect (same scheme+host+port, only the path changed) must keep the identity header"
        )
    }
}
