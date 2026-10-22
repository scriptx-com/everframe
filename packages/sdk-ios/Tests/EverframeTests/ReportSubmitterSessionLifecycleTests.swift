// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Independent review, round 14 (codex round 12), Serious 3 — round 13's
// `IdentityHeaderRedirectGuard` fix (see that type's own doc comment) made
// `ReportSubmitter.makeIsolatedSession()` install a session DELEGATE, which
// made every session it builds delegate-backed. Apple documents that a
// delegate-backed `URLSession` is retained by the system until
// `invalidateAndCancel()` or `finishTasksAndInvalidate()` is called — it is
// not simply deallocated once nothing references it. `ReportSubmitter.init`'s
// default `session:` parameter used to call `makeIsolatedSession()` fresh on
// every construction, and `ReporterSubmission.swift` builds a brand new
// `ReportSubmitter` for every ordinary report — so every submission leaked
// one more session, delegate, and delegate queue for the life of the
// process.
//
// Fix: `makeIsolatedSession()` now returns ONE shared, process-lifetime
// session (a `static let`, Swift's own thread-safe lazy-singleton
// mechanism) instead of building a fresh one per call — never invalidated,
// so there is no "wrong moment" to invalidate it and no risk of the trap
// the coordinator named explicitly: calling `finishTasksAndInvalidate()` at
// the wrong time would cancel whatever upload is currently in flight, and
// this branch has already turned an identity fix into a dropped report
// three times.
//
// `Transport/ReportSubmitter.swift` is not UIKit-gated, so this runs on the
// macOS host build like `IdentityHeaderRedirectTests`/`DrainIdentityHeaderTests`.
import XCTest
@testable import EverframeKit

final class ReportSubmitterSessionLifecycleTests: XCTestCase {

    private var server: RecordingHTTPServer!
    private var tempDir: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        server = try RecordingHTTPServer()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("everframe-submitter-lifecycle-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        server.respond = { _ in (200, ["Content-Type": "application/json"], Data("{}".utf8)) }
    }

    override func tearDownWithError() throws {
        server?.stop()
        try? FileManager.default.removeItem(at: tempDir)
        try super.tearDownWithError()
    }

    private func makeOutbox() -> JSONLOutbox {
        JSONLOutbox(testFileURL: tempDir.appendingPathComponent("outbox.jsonl"))
    }

    /// THE test that would have caught the defect directly: repeated calls
    /// must not accumulate sessions — `makeIsolatedSession()` must return
    /// the SAME instance every time, not a fresh delegate-backed one.
    /// Mutation-verified: reverting `makeIsolatedSession()` to build a new
    /// `URLSession(...)` per call makes this fail (`a !== b`).
    func testMakeIsolatedSessionReturnsTheSameProcessLifetimeSessionEveryCall() {
        let a = ReportSubmitter.makeIsolatedSession()
        let b = ReportSubmitter.makeIsolatedSession()
        XCTAssertTrue(
            a === b,
            "makeIsolatedSession() must return the SAME process-lifetime session on every call — a fresh " +
                "delegate-backed session per call is exactly the leak this fix closes"
        )
    }

    /// The observable consequence of that identity, driven through the REAL
    /// production path: constructing MANY separate `ReportSubmitter`
    /// instances (exactly what `ReporterSubmission.swift` does for every
    /// ordinary report) and submitting through each must not accumulate
    /// sessions AND every single one of those submissions must still
    /// complete. This is also the negative check on the OTHER candidate fix
    /// (invalidate-per-submitter): if a submitter's session were invalidated
    /// after its own submit, sharing it across the DEFAULT-constructed
    /// instances below would make every submission after the first fail
    /// outright (`invalidated and can no longer be used`) — this test would
    /// catch that regression too, not just a session-identity mismatch.
    private func captureTokenHeader(_ r: RecordingHTTPServer.RecordedRequest) -> String? {
        r.headers.first { $0.key.lowercased() == "x-everframe-capture-token" }?.value
    }

    /// The capture token rides the live attempt only. A retryable failure
    /// queues the report; the outbox bytes must not contain the token and the
    /// replayed request must carry no token header.
    func testCaptureTokenNotPersistedToOutbox() async throws {
        let outboxURL = tempDir.appendingPathComponent("outbox.jsonl")
        let box = JSONLOutbox(testFileURL: outboxURL)
        let submitter = ReportSubmitter(config: EverframeConfig(sdkKey: "app"), outbox: box)

        server.respond = { _ in (503, [:], Data()) }
        let result = try await submitter.submit(
            envelopeBytes: Data("{}".utf8), idempotencyKey: "idem-cap-1", attachments: [],
            captureToken: "tok-secret-123", endpoint: server.url.absoluteString)
        guard case .queued = result else { return XCTFail("503 must queue the report — got \(result)") }

        XCTAssertEqual(server.recorded.count, 1)
        XCTAssertEqual(captureTokenHeader(server.recorded[0]), "tok-secret-123",
            "not vacuous: the live attempt carried the token")

        let persisted = try Data(contentsOf: outboxURL)
        XCTAssertFalse(persisted.isEmpty, "the entry must really be in the outbox")
        XCTAssertNil(persisted.range(of: Data("tok-secret-123".utf8)), "token must never reach the outbox bytes")

        server.respond = { _ in (200, ["Content-Type": "application/json"], Data("{}".utf8)) }
        await submitter.drainOutbox(identityHolder: IdentityTokenHolder(),
            currentReplayConfig: { await ReplayConfigProvider(configUrl: URL(string: "https://everframe.dev/api/config")!, sdkKey: "app").current }, epochAtInitiation: 0, currentEpoch: { 0 })
        XCTAssertEqual(server.recorded.count, 2, "the queued entry must be replayed")
        XCTAssertNil(captureTokenHeader(server.recorded[1]), "a replayed upload must carry no capture token")
    }

    func testRepeatedSubmissionsThroughSeparatelyConstructedSubmittersAllStillComplete() async throws {
        let sessionsSeen = NSMutableSet()

        for i in 0..<5 {
            let submitter = ReportSubmitter(config: EverframeConfig(sdkKey: "app"), outbox: makeOutbox())
            sessionsSeen.add(ReportSubmitter.makeIsolatedSession())

            let result = try await submitter.submit(
                envelopeBytes: Data("{}".utf8),
                idempotencyKey: "idem-lifecycle-\(i)",
                attachments: [],
                endpoint: server.url.absoluteString
            )
            guard case .submitted = result else {
                XCTFail("submission \(i) must complete via the shared session — got \(result)")
                return
            }
        }

        XCTAssertEqual(
            sessionsSeen.count, 1,
            "five separately-constructed ReportSubmitters must all resolve to exactly ONE shared session"
        )
        XCTAssertEqual(
            server.recorded.count, 5,
            "not vacuous: all five submissions must actually have reached the server"
        )
    }
}
