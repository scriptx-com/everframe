// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Independent review, round 15, Critical — `setIdentityToken` replaced the
// credential holder and nothing else. It did not discard an active or
// frozen replay, nor clear breadcrumbs, logs, network metadata, or network
// bodies. So: Alice uses the app, signs out, Bob signs in, and Bob could
// immediately submit ALICE's retained capture history — stamped with Bob's
// server-VERIFIED identity. `ReplayLifecycle.forceDiscard()` was already
// documented as the zeroization boundary for exactly this ("logout/identity
// change") but nothing ever called it.
//
// Round 15's first fix went further than sign-out: it also discarded on any
// CONFIRMED identity change inferred from `.token`/`.provider` (comparing
// the new subject against the previous one). Round 16 (independent review,
// codex round 14) re-review found that attempt itself produced three
// further Criticals — an already-open reporter keeps the previous user's
// screenshot/UI-tree regardless of what the ring buffers do; the
// provider-form comparison was a ONE-SHOT check tied to the first warm
// attempt, so a transient failure permanently lost it; and even the
// synchronous `.token` path published the new identity before the evidence
// wipe completed, so a concurrent capture could observe the new subject
// alongside the old evidence. The ruling: narrow the discard to sign-out
// only — the one case that is unambiguous and free of all three findings
// (`nil` always resolves to ANONYMOUS, never to a DIFFERENT verified
// identity, so the worst case in the identical race window is "ships with
// less evidence," never "attributed to the wrong verified person"). See
// `Everframe.swift`'s `setIdentityToken` for the full account and
// `the user-recognition contract` for the accepted-limitation writeup.
//
// This suite therefore covers TWO things: (1) sign-out still discards, the
// part that stayed fixed, and (2) the residual — an account switch to a
// DIFFERENT verified identity does NOT discard, documented here as a
// regression pin so a future re-attempt at inferring the comparison cannot
// silently reintroduce it without this test (and the docs) being revisited.
// Both drive the fix end to end: capture evidence as Alice, install Bob (or
// sign out), build a REAL envelope from whatever the buffers hold
// afterward, submit it through the REAL `ReportSubmitter` to a REAL local
// server (`RecordingHTTPServer`, extended this round to also capture the
// request BODY, not just headers — see that type's own doc comment), and
// inspect what actually arrived on the wire. `Everframe.swift` is not
// UIKit-gated, so this runs on the macOS host build like
// `IdentityHeaderRedirectTests`.
import XCTest
@testable import EverframeKit

final class AccountSwitchEvidenceDiscardTests: XCTestCase {

    private var server: RecordingHTTPServer!
    private var tempDir: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        server = try RecordingHTTPServer()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("everframe-account-switch-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        server.respond = { _ in (200, ["Content-Type": "application/json"], Data("{}".utf8)) }

        // A real, started session — `capture.logs: false` keeps
        // `StderrIntercept` off so it can't leak an unrelated `.console`
        // crumb into these exact-content assertions, same isolation
        // rationale `KillSwitchTests` already documents for the identical
        // reason.
        try Everframe.shared.start(config: EverframeConfig(
            appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU",
            capture: CaptureConfig(logs: false)
        ))
        BreadcrumbRingBuffer.shared.applyConfig(nil)  // all kinds enabled, boot-time defaults
        BreadcrumbRingBuffer.shared.clear()
        LogRingBuffer.shared.clear()
        NetworkRingBuffer.shared.clear()
        NetworkBodyRingBuffer.shared.clear()
        ResourceRingBuffer.shared.clear()
    }

