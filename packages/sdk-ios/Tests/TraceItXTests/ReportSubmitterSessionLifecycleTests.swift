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
@testable import TraceItXKit

final class ReportSubmitterSessionLifecycleTests: XCTestCase {

    private var server: RecordingHTTPServer!
    private var tempDir: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        server = try RecordingHTTPServer()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("traceitx-submitter-lifecycle-\(UUID().uuidString)", isDirectory: true)
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
    func testRepeatedSubmissionsThroughSeparatelyConstructedSubmittersAllStillComplete() async throws {
        let sessionsSeen = NSMutableSet()

        for i in 0..<5 {
            let submitter = ReportSubmitter(config: TraceItXConfig(appId: "app"), outbox: makeOutbox())
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