    override func tearDownWithError() throws {
        Everframe.shared.kill()
        BreadcrumbRingBuffer.shared.clear()
        LogRingBuffer.shared.clear()
        NetworkRingBuffer.shared.clear()
        NetworkBodyRingBuffer.shared.clear()
        ResourceRingBuffer.shared.clear()
        server?.stop()
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

    private func enabledConfig() async -> ReplayConfig {
        let provider = ReplayConfigProvider(
            configUrl: URL(string: "https://everframe.dev/api/config")!,
            apiKey: "evr_test_key",
            fetcher: FixedResponseFetcher(
                #"{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1,"identity":{"enabled":true}}"#)
        )
        await provider.refresh()
        return await provider.current
    }

    /// Bounded polling on an arbitrary condition — mirrors this test
    /// target's own established pattern (`pollForCapturedSubject()` etc.).
    private func poll(timeoutSeconds: Double = 3, _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while !condition(), Date() < deadline {
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    private func buildEnvelope() throws -> Data {
        let logRows = LogRingBuffer.shared.snapshot().map {
            EnvelopeBuilder.LogRow(timestamp: $0.timestamp, level: $0.level, tag: nil, message: $0.message)
        }
        let (bytes, _) = try EnvelopeBuilder().buildEncoded(
            reportId: UUID(),
            sdkVersion: "test",
            logs: logRows,
            breadcrumbs: BreadcrumbRingBuffer.shared.snapshot()
        )
        return bytes
    }

    // -------------------------------------------------------------------
    // The residual, documented as a regression pin (round 16) — an account
    // switch to a DIFFERENT verified identity does NOT discard the
    // previous user's evidence. See this file's own module doc and
    // `the user-recognition contract` for the full accepted-limitation
    // writeup. If this test starts failing because evidence IS being
    // discarded again, that is not automatically a regression — it means
    // someone re-added the inferred comparison, and BOTH this test AND the
    // docs need to be revisited together, not just one of them.
    // -------------------------------------------------------------------

    /// Mutation-verified (inverted from round 15's original intent):
    /// reinstating round 15's discard-on-change logic makes this fail — the
    /// built envelope (and the server's recorded body) would then be empty
    /// of Alice's markers instead of containing them.
    func testAnAccountSwitchToADifferentVerifiedIdentityDoesNotDiscardThePreviousUsersEvidence() async throws {
        Everframe.shared.__replayConfigOverrideForTesting = await enabledConfig()

        // 1. Capture as Alice: install her verified identity, then capture
        //    evidence while she is the active subject.
        Everframe.shared.setIdentityToken(.token(jwt(sub: "alice", exp: Date().addingTimeInterval(300))))
        BreadcrumbRingBuffer.shared.add(kind: .tap, message: "alice-breadcrumb-marker")
        LogRingBuffer.shared.append(LogEntry(timestamp: Date(), level: "info", message: "alice-log-marker"))

        // Fixture sanity — the evidence really is there before the switch.
        XCTAssertFalse(BreadcrumbRingBuffer.shared.snapshot().isEmpty, "fixture sanity: Alice's breadcrumb must be captured")
        XCTAssertFalse(LogRingBuffer.shared.snapshot().isEmpty, "fixture sanity: Alice's log line must be captured")

        // 2. Bob signs in — a DIFFERENT verified subject, via the PROVIDER
        //    form. No discard is expected here anymore (round 16).
        let invoked = InvocationFlag()
        Everframe.shared.setIdentityToken(.provider {
            await invoked.mark()
            return self.jwt(sub: "bob", exp: Date().addingTimeInterval(300))
        })

        var wasInvoked = await invoked.value
        var attempts = 0
        while !wasInvoked, attempts < 100 {
            try? await Task.sleep(nanoseconds: 20_000_000)
            wasInvoked = await invoked.value
            attempts += 1
        }
        XCTAssertTrue(wasInvoked, "fixture sanity: the warm must actually have invoked the provider")

        // Give a (no longer expected) discard a fair chance to land before
        // asserting its absence, same bounded-wait discipline this branch
        // always uses to check a negative.
        try? await Task.sleep(nanoseconds: 300_000_000)

        // 3. THE residual: Alice's evidence is still there.
        XCTAssertFalse(
            BreadcrumbRingBuffer.shared.snapshot().isEmpty,
            "accepted limitation: an account switch does not discard the previous user's breadcrumbs"
        )
        XCTAssertFalse(
            LogRingBuffer.shared.snapshot().isEmpty,
            "accepted limitation: an account switch does not discard the previous user's log lines"
        )

        // 4. Submit — build a REAL envelope from whatever the buffers hold
        //    NOW (post-switch, still Alice's), through the SAME builder
        //    production uses.
        let envelopeBytes = try buildEnvelope()
        let envelopeText = String(data: envelopeBytes, encoding: .utf8) ?? ""
        XCTAssertTrue(
            envelopeText.contains("alice-breadcrumb-marker") && envelopeText.contains("alice-log-marker"),
            "accepted limitation: the envelope built after the account switch still carries Alice's evidence"
        )

        let captured = Everframe.shared.captureUserSnapshot()
        XCTAssertEqual(captured.identitySubject, "bob", "fixture sanity: the capture must be stamped under Bob, not Alice")
        let identityToken = await resolveIdentityHeader(
            capturedSubject: captured.identitySubject,
            holder: Everframe.shared._identityHolder,
            config: await Everframe.shared.currentReplayConfig(),
            now: Date()
        )

        let submitter = ReportSubmitter(config: EverframeConfig(appId: "app"), outbox: makeOutbox())
        let result = try await submitter.submit(
            envelopeBytes: envelopeBytes,
            idempotencyKey: "idem-account-switch",
            attachments: [],
            endpoint: server.url.absoluteString,
            identitySubject: captured.identitySubject,
            identityToken: identityToken
        )
        guard case .submitted = result else {
            XCTFail("the report must still submit after an account switch — got \(result)")
            return
        }

        // 5. The strongest evidence available: what the SERVER actually
        //    received on the wire, not merely the bytes handed to submit()
        //    — this documents the EXACT exposure precisely: Alice's own
        //    breadcrumb/log markers, attached to a request carrying Bob's
        //    server-VERIFIED identity header.
        guard let recorded = server.recorded.first else {
            XCTFail("fixture sanity: the server must have received exactly one request")
            return
        }
        let bodyText = String(data: recorded.body, encoding: .utf8) ?? ""
        XCTAssertTrue(
            bodyText.contains("alice-breadcrumb-marker") && bodyText.contains("alice-log-marker"),
            "accepted limitation: Alice's evidence reaches the wire in the request body Bob's report submits"
        )
        let sentToken = recorded.headers["X-Everframe-Identity-Token"]
        XCTAssertNotNil(sentToken, "fixture sanity: the report must carry Bob's identity header")
        XCTAssertEqual(
            sentToken.flatMap { decodeIdentityClaims($0)?.sub }, "bob",
            "accepted limitation, precisely: the wire request carries ALICE's evidence under BOB's verified identity header"
        )
    }

    // -------------------------------------------------------------------
    // The part that stayed fixed: sign-out.
    // -------------------------------------------------------------------

    /// Sign-out is unambiguous — always discard.
    func testSignOutAlwaysDiscardsCapturedEvidence() {
        Everframe.shared.setIdentityToken(.token(jwt(sub: "alice", exp: Date().addingTimeInterval(300))))
        BreadcrumbRingBuffer.shared.add(kind: .tap, message: "alice-breadcrumb-marker")
        XCTAssertFalse(BreadcrumbRingBuffer.shared.snapshot().isEmpty, "fixture sanity")

        Everframe.shared.setIdentityToken(nil)

        XCTAssertTrue(
            BreadcrumbRingBuffer.shared.snapshot().isEmpty,
            "sign-out (nil) must always discard captured evidence"
        )
    }

    /// Fix round 1, IMPORTANT 2 (Report EverframeResource Window, spec 2026-09-05) —
    /// `ResourceRingBuffer` was the one sibling buffer NOT zeroized by
    /// `clearCapturedEvidenceBuffers()`, called by BOTH `kill()` and this
    /// same sign-out path. Without it, up to `windowSec` of Alice's CPU/
    /// memory samples survive into Bob's session and can ship on Bob's
    /// first report — the identical evidence-leak shape this whole suite
    /// exists to close for breadcrumbs/logs/network/bodies, just for the
    /// one buffer this fix round found unclosed.
    func testSignOutAlwaysDiscardsCapturedResourceSamples() {
        Everframe.shared.setIdentityToken(.token(jwt(sub: "alice", exp: Date().addingTimeInterval(300))))
        // A real "now" timestamp, not an arbitrary epoch like the pure ring
        // unit tests use: `.snapshot()` (called below with no explicit
        // `now:`) evicts against the REAL current clock (see
        // ResourceRingBuffer's CONTROLLER RULING doc comment), so a
        // near-epoch `t` would be evicted before this test ever observed it.
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        ResourceRingBuffer.shared.append(ResourceSample(t: now, cpu: 0.1, mem: 1024), now: now)
        XCTAssertFalse(ResourceRingBuffer.shared.snapshot().isEmpty, "fixture sanity")

        Everframe.shared.setIdentityToken(nil)

        XCTAssertTrue(
            ResourceRingBuffer.shared.snapshot().isEmpty,
            "sign-out (nil) must always discard captured resource samples, same as every sibling buffer"
        )
    }
}

private final class FixedResponseFetcher: URLSessionFetching, @unchecked Sendable {
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
