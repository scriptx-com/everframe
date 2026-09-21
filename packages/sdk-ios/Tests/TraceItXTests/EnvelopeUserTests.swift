// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Self-declared identity (spec 2026-08-12), iOS half. `TraceItX.shared.setUser`
// has always stored `_user` (TraceItX.swift) and nothing ever read it back:
// `EnvelopeBuilder` has always known how to turn
// `extra["user.id"|"user.email"|"user.displayName"]` into `envelope.reporter.user`
// (a TOP-LEVEL field, sibling of `payload` — see `EnvelopeBuilder.swift`'s
// `Reporter(description:title:user:)` call and its `let user: User? = { ... }`
// reader just above), but nothing ever WROTE those three extras keys. This
// file locks the write side.
//
// `CrashReporter.captureFacts` (RN JS-error/crash path) is exercised
// BEHAVIOURALLY below via the real outbox entry it persists — it's plain
// synchronous Foundation code (see CrashReporter.swift's header comment), so
// no UIKit and no network are needed to drive it for real.
//
// `ReporterSubmission.swift` (the in-app screenshot-reporter path) can't be
// driven the same way from this suite: the whole type lives inside
// `#if canImport(UIKit)` and simply does not exist when `swift test
// --package-path packages/sdk-ios` runs on a plain macOS host (no UIKit
// there) — see `ReporterSubmissionMultiShotTests.swift`'s header comment for
// the established precedent. Even on a host that DOES have UIKit,
// `submit(_:)` constructs its own network `ReportSubmitter` with no
// injection seam, which is exactly why `CompanionSubmitBridgeTests.swift`'s
// header comment says the full envelope-build + ReportSubmitter network path
// "is NOT exercised" by any existing test in this target. Since a hermetic
// behavioural run of that path is unavailable here, `ReporterSubmission`'s
// half is covered by a source gate below — the same convention this target
// already uses for an identical problem (see
// `CompanionAttributionHeaderTests.swift`'s
// `..._CompanionCaptureBridgeSourceGate`) — pinning the block's presence AND
// its placement: after `includeMetadata` closes, before the
// `extraOverrides` merge, so an explicit override still wins.
import XCTest
@testable import TraceItXKit

final class EnvelopeUserTests: XCTestCase {
    private var tempDir: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("traceitx-envelope-user-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        // TraceItX.shared is a process-wide singleton whose state persists
        // across every test in this target — reset it before AND after each
        // test so a leftover user here can never leak into another suite
        // (or a later test in this one).
        //
        // `setUser` is gated on `captureGate` (external review, finding 2), so
        // this clear lands only while a session is installed — which is
        // exactly when there is anything to clear: `start()` and `kill()` both
        // clear `_user` themselves, making "gate closed ⟹ no user" an
        // invariant. Either way this returns to no-user.
        TraceItX.shared.setUser(nil)
        CrashReporter.__afterUserSnapshotHookForTesting = nil
        TraceItX.__resetBodyStateResetHookForTesting()
    }

    override func tearDownWithError() throws {
        TraceItX.shared.setUser(nil)
        CrashReporter.__afterUserSnapshotHookForTesting = nil
        TraceItX.__resetBodyStateResetHookForTesting()
        // Independent review, round 4 (Serious 3) — process-wide singleton
        // state, same reasoning as the resets above; `start()`/`kill()`
        // already reset this to false too, but this suite's crash-only
        // tests don't always call either between cases.
        TraceItX.shared._identityEnabledFlag.set(false)
        TraceItX.shared.__replayConfigOverrideForTesting = nil
        try super.tearDownWithError()
    }

    private func makeOutbox() -> JSONLOutbox {
        JSONLOutbox(testFileURL: tempDir.appendingPathComponent("outbox.jsonl"))
    }

    /// Build an unsigned-but-well-formed JWT with the given claims — mirrors
    /// `IdentityTokenHolderTests.jwt`/`CrashDrainIdentityHeaderTests.jwt`.
    /// `IdentityTokenHolder` never verifies signatures; only
    /// `the server identity-token verifier` does, server-side.
    private func jwt(sub: String, exp: Date) -> String {
        let header = #"{"alg":"HS256","typ":"JWT"}"#.data(using: .utf8)!
        let payload = try! JSONSerialization.data(withJSONObject: ["sub": sub, "exp": Int(exp.timeIntervalSince1970)])
        func b64(_ d: Data) -> String {
            d.base64EncodedString()
                .replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
        }
        return "\(b64(header)).\(b64(payload)).not-a-real-signature"
    }

    /// Arms `__replayConfigOverrideForTesting` with an identity-enabled
    /// config — the synchronous seam `captureUserSnapshot()` now also
    /// checks (independent review, round 4, Serious 3) alongside the
    /// existing `_identityEnabledFlag` production path. `replayEnabled:
    /// false` — these tests are not exercising replay.
    private func armIdentityEnabled() {
        TraceItX.shared.__replayConfigOverrideForTesting = ReplayConfig(
            replayEnabled: false, replayDurationSec: 30, samplingRate: 1.0,
            identity: IdentityConfigWire(enabled: true)
        )
    }

    /// The suite's ordinary session config. `capture: CaptureConfig(logs:
    /// false)` keeps `start()` from installing the stderr intercept, matching
    /// `KillSwitchTests`' isolation for the same reason.
    private static func sessionConfig(
        appId: String = "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"
    ) -> TraceItXConfig {
        TraceItXConfig(appId: appId, capture: CaptureConfig(logs: false))
    }

    /// Install a session, so `setUser` has an open capture gate to write
    /// through. Every `setUser` case in this file goes through here: since
    /// external review finding 2, "call `setUser` after `start`" is not a
    /// recommendation on iOS either — a call made earlier is dropped.
    private func startSession(appId: String = "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU") throws {
        try TraceItX.shared.start(config: Self.sessionConfig(appId: appId))
    }

    /// Drives `CrashReporter.captureFacts` (mirrors
    /// `CrashReporterTests.testCaptureFactsPersistsRedactedCrashEnvelope`'s
    /// construction idiom) and decodes the persisted envelope's top-level
    /// `reporter` object — a sibling of `payload`, never nested under it.
    private func captureAndDecodeReporter() throws -> [String: Any] {
        let outbox = makeOutbox()
        let json = """
        {"exceptionType":"TypeError","message":"boom","framesRaw":[],"mechanism":"errorutils","fatal":true,"occurredAt":"2026-08-12T00:00:00Z"}
        """
        let ok = CrashReporter.captureFacts(json: json, outbox: outbox, config: TraceItXConfig(appId: "app"))
        XCTAssertTrue(ok)
        let entry = try XCTUnwrap(try outbox.hydrate().first)
        let env = try JSONSerialization.jsonObject(with: entry.envelopeBytes) as! [String: Any]
        return try XCTUnwrap(env["reporter"] as? [String: Any])
    }

    func testSetUserReachesEnvelope() throws {
        try startSession()
        TraceItX.shared.setUser(TXUser(id: "u_1", email: "a@b.com", displayName: "A"))
        let reporter = try captureAndDecodeReporter()
        let user = try XCTUnwrap(reporter["user"] as? [String: Any])
        XCTAssertEqual(user["id"] as? String, "u_1")
        XCTAssertEqual(user["email"] as? String, "a@b.com")
        XCTAssertEqual(user["displayName"] as? String, "A")
    }

    func testNoUserYieldsNilUser() throws {
        TraceItX.shared.setUser(nil)
        let reporter = try captureAndDecodeReporter()
        XCTAssertNil(reporter["user"])
    }

    /// A user with only an email is legitimate — the server's keying rule
    /// falls back to email when no id is present (spec 2026-08-12). Each key
    /// must be written only when its value is non-nil, so a partially
    /// populated `TXUser` produces a partially populated `user` object
    /// rather than empty strings standing in for the missing fields.
    /// External review, finding 2 (Serious) — `kill()` bumped the start epoch,
    /// flipped the capture gate and zeroized the breadcrumb + network-body ring
    /// buffers, but never cleared `_user`. Restart after kill is explicitly
    /// supported (`KillSwitchTests.startAfterKillReenablesCapture`), so
    /// `start → setUser(A) → kill → start → report` attributed the NEW
    /// session's report to A with no `setUser` call anywhere in it — a
    /// GDPR/kill-switch posture problem in exactly the terms `kill()`'s own
    /// buffer-zeroization comments already use ("so nothing captured before
    /// the kill can ship afterward"). Android already cleared `_user` inside
    /// `kill()`'s `stateLock` block; this locks the iOS half.
    ///
    /// Asserted behaviourally, through the crash path's real envelope, not
    /// just via `currentUser` — that is where a leftover user actually
    /// reaches a report (`CrashReporter.captureFacts` reads
    /// `TraceItX.shared.currentUser`). `capture: CaptureConfig(logs: false)`
    /// keeps `start()` from installing the stderr intercept, matching
    /// `KillSwitchTests`' isolation for the same reason.
    func testKillClearsUserSoTheNextSessionIsAnonymous() throws {
        let config = TraceItXConfig(
            appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU",
            capture: CaptureConfig(logs: false)
        )
        try TraceItX.shared.start(config: config)
        TraceItX.shared.setUser(TXUser(id: "u_1", email: "a@b.com", displayName: "A"))

        TraceItX.shared.kill()
        XCTAssertNil(TraceItX.shared.currentUser, "kill() must not leave the self-declared user set")

        // The next session — no setUser call anywhere in it.
        try TraceItX.shared.start(config: config)
        let reporter = try captureAndDecodeReporter()
        XCTAssertNil(reporter["user"], "a killed session's user must not attribute the next session's report")
    }

    /// External review, finding 2 (Serious) — the sibling of the `kill()` case
    /// above, and the more dangerous one. `start()` replaced `_config` (and
    /// with it the SDK key, i.e. the PROJECT every subsequent report is
    /// uploaded to) without clearing `_user`, so the supported
    /// `start(projectA) → setUser(X) → start(projectB)` sequence uploaded A's
    /// id/email/display name under B's key — a falsely attributed person
    /// created in a DIFFERENT customer's project. React Native makes it
    /// especially reachable: unmounting the provider leaves native user state
    /// intact, so a remount + reconfigure inherits the previous user.
    ///
    /// The rule is unconditional and stateable in one sentence: **`start()`
    /// always begins a session with no user; call `setUser` after `start`.**
    /// A same-key re-`start()` clears too. Comparing configs to decide would
    /// need an equality over `TraceItXConfig` (which carries closures and is
    /// not `Equatable`), and would make a privacy-relevant behaviour depend on
    /// a predicate no integrator can evaluate in their head. It also costs
    /// nothing correct: web's `setUser` is already a no-op before `init`
    /// (`client.ts` returns early with no config) and Android's is a no-op
    /// while the capture gate is closed, so "set the user after start" is
    /// already the only ordering that works cross-platform.
    ///
    /// Asserted behaviourally through the crash path's real envelope, exactly
    /// like the `kill()` case — that is where a leftover user actually reaches
    /// a report.
    func testStartClearsTheUserSoASecondProjectIsNotAttributedToTheFirst() throws {
        let projectA = TraceItXConfig(
            appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU",
            capture: CaptureConfig(logs: false)
        )
        let projectB = TraceItXConfig(
            appId: "txx_live_9wPQrSt2UvWxYz3AbCdEfGh4IjKlMn5O",
            capture: CaptureConfig(logs: false)
        )
        try TraceItX.shared.start(config: projectA)
        TraceItX.shared.setUser(TXUser(id: "u_1", email: "a@b.com", displayName: "A"))

        // Reconfigure onto a DIFFERENT project — no setUser call in the new
        // session anywhere.
        try TraceItX.shared.start(config: projectB)
        XCTAssertNil(
            TraceItX.shared.currentUser,
            "start() must not carry the previous configuration's user into the new one"
        )
        let reporter = try captureAndDecodeReporter()
        XCTAssertNil(
            reporter["user"],
            "project A's user must never be uploaded under project B's SDK key"
        )
    }

    /// The same rule for a benign re-init with the SAME key. Stated separately
    /// because it is the case an integrator is most likely to assume is exempt
    /// — and the one that makes the rule a rule rather than a special case.
    func testAnIdenticalRestartAlsoClearsTheUser() throws {
        let config = TraceItXConfig(
            appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU",
            capture: CaptureConfig(logs: false)
        )
        try TraceItX.shared.start(config: config)
        TraceItX.shared.setUser(TXUser(id: "u_1"))

        try TraceItX.shared.start(config: config)
        XCTAssertNil(TraceItX.shared.currentUser, "a same-key restart clears the user too")
    }

    // MARK: - Captured-user session binding (external review, finding 1)

    /// External review, finding 1 (Serious). The previous round snapshotted the
    /// user at the Send tap, but `ReporterSubmission.submit(_:)` reads the
    /// CONFIG — which carries the SDK key, i.e. the project the envelope is
    /// uploaded to — asynchronously, much later. Those two reads are not
    /// atomic, so `setUser(A) → [Send] → start(projectB) → submit` uploaded A's
    /// id/email/display name under B's key: a falsely attributed person in a
    /// different customer's project. The `start()`-clears-the-user fix from the
    /// previous round is what makes the SURVIVING snapshot dangerous — the live
    /// singleton is clean, the snapshot is not.
    ///
    /// The snapshot now carries the session (`_startEpoch`) it was taken in,
    /// captured in the SAME `stateLock` critical section as the user, and
    /// `resolve()` discards it once that session is superseded.
    ///
    /// This is the core mechanism `ReporterSubmission.submit(_:)` and
    /// `CompanionCaptureBridge` both go through; the two submit files
    /// themselves are `#if canImport(UIKit)`-gated and absent on this host (see
    /// the file header), so their use of it is pinned by the source gate below.
    func testACapturedUserIsDiscardedWhenAnotherProjectStartsBeforeItIsResolved() throws {
        let projectA = TraceItXConfig(
            appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU",
            capture: CaptureConfig(logs: false)
        )
        let projectB = TraceItXConfig(
            appId: "txx_live_9wPQrSt2UvWxYz3AbCdEfGh4IjKlMn5O",
            capture: CaptureConfig(logs: false)
        )
        try TraceItX.shared.start(config: projectA)
        TraceItX.shared.setUser(TXUser(id: "u_1", email: "a@b.com", displayName: "A"))

        // The Send tap: user + session captured atomically.
        let captured = TraceItX.shared.captureUserSnapshot()
        XCTAssertEqual(captured.user?.id, "u_1", "the snapshot must actually hold the user (non-vacuous)")

        // Async prep is still running when the host reconfigures onto a
        // DIFFERENT project — the moment `submit` would read project B's key.
        try TraceItX.shared.start(config: projectB)

        XCTAssertNil(
            captured.resolve(),
            "a user captured under project A must never resolve after project B was installed"
        )
    }

    /// The negative control the finding explicitly calls for: a fix that
    /// dropped the user unconditionally would pass the case above. With no
    /// restart in the window, the captured user must still be the one that
    /// reaches the envelope.
    func testACapturedUserSurvivesWhenNoRestartIntervenes() throws {
        let config = TraceItXConfig(
            appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU",
            capture: CaptureConfig(logs: false)
        )
        try TraceItX.shared.start(config: config)
        TraceItX.shared.setUser(TXUser(id: "u_1", email: "a@b.com", displayName: "A"))

        let captured = TraceItX.shared.captureUserSnapshot()
        let resolved = try XCTUnwrap(captured.resolve(), "no start()/kill() ran — the user must survive")
        XCTAssertEqual(resolved.id, "u_1")
        XCTAssertEqual(resolved.email, "a@b.com")
        XCTAssertEqual(resolved.displayName, "A")

        // And it stays pinned to the SNAPSHOT, not the live singleton: an
        // account switch inside the same session must not repoint it (the
        // previous round's finding, re-asserted through the new type).
        TraceItX.shared.setUser(TXUser(id: "u_2", email: "b@b.com"))
        XCTAssertEqual(captured.resolve()?.id, "u_1", "the snapshot must not follow a later setUser")
    }

    /// `kill()` bumps the same epoch, for the same reason: a report whose prep
    /// straddles an emergency kill must not carry the killed session's user.
    func testACapturedUserIsDiscardedAfterKill() throws {
        let config = TraceItXConfig(
            appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU",
            capture: CaptureConfig(logs: false)
        )
        try TraceItX.shared.start(config: config)
        TraceItX.shared.setUser(TXUser(id: "u_1"))
        let captured = TraceItX.shared.captureUserSnapshot()

        TraceItX.shared.kill()

        XCTAssertNil(captured.resolve(), "a killed session's captured user must not ship")
    }

    /// External review, finding 9 (Serious) — the epoch guard's one blind
    /// spot: a snapshot taken INSIDE `start()`, between its two `stateLock`
    /// critical sections.
    ///
    /// `start()` used to bump `_startEpoch` in the first section and clear
    /// `_user` in the second, with `NetworkBodyCaptureGate.reset()` /
    /// `NetworkBodyRingBuffer.clear()` in between. A `captureUserSnapshot()`
    /// landing in that gap read A's user paired with B's epoch — in ONE
    /// acquisition, so the pair was internally consistent and looked valid.
    /// `resolve()` then compared B's epoch against B's epoch, matched, and
    /// handed back A's person to be uploaded under B's SDK key. The guard
    /// cannot see this: it is built to catch a CHANGING epoch, and here the
    /// captured epoch was already the new one.
    ///
    /// `__bodyStateResetHookForTesting` fires at exactly that instant — it is
    /// the only reachable point between the two sections — which makes the
    /// window deterministic instead of a real thread race that would fail
    /// only occasionally. The fix moves `_user = nil` up into the epoch-bump
    /// section, so this observation now yields no user at all.
    func testASnapshotTakenInsideStartsResetWindowCannotResolve() throws {
        let projectB = TraceItXConfig(
            appId: "txx_live_9wPQrSt2UvWxYz3AbCdEfGh4IjKlMn5O",
            capture: CaptureConfig(logs: false)
        )
        try startSession()
        TraceItX.shared.setUser(TXUser(id: "u_1", email: "a@b.com", displayName: "A"))
        let epochUnderProjectA = TraceItX.shared.currentStartEpoch

        var capturedInWindow: TXCapturedUser?
        TraceItX.__bodyStateResetHookForTesting = {
            capturedInWindow = TraceItX.shared.captureUserSnapshot()
        }
        defer { TraceItX.__resetBodyStateResetHookForTesting() }

        try TraceItX.shared.start(config: projectB)

        let captured = try XCTUnwrap(
            capturedInWindow,
            "the in-start() window hook never fired — the test exercises nothing"
        )
        // Non-vacuity, and the whole point of the case: the snapshot really was
        // taken with project B's epoch already installed, so the epoch guard
        // WILL pass on it. Anything the snapshot holds at this instant ships.
        XCTAssertNotEqual(
            captured.startEpoch, epochUnderProjectA,
            "the snapshot must have been taken after the epoch bump — otherwise the epoch guard alone explains the nil below and this case proves nothing"
        )
        XCTAssertEqual(
            captured.startEpoch, TraceItX.shared.currentStartEpoch,
            "the captured epoch must be project B's live epoch — that is what makes resolve() pass its guard"
        )
        XCTAssertNil(
            captured.user,
            "start() must clear _user in the SAME critical section that bumps the epoch — no observer may ever see B's epoch alongside A's user"
        )
        XCTAssertNil(
            captured.resolve(),
            "a user snapshotted inside start()'s reset window must never resolve — it would upload project A's person under project B's SDK key"
        )
    }

    // MARK: - Crash entry boundary (round-5 external review, finding 2)

    /// `CrashReporter.captureFacts` used to read `TraceItX.shared.currentUser`
    /// at envelope-assembly time — after JSON parsing, after `RedactionEngine`
    /// had run over the message and up to 256 stack frames, after
    /// fingerprinting and after device-metadata assembly. On a multi-threaded
    /// runtime a `setUser(B)` landing in that window attributed A's crash to B.
    ///
    /// Driven through the real `captureFacts` → outbox → envelope path, with
    /// `__afterUserSnapshotHookForTesting` standing in for that window
    /// (deterministically: a real background `setUser` race would only fail
    /// this test sometimes).
    func testACrashCarriesTheUserActiveAtCrashEntryNotAtEncodeTime() throws {
        try startSession()
        TraceItX.shared.setUser(TXUser(id: "u_1", email: "a@b.com", displayName: "A"))
        CrashReporter.__afterUserSnapshotHookForTesting = {
            TraceItX.shared.setUser(TXUser(id: "u_2", email: "b@b.com", displayName: "B"))
        }

        let reporter = try captureAndDecodeReporter()

        // Non-vacuity: the switch really did land inside the processing window.
        XCTAssertEqual(
            TraceItX.shared.currentUser?.id, "u_2",
            "the hook must actually have switched the live user — otherwise this asserts nothing"
        )
        let user = try XCTUnwrap(
            reporter["user"] as? [String: Any],
            "the crash must still be attributed — no switch invalidated the session"
        )
        XCTAssertEqual(
            user["id"] as? String, "u_1",
            "the crash must carry the user active at crash ENTRY, not whoever setUser named while it was being encoded"
        )
        XCTAssertEqual(user["email"] as? String, "a@b.com")
        XCTAssertEqual(user["displayName"] as? String, "A")
    }

    /// The control the finding explicitly calls for: with nothing switching in
    /// the window, the crash still carries the user. A "fix" that dropped the
    /// user unconditionally would pass the case above and fail here.
    /// (`testSetUserReachesEnvelope` covers the no-hook shape; this pins that
    /// merely ENTERING the window — the hook firing at all — changes nothing.)
    func testACrashKeepsItsUserWhenNothingSwitchesDuringProcessing() throws {
        try startSession()
        TraceItX.shared.setUser(TXUser(id: "u_1", email: "a@b.com", displayName: "A"))
        var hookRan = false
        CrashReporter.__afterUserSnapshotHookForTesting = { hookRan = true }

        let reporter = try captureAndDecodeReporter()

        XCTAssertTrue(hookRan, "the crash-processing window hook never fired — the test proves nothing")
        let user = try XCTUnwrap(reporter["user"] as? [String: Any])
        XCTAssertEqual(user["id"] as? String, "u_1")
        XCTAssertEqual(user["email"] as? String, "a@b.com")
        XCTAssertEqual(user["displayName"] as? String, "A")
    }

    /// The project-crossing half of the same finding: a `start(projectB)` during
    /// crash processing must degrade the crash to anonymous rather than ship
    /// project A's person. `start()` clears the LIVE user, so only the snapshot
    /// could have carried it across — which is exactly what the epoch guard is
    /// for.
    func testACrashIsAnonymousWhenAnotherProjectStartsDuringProcessing() throws {
        let projectB = TraceItXConfig(
            appId: "txx_live_9wPQrSt2UvWxYz3AbCdEfGh4IjKlMn5O",
            capture: CaptureConfig(logs: false)
        )
        try startSession()
        TraceItX.shared.setUser(TXUser(id: "u_1", email: "a@b.com", displayName: "A"))
        CrashReporter.__afterUserSnapshotHookForTesting = {
            try? TraceItX.shared.start(config: projectB)
            // The realistic continuation: someone signs in to project B. Without
            // this the case would pass even against a LIVE `currentUser` read,
            // because `start()` clears the live user — it would only be testing
            // the epoch guard, not the crash-entry boundary.
            TraceItX.shared.setUser(TXUser(id: "u_2", email: "b@b.com", displayName: "B"))
        }

        let reporter = try captureAndDecodeReporter()

        // Non-vacuity: project B really is the installed session, with its own
        // signed-in user, by the time the envelope is assembled.
        XCTAssertEqual(TraceItX.shared.currentConfig?.appId, projectB.appId)
        XCTAssertEqual(TraceItX.shared.currentUser?.id, "u_2")
        XCTAssertNil(
            reporter["user"],
            "a crash captured under project A must never ship A's person once project B is installed"
        )
    }

    /// Independent review, P1 — the crash path has the identical shape to
    /// `ReporterSubmission.swift`'s live-submit fix. `capturedUser.resolve()`
    /// (asserted just above by
    /// `testACrashIsAnonymousWhenAnotherProjectStartsDuringProcessing`)
    /// already drops the self-declared USER on an epoch mismatch — but the
    /// raw `capturedUser.identitySubject` field, unlike `.user`, has no
    /// built-in gate of its own, so `CrashReporter.swift` used to persist it
    /// onto the `OutboxEntry` unconditionally even when the captured session
    /// no longer matched. A later drain could then attach a header on the
    /// strength of a subject the SDK had already concluded, via the SAME
    /// epoch check, it should not rely on.
    ///
    /// Uses `setIdentityToken` (self-caching, synchronous for `.token(...)`
    /// — see `IdentityTokenHolderTests`) so `captureUserSnapshot()`'s
    /// `_identityHolder.cachedSubject(now:)` read is non-nil at crash entry,
    /// then switches projects inside the crash-processing window via
    /// `__afterUserSnapshotHookForTesting` — the same deterministic
    /// substitute for a real background race the sibling user tests in this
    /// file use. Project B is ALSO given a live token for the SAME `sub`
    /// ("alice"), so a persisted subject would still (wrongly) match a live
    /// token if the fix regressed — this proves the withholding is the
    /// epoch check, not an incidental subject mismatch.
    func testACrashOutboxEntryCarriesNoIdentitySubjectWhenAnotherProjectStartsDuringProcessing() throws {
        let projectB = TraceItXConfig(
            appId: "txx_live_9wPQrSt2UvWxYz3AbCdEfGh4IjKlMn5O",
            capture: CaptureConfig(logs: false)
        )
        try startSession()
        // Non-vacuity (independent review, round 4, Serious 3): arm identity
        // as ENABLED for project A before the capture, so the nil assertion
        // below is attributable to the epoch mismatch this test targets, not
        // merely the round-4/5 identity-enabled gate defaulting to off.
        armIdentityEnabled()
        let now = Date()
        TraceItX.shared.setIdentityToken(.token(jwt(sub: "alice", exp: now.addingTimeInterval(300))))
        CrashReporter.__afterUserSnapshotHookForTesting = { [self] in
            try? TraceItX.shared.start(config: projectB)
            TraceItX.shared.setIdentityToken(.token(jwt(sub: "alice", exp: now.addingTimeInterval(300))))
        }

        let outbox = makeOutbox()
        let json = """
        {"exceptionType":"TypeError","message":"boom","framesRaw":[],"mechanism":"errorutils","fatal":true,"occurredAt":"2026-08-12T00:00:00Z"}
        """
        let ok = CrashReporter.captureFacts(json: json, outbox: outbox, config: TraceItXConfig(appId: "app"))
        XCTAssertTrue(ok)
        let entry = try XCTUnwrap(try outbox.hydrate().first)

        // Non-vacuity: project B really is installed, with its own live
        // "alice" token, by the time the entry is enqueued.
        XCTAssertEqual(TraceItX.shared.currentConfig?.appId, projectB.appId)

        XCTAssertNil(
            entry.identitySubject,
            """
            a crash entry captured under project A must never persist a subject once project B has \
            started during processing — even though B's live token's sub ("alice") still matches. \
            An epoch mismatch means the SDK already decided the whole captured snapshot is \
            untrustworthy, not just the self-declared user half of it.
            """
        )
    }

    /// The control the finding explicitly calls for: with nothing switching
    /// in the window, the crash entry still carries the captured subject. A
    /// "fix" that dropped identitySubject unconditionally would pass the
    /// case above and fail here.
    func testACrashOutboxEntryKeepsItsIdentitySubjectWhenNothingSwitchesDuringProcessing() throws {
        try startSession()
        // Independent review, round 4 (Serious 3) — this test's own point is
        // the epoch/hook mechanism, not the identity-enabled gate, so arm it
        // the same way the sibling test above does.
        armIdentityEnabled()
        let now = Date()
        TraceItX.shared.setIdentityToken(.token(jwt(sub: "alice", exp: now.addingTimeInterval(300))))
        var hookRan = false
        CrashReporter.__afterUserSnapshotHookForTesting = { hookRan = true }

        let outbox = makeOutbox()
        let json = """
        {"exceptionType":"TypeError","message":"boom","framesRaw":[],"mechanism":"errorutils","fatal":true,"occurredAt":"2026-08-12T00:00:00Z"}
        """
        let ok = CrashReporter.captureFacts(json: json, outbox: outbox, config: TraceItXConfig(appId: "app"))
        XCTAssertTrue(ok)

        XCTAssertTrue(hookRan, "the crash-processing window hook never fired — the test proves nothing")
        let entry = try XCTUnwrap(try outbox.hydrate().first)
        XCTAssertEqual(entry.identitySubject, "alice")
    }

    // MARK: - Identity-disabled capture boundary (independent review, round 4, Serious 3)

    /// `captureUserSnapshot()` used to stamp `identitySubject` from the
    /// token cache unconditionally — never consulting whether identity is
    /// even ENABLED for the project. The live submit boundary already
    /// correctly withholds the header via `resolveIdentityHeader`'s own
    /// `isIdentityEnabled` check, but the raw subject still reached the
    /// persisted `OutboxEntry` — inconsistent with the header decision, the
    /// same shape as the round-4 epoch fix. A later drain could then attach
    /// a header on the strength of a subject captured while the SDK had
    /// already decided, at capture time, not to attribute anything.
    ///
    /// Deliberately does NOT call `armIdentityEnabled()` — identity is
    /// disabled by default (fail-closed) until a real config fetch
    /// resolves it, which never happens in this suite outside that seam.
    func testACrashOutboxEntryCarriesNoIdentitySubjectWhenIdentityIsDisabledAtCapture() throws {
        try startSession()
        let now = Date()
        TraceItX.shared.setIdentityToken(.token(jwt(sub: "alice", exp: now.addingTimeInterval(300))))

        let outbox = makeOutbox()
        let json = """
        {"exceptionType":"TypeError","message":"boom","framesRaw":[],"mechanism":"errorutils","fatal":true,"occurredAt":"2026-08-12T00:00:00Z"}
        """
        let ok = CrashReporter.captureFacts(json: json, outbox: outbox, config: TraceItXConfig(appId: "app"))
        XCTAssertTrue(ok)
        let entry = try XCTUnwrap(try outbox.hydrate().first)

        XCTAssertNil(
            entry.identitySubject,
            "a crash entry captured while identity is disabled for the project must never persist a subject, even with a live cached token"
        )
    }

    /// Non-vacuity / negative control: the SAME token, with identity
    /// ENABLED at capture, DOES get stamped — proving the case above tests
    /// the enabled gate specifically, not e.g. a broken token cache.
    func testACrashOutboxEntryCarriesTheIdentitySubjectWhenIdentityIsEnabledAtCapture() throws {
        try startSession()
        armIdentityEnabled()
        let now = Date()
        TraceItX.shared.setIdentityToken(.token(jwt(sub: "alice", exp: now.addingTimeInterval(300))))

        let outbox = makeOutbox()
        let json = """
        {"exceptionType":"TypeError","message":"boom","framesRaw":[],"mechanism":"errorutils","fatal":true,"occurredAt":"2026-08-12T00:00:00Z"}
        """
        let ok = CrashReporter.captureFacts(json: json, outbox: outbox, config: TraceItXConfig(appId: "app"))
        XCTAssertTrue(ok)
        let entry = try XCTUnwrap(try outbox.hydrate().first)

        XCTAssertEqual(entry.identitySubject, "alice")
    }

    /// The full scenario the finding calls for, end to end: capture while
    /// identity is disabled, THEN enable identity, THEN drain — the header
    /// must still be withheld. Proves the capture-time nil isn't merely
    /// cosmetic: a later drain cannot resurrect a header for an entry the
    /// SDK already decided, at capture time, not to attribute — even though
    /// the live holder's token would now match by subject.
    func testACrashEntryCapturedWhileIdentityIsDisabledDrainsWithNoHeaderEvenAfterIdentityIsEnabled() async throws {
        try startSession()
        // Identity OFF at capture time (default, not armed).
        let now = Date()
        let token = jwt(sub: "alice", exp: now.addingTimeInterval(300))
        TraceItX.shared.setIdentityToken(.token(token))

        let outbox = makeOutbox()
        let json = """
        {"exceptionType":"TypeError","message":"boom","framesRaw":[],"mechanism":"errorutils","fatal":true,"occurredAt":"2026-08-12T00:00:00Z"}
        """
        let ok = CrashReporter.captureFacts(json: json, outbox: outbox, config: TraceItXConfig(appId: "app"))
        XCTAssertTrue(ok)
        let capturedEntry = try XCTUnwrap(try outbox.hydrate().first)
        XCTAssertNil(capturedEntry.identitySubject, "fixture sanity: must be captured anonymous")

        // NOW identity turns on for the project — plausible, e.g. the host
        // adds a signing secret without restarting the app.
        armIdentityEnabled()

        RecordingURLProtocol.reset()
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [RecordingURLProtocol.self]
        let session = URLSession(configuration: cfg)
        let holder = IdentityTokenHolder()
        holder.set(.token(token))
        let drainSubmitter = ReportSubmitter(config: TraceItXConfig(appId: "app"), outbox: outbox, session: session)
        await drainSubmitter.drainOutbox(
            identityHolder: holder,
            currentReplayConfig: {
                ReplayConfig(
                    replayEnabled: false, replayDurationSec: 30, samplingRate: 1.0,
                    identity: IdentityConfigWire(enabled: true)
                )
            },
            epochAtInitiation: TraceItX.shared.currentStartEpoch,
            currentEpoch: { TraceItX.shared.currentStartEpoch }
        )

        XCTAssertEqual(RecordingURLProtocol.recorded.count, 1, "the report must actually be drained")
        XCTAssertNil(
            RecordingURLProtocol.recorded.first?.identityToken,
            "an entry captured while identity was disabled must drain with no header even once identity is later enabled and the subjects would match"
        )
    }

    // MARK: - Delayed-drain project staleness (independent review, round 8, Serious 1)

    /// THE scenario the finding describes: a drain is initiated under
    /// project A — a `ReportSubmitter` constructed with A's config, with
    /// `epochAtInitiation` captured synchronously in the SAME breath,
    /// exactly like `CrashReporter.swift`'s real non-fatal drain kickoff —
    /// but does not actually RUN until after `start(projectB)` has already
    /// landed, with project B ALSO identity-enabled and a live token for
    /// the SAME subject (plausible: `sub` is the host's own user id,
    /// unchanged across a tenant switch).
    ///
    /// The bug this closes: the OLD `drainOutbox` sampled its own epoch
    /// baseline from INSIDE its own body (`epochAtDrainStart =
    /// currentEpoch()`), which by the time the function actually ran would
    /// already reflect project B — a baseline that LOOKS like a valid
    /// "nothing changed" reading but is actually the wrong reference point
    /// entirely. `e.sdkKey == config.appId` (comparing the entry against
    /// the SUBMITTER's own frozen config, still "A") kept passing
    /// regardless, so project B's LIVE bearer token — resolved because its
    /// subject happens to match — could attach to a request still
    /// authorized with project A's SDK key, uploaded to project A's
    /// endpoint: disclosure of a live credential to the wrong project's
    /// host, not merely misattribution (`aud` verification stops the
    /// latter but not the former).
    ///
    /// Mutation-verified: reverting `drainOutbox` to derive its baseline
    /// internally (ignoring the caller-supplied `epochAtInitiation`) makes
    /// this fail — B's live token attaches.
    func testADelayedDrainWithholdsTheHeaderWhenAnotherProjectStartsBeforeItRuns() async throws {
        let projectA = TraceItXConfig(
            appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU",
            capture: CaptureConfig(logs: false)
        )
        let projectB = TraceItXConfig(
            appId: "txx_live_9wPQrSt2UvWxYz3AbCdEfGh4IjKlMn5O",
            capture: CaptureConfig(logs: false)
        )

        try TraceItX.shared.start(config: projectA)
        armIdentityEnabled()
        let now = Date()
        TraceItX.shared.setIdentityToken(.token(jwt(sub: "alice", exp: now.addingTimeInterval(300))))

        // Capture a non-fatal crash entry under project A, identity enabled,
        // alice signed in — a real subject reaches the entry.
        let outbox = makeOutbox()
        let json = """
        {"exceptionType":"TypeError","message":"boom","framesRaw":[],"mechanism":"errorutils","fatal":true,"occurredAt":"2026-08-12T00:00:00Z"}
        """
        let ok = CrashReporter.captureFacts(json: json, outbox: outbox, config: projectA)
        XCTAssertTrue(ok)
        let capturedEntry = try XCTUnwrap(try outbox.hydrate().first)
        XCTAssertEqual(capturedEntry.identitySubject, "alice", "fixture sanity: a real subject must reach the entry")
        XCTAssertEqual(capturedEntry.sdkKey, projectA.appId, "fixture sanity: the entry belongs to project A")

        // Mirrors CrashReporter.swift's real non-fatal drain kickoff
        // exactly: a submitter constructed under project A's config, with
        // epochAtInitiation captured synchronously in the same breath —
        // the values a real caller has BEFORE any Task-scheduling delay.
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [RecordingURLProtocol.self]
        let session = URLSession(configuration: cfg)
        let submitter = ReportSubmitter(config: projectA, outbox: outbox, session: session)
        let epochAtInitiation = TraceItX.shared.currentStartEpoch

        // NOW project B lands — standing in for the real Task-scheduling
        // delay between a drain being initiated and actually running.
        // ALSO identity-enabled, ALSO a token for "alice": the exact
        // same-subject-different-project shape that makes B's live token
        // look, superficially, like it belongs to this entry.
        try TraceItX.shared.start(config: projectB)
        TraceItX.shared.setIdentityToken(.token(jwt(sub: "alice", exp: now.addingTimeInterval(300))))

        RecordingURLProtocol.reset()
        await submitter.drainOutbox(
            identityHolder: TraceItX.shared._identityHolder,
            currentReplayConfig: {
                ReplayConfig(
                    replayEnabled: false, replayDurationSec: 30, samplingRate: 1.0,
                    identity: IdentityConfigWire(enabled: true)
                )
            },
            epochAtInitiation: epochAtInitiation,
            currentEpoch: { TraceItX.shared.currentStartEpoch }
        )

        // Non-vacuity: project B really is installed, with its own live
        // "alice" token, by the time the drain actually runs.
        XCTAssertEqual(TraceItX.shared.currentConfig?.appId, projectB.appId)

        XCTAssertEqual(RecordingURLProtocol.recorded.count, 1, "the entry must still drain — degrading to anonymous, never being lost")
        XCTAssertNil(
            RecordingURLProtocol.recorded.first?.identityToken,
            """
            project B's live token must never attach to a request still authorized with project A's SDK \
            key, even though B's token subject matches and B is also identity-enabled — the drain was \
            initiated under project A and must be judged against project A's epoch, not whatever project \
            happens to be live once the drain actually runs.
            """
        )
    }

    /// `_identityEnabledFlag` mirrors `_identityHolder`'s own start()/kill()
    /// reset (independent review, round 4, Serious 3): a project whose
    /// config had resolved identity-ENABLED must not leave that reading in
    /// place for a next session that hasn't fetched its own config yet —
    /// the same cross-project leak shape `_identityHolder.set(nil)` already
    /// guards against for the token itself. Drives the PRODUCTION flag
    /// directly (bypassing `armIdentityEnabled()`'s override seam), so this
    /// pins the flag's own reset, not the test-seam precedence.
    func testStartResetsTheIdentityEnabledFlagSoASecondProjectDoesNotInheritTheFirsts() throws {
        try startSession()
        TraceItX.shared.setIdentityToken(.token(jwt(sub: "alice", exp: Date().addingTimeInterval(300))))
        TraceItX.shared._identityEnabledFlag.set(true)

        try startSession(appId: "txx_live_9wPQrSt2UvWxYz3AbCdEfGh4IjKlMn5O")

        XCTAssertFalse(
            TraceItX.shared._identityEnabledFlag.get(),
            "a fresh session must not inherit the previous project's resolved identity-enabled reading"
        )
    }

    func testKillResetsTheIdentityEnabledFlag() throws {
        try startSession()
        TraceItX.shared._identityEnabledFlag.set(true)

        TraceItX.shared.kill()

        XCTAssertFalse(TraceItX.shared._identityEnabledFlag.get())
    }

    func testPartialUserOmitsMissingFields() throws {
        try startSession()
        TraceItX.shared.setUser(TXUser(email: "a@b.com"))
        let reporter = try captureAndDecodeReporter()
        let user = try XCTUnwrap(reporter["user"] as? [String: Any])
        XCTAssertNil(user["id"])
        XCTAssertEqual(user["email"] as? String, "a@b.com")
        XCTAssertNil(user["displayName"])
    }

    // MARK: - The pre-start ordering rule (external review, finding 2)

    /// `docs/user-recognition.md`'s per-platform table used to say iOS
    /// **stored** a pre-`start()` user and that the next report used it. That
    /// stopped being true when `start()` began clearing `_user` (a451dc74):
    /// the value was stored and then silently discarded, so the document was
    /// actively misleading on the exact ordering hazard that section exists to
    /// warn about — and iOS was the only platform keeping its "the platforms
    /// do not agree today" framing alive.
    ///
    /// The platforms are now uniform, in the direction Android and web
    /// already had: **a `setUser` before `start()` is dropped.** The other
    /// direction — `start()` preserving a user set moments earlier — is the
    /// one thing that must NOT be built: `start()` installs `_config`, which
    /// carries the SDK key, so preserving the user re-opens the
    /// `start(A) → setUser(X) → start(B)` cross-project leak a451dc74 closed
    /// (`testStartClearsTheUserSoASecondProjectIsNotAttributedToTheFirst`).
    ///
    /// `kill()` is how this test reaches a deterministic pre-session state:
    /// XCTest shares one process across every suite, so the gate's state on
    /// entry is whatever ran last. It clears the user and closes the gate —
    /// exactly the pre-`start()` posture — and restart after kill is
    /// explicitly supported (`KillSwitchTests.startAfterKillReenablesCapture`).
    func testSetUserBeforeStartIsDroppedNotStored() throws {
        TraceItX.shared.kill()

        TraceItX.shared.setUser(TXUser(id: "u_1", email: "a@b.com", displayName: "A"))
        XCTAssertNil(
            TraceItX.shared.currentUser,
            "a setUser before start() must be DROPPED, not stored — the documented rule on every platform"
        )

        // And it does not reappear once the session opens: the value never
        // entered state, so there is nothing for start() to carry over.
        try startSession()
        XCTAssertNil(TraceItX.shared.currentUser)
        let reporter = try captureAndDecodeReporter()
        XCTAssertNil(
            reporter["user"],
            "a user declared before start() must never attribute the session's reports"
        )
    }

    /// The non-vacuity control: the SAME call, made one line later, does take.
    /// Without this, the case above would also pass against a `setUser` that
    /// was broken outright.
    func testSetUserAfterStartTakesEffect() throws {
        TraceItX.shared.kill()
        try startSession()

        TraceItX.shared.setUser(TXUser(id: "u_1", email: "a@b.com", displayName: "A"))
        XCTAssertEqual(TraceItX.shared.currentUser?.id, "u_1")
        let reporter = try captureAndDecodeReporter()
        XCTAssertEqual((reporter["user"] as? [String: Any])?["id"] as? String, "u_1")
    }

    // MARK: - captureSessionSnapshot() config/epoch atomicity (independent
    // review, round 9, P1 — originally proven against the now-removed
    // `TXCapturedConfig`/`captureConfigSnapshot()`, superseded by
    // `TXCapturedSession`/`captureSessionSnapshot()`, which reads config,
    // user (incl. `startEpoch`) and both generation counters from the SAME
    // `stateLock` critical section. Merge note: kept as its own set of cases
    // rather than folded into the mixed-state test below, because each one
    // pins a DIFFERENT scenario — post-kill persistence, ordinary pairing,
    // movement across a restart — none of which the mixed-state case (which
    // is about a snapshot landing INSIDE start()'s own reset window)
    // exercises.

    /// `kill()` does not clear `_config` (only the NEXT `start()` replaces
    /// it — matching `currentConfig`'s own documented behaviour) but it DOES
    /// bump the epoch. A snapshot taken after `kill()` must reflect BOTH:
    /// the same (uncleared) config, paired with the NEW post-kill epoch —
    /// never the epoch that config was originally installed under. This is
    /// the same "the pair must never straddle a boundary" property the P1
    /// fix exists for, exercised across `kill()` rather than a second
    /// `start()`.
    func testCaptureSessionSnapshotReflectsThePostKillEpochEvenThoughConfigPersists() throws {
        let projectA = TraceItXConfig(
            appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU",
            capture: CaptureConfig(logs: false)
        )
        try TraceItX.shared.start(config: projectA)
        let epochBeforeKill = TraceItX.shared.captureSessionSnapshot().user.startEpoch

        TraceItX.shared.kill()
        let snapshotAfterKill = TraceItX.shared.captureSessionSnapshot()

        XCTAssertNotEqual(snapshotAfterKill.user.startEpoch, epochBeforeKill, "kill() must bump the epoch")
        XCTAssertEqual(snapshotAfterKill.user.startEpoch, TraceItX.shared.currentStartEpoch)
        XCTAssertEqual(snapshotAfterKill.config?.appId, projectA.appId, "kill() does not clear _config")
    }

    /// The ordinary case: the snapshot's config and epoch both reflect
    /// whichever project is currently installed, together.
    func testCaptureSessionSnapshotPairsTheLiveConfigWithItsOwnEpoch() throws {
        let projectA = TraceItXConfig(
            appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU",
            capture: CaptureConfig(logs: false)
        )
        try TraceItX.shared.start(config: projectA)

        let snapshot = TraceItX.shared.captureSessionSnapshot()

        XCTAssertEqual(snapshot.config?.appId, projectA.appId)
        XCTAssertEqual(snapshot.user.startEpoch, TraceItX.shared.currentStartEpoch)
    }

    /// A second `start()` moves BOTH fields together — never one project's
    /// config paired with a different project's epoch. This is the
    /// behavioural half of what `captureSessionSnapshot()`'s single
    /// `stateLock` acquisition guarantees structurally: see
    /// `CrashReporterConfigSnapshotSourceGate` below for why the actual
    /// race this closes (`start(projectB)` landing BETWEEN a config read
    /// and a separately-read epoch) cannot be reproduced as a behavioural
    /// test any more — the fix removes the window entirely, which is the
    /// point.
    func testCaptureSessionSnapshotMovesConfigAndEpochTogetherAcrossARestart() throws {
        let projectA = TraceItXConfig(
            appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU",
            capture: CaptureConfig(logs: false)
        )
        try TraceItX.shared.start(config: projectA)
        let epochAtA = TraceItX.shared.captureSessionSnapshot().user.startEpoch

        let projectB = TraceItXConfig(
            appId: "txx_live_9wPQrSt2UvWxYz3AbCdEfGh4IjKlMn5O",
            capture: CaptureConfig(logs: false)
        )
        try TraceItX.shared.start(config: projectB)
        let snapshotAtB = TraceItX.shared.captureSessionSnapshot()

        // Non-vacuity: the epoch really did change, so a snapshot pairing
        // project A's config with THIS epoch would be a genuinely
        // detectable mismatch if it could ever occur.
        XCTAssertNotEqual(snapshotAtB.user.startEpoch, epochAtA)
        XCTAssertEqual(snapshotAtB.config?.appId, projectB.appId)
        XCTAssertEqual(snapshotAtB.user.startEpoch, TraceItX.shared.currentStartEpoch)
    }

    /// FOLLOW-UPS ITEM 9, FOURTH ROUND (external review 2026-08-13, codex).
    ///
    /// The MIXED state, and why the start epoch cannot police it. `start()`
    /// bumps `_startEpoch` in its first critical section and installs
    /// `_config` in a second one (F39's ordering), so a snapshot landing
    /// between them holds project B's EPOCH beside project A's CONFIG. Once
    /// `start()` finishes, that epoch matches the live one — so an
    /// epoch-only `isSuperseded` reports "session intact" for a report pinned
    /// to a STALE config, and the submit paths would then accept project B's
    /// live and frozen buffers while routing by project A's key.
    ///
    /// Driven through the same in-window hook
    /// `testASnapshotTakenInsideStartsResetWindowCannotResolve` uses, so the
    /// interleaving is deterministic rather than raced.
    func testASnapshotOfTheMixedStateReportsItselfSuperseded() throws {
        let projectA = TraceItXConfig(
            appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU",
            capture: CaptureConfig(logs: false)
        )
        try TraceItX.shared.start(config: projectA)

        let projectB = TraceItXConfig(
            appId: "txx_live_9wPQrSt2UvWxYz3AbCdEfGh4IjKlMn5O",
            capture: CaptureConfig(logs: false)
        )

        try startSession()

        var capturedInWindow: TXCapturedSession?
        TraceItX.__bodyStateResetHookForTesting = {
            capturedInWindow = TraceItX.shared.captureSessionSnapshot()
        }
        defer { TraceItX.__resetBodyStateResetHookForTesting() }

        try TraceItX.shared.start(config: projectB)

        let captured = try XCTUnwrap(
            capturedInWindow,
            "the in-start() window hook never fired — the test exercises nothing"
        )
        // Non-vacuity, both halves. The snapshot must really be the mixed
        // pairing: B's epoch (so an epoch-only check would pass) beside A's
        // config (so routing by it would be stale).
        XCTAssertEqual(
            captured.user.startEpoch, TraceItX.shared.currentStartEpoch,
            "the snapshot must carry the NEW epoch — otherwise the epoch check alone explains the result and this case proves nothing"
        )
        XCTAssertEqual(
            captured.config?.appId, "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU",
            "the snapshot must carry the OLD config — that pairing is the whole defect"
        )

        XCTAssertTrue(
            captured.isSuperseded,
            """
            a snapshot pairing the new epoch with the old config must report             itself superseded — otherwise the submit paths accept project B's             buffers while routing by project A's key
            """
        )
    }

    // MARK: - Crash-entry session snapshot (2026-08-13 follow-ups item 6)

    /// Same as `captureAndDecodeReporter` but with NO explicit config, so
    /// `captureFacts` must fall through to the session snapshot — the path
    /// this fix is about. Returns the persisted outbox entry rather than the
    /// decoded reporter, because the assertions here are about the entry's
    /// `sdkKey`, not the envelope body.
    private func captureAndReturnEntry() throws -> OutboxEntry? {
        let outbox = makeOutbox()
        let json = """
        {"exceptionType":"TypeError","message":"boom","framesRaw":[],"mechanism":"errorutils","fatal":true,"occurredAt":"2026-08-12T00:00:00Z"}
        """
        _ = CrashReporter.captureFacts(json: json, outbox: outbox, config: nil)
        return try outbox.hydrate().first
    }

    /// THE DEFECT. `captureFacts` snapshotted the user at crash entry but read
    /// the config a few statements later, so a `start(projectB)` landing in
    /// that window built project A's crash and stamped it with B's key.
    func testACrashIsStampedWithTheKeyOfTheProjectItWasCapturedUnder() throws {
        try startSession(appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU")
        CrashReporter.__afterUserSnapshotHookForTesting = {
            try? TraceItX.shared.start(config: Self.sessionConfig(appId: "txx_live_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"))
        }

        let entry = try XCTUnwrap(try captureAndReturnEntry())

        // Non-vacuity: the switch really did land inside the window.
        XCTAssertEqual(
            TraceItX.shared.currentConfig?.appId, "txx_live_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "the hook must actually have switched the live config — otherwise this asserts nothing"
        )
        XCTAssertEqual(
            entry.sdkKey, "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU",
            "the crash must ship under the key of the project it happened in, not whoever start() named while it was being encoded"
        )
    }

    /// Control: entering the window changes nothing when nothing switches. A
    /// "fix" that dropped every report would pass the case above and fail here.
    func testACrashKeepsItsKeyWhenNothingSwitchesDuringProcessing() throws {
        try startSession(appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU")
        var hookRan = false
        CrashReporter.__afterUserSnapshotHookForTesting = { hookRan = true }

        let entry = try XCTUnwrap(try captureAndReturnEntry())

        XCTAssertTrue(hookRan, "the hook must have run — otherwise this asserts nothing")
        XCTAssertEqual(entry.sdkKey, "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU")
    }

    /// A kill() during assembly revokes the capture: nothing ships.
    func testAKillDuringProcessingDropsTheReportEntirely() throws {
        try startSession()
        var hookRan = false
        CrashReporter.__afterUserSnapshotHookForTesting = {
            hookRan = true
            TraceItX.shared.kill()
        }

        XCTAssertNil(
            try captureAndReturnEntry(),
            "a crash whose capture was revoked mid-assembly must not reach the outbox"
        )
        XCTAssertTrue(hookRan, "the hook must have run — otherwise this asserts nothing")
    }

    /// THE CASE A BOOLEAN GATE CANNOT EXPRESS: start() re-opens `captureGate`,
    /// so a gate check would see "open" and ship a revoked capture.
    func testAKillFollowedByAStartStillDropsTheReport() throws {
        try startSession()
        CrashReporter.__afterUserSnapshotHookForTesting = {
            TraceItX.shared.kill()
            try? TraceItX.shared.start(config: Self.sessionConfig(appId: "txx_live_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"))
        }

        let entry = try captureAndReturnEntry()

        // Non-vacuity, checked AFTER the capture (not before, where the gate
        // is merely the one startSession() opened and the assertion would be
        // trivially true regardless of whether the hook ran at all). Also
        // pins that the hook's start() really did land — a silently-thrown
        // start() here would quietly degenerate this into a duplicate of
        // testAKillDuringProcessingDropsTheReportEntirely, losing the one
        // case that distinguishes a monotonic killGeneration counter from a
        // boolean gate.
        XCTAssertEqual(
            TraceItX.shared.currentConfig?.appId, "txx_live_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "the hook's start() must actually have installed project B — otherwise this asserts nothing beyond a plain kill()"
        )
        XCTAssertTrue(TraceItX.shared.captureGate, "precondition: start() re-opened the gate")
        XCTAssertNil(
            entry,
            "a later start() must not resurrect a capture that kill() revoked"
        )
    }

    // MARK: - Session-boundary buffer reset (2026-08-13 follow-ups item 10)

    /// Markers chosen to be impossible to produce by accident, so the
    /// whole-envelope substring assertions below cannot pass or fail for any
    /// reason other than the buffer content under test.
    private static let crumbMarkerA = "TXFOLLOWUP10-PROJECT-A-ONLY-CRUMB"
    private static let urlMarkerA = "https://a-only.example.invalid/txfollowup10-a-only-path"

    /// Same real `CrashReporter.captureFacts` drive as
    /// `captureAndDecodeReporter`, but returns the WHOLE envelope plus its raw
    /// bytes. `payload.breadcrumbs` is the field under test here, and the raw
    /// bytes are asserted on as well so a marker that moved to some other part
    /// of the envelope (or into a field this decoder does not walk) still
    /// fails the test rather than silently passing it.
    private func captureAndDecodeEnvelope() throws -> (json: [String: Any], raw: Data) {
        let outbox = makeOutbox()
        let json = """
        {"exceptionType":"TypeError","message":"boom","framesRaw":[],"mechanism":"errorutils","fatal":true,"occurredAt":"2026-08-12T00:00:00Z"}
        """
        let ok = CrashReporter.captureFacts(json: json, outbox: outbox, config: TraceItXConfig(appId: "app"))
        XCTAssertTrue(ok)
        let entry = try XCTUnwrap(try outbox.hydrate().first)
        let decoded = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: entry.envelopeBytes) as? [String: Any])
        return (decoded, entry.envelopeBytes)
    }

    /// THE DEFECT (follow-ups item 10). `start()` zeroized the network-BODY
    /// buffer at the session boundary but not the breadcrumb chain, so
    /// `start(A) -> activity -> start(B)` left A's crumbs sitting in the
    /// process-global ring and the next ordinary report in B shipped them to
    /// B's project. Deterministic, unbounded, and in the cross-tenant
    /// direction — the same class as follow-ups items 1 and 6.
    ///
    /// Driven through `CrashReporter.captureFacts` because that is the one
    /// real, hermetic call site in this target that builds an envelope from
    /// `BreadcrumbRingBuffer.shared` (`CrashReporter.swift`'s `breadcrumbs:`
    /// argument). `ReporterSubmission` reads the same buffer on the
    /// screenshot-reporter path but is `#if canImport(UIKit)`-gated and absent
    /// on this host — see the file header.
    func testAReportInTheNextProjectShipsNoneOfThePreviousProjectsBreadcrumbs() throws {
        try startSession(appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU")
        TraceItX.shared.addBreadcrumb(message: Self.crumbMarkerA)

        // Non-vacuity: the crumb must really be in the ring before the switch,
        // otherwise the absence asserted below proves nothing.
        XCTAssertTrue(
            BreadcrumbRingBuffer.shared.snapshot().contains { $0.message == Self.crumbMarkerA },
            "precondition: A's crumb must be buffered before start(B) — otherwise this test asserts nothing"
        )

        try startSession(appId: "txx_live_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")

        let (envelope, raw) = try captureAndDecodeEnvelope()
        let payload = try XCTUnwrap(envelope["payload"] as? [String: Any])
        let crumbs = (payload["breadcrumbs"] as? [[String: Any]]) ?? []
        XCTAssertFalse(
            crumbs.contains { $0["message"] as? String == Self.crumbMarkerA },
            "a report in project B must not carry project A's breadcrumb chain"
        )
        XCTAssertFalse(
            (String(data: raw, encoding: .utf8) ?? "").contains(Self.crumbMarkerA),
            "project A's crumb text must appear NOWHERE in a project B envelope"
        )

        TraceItX.shared.kill()
    }

    /// The metadata half of the same defect: `NetworkRingBuffer` holds URLs,
    /// status codes and timings, and `kill()` zeroizes it while `start()` did
    /// not.
    ///
    /// Asserted at the buffer rather than through a built envelope on purpose.
    /// The only production reader of these rows on this platform is
    /// `ReporterSubmission.submit` (`NetworkRingBuffer.shared.snapshot()`,
    /// handed to `EnvelopeBuilder`'s `networkRows:`), and that type does not
    /// exist on a host without UIKit — the same constraint the file header
    /// records for the user-extras path. `snapshot()` IS the exact value that
    /// call site ships, so pinning it empty pins what the report carries;
    /// re-deriving the row→`NetworkRow` mapping here would test this file's
    /// copy of production logic instead of production's.
    func testTheNextProjectStartsWithNoneOfThePreviousProjectsNetworkRows() throws {
        try startSession(appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU")
        NetworkRingBuffer.shared.append(
            NetworkLogEntry(
                timestamp: Date(),
                method: "GET",
                url: Self.urlMarkerA,
                status: 200,
                durationMs: 12,
                requestHeaders: [:],
                responseHeaders: [:]
            ))

        XCTAssertTrue(
            NetworkRingBuffer.shared.snapshot().contains { $0.url == Self.urlMarkerA },
            "precondition: A's network row must be buffered before start(B) — otherwise this test asserts nothing"
        )

        try startSession(appId: "txx_live_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")

        XCTAssertTrue(
            NetworkRingBuffer.shared.snapshot().isEmpty,
            "start(B) must zeroize project A's captured network metadata rows — a report in B reads this same buffer"
        )

        TraceItX.shared.kill()
    }
}

// MARK: - CrashReporter config-snapshot wiring source gate

/// Independent review, round 9, P1 — a behavioural test cannot reproduce the
/// defect this pins: `captureSessionSnapshot()` reads `_config`/`_user`
/// (whose `startEpoch` this gate cares about) in ONE `stateLock` acquisition
/// (see `TXCapturedSession`'s doc comment), so there is no longer any window
/// between "config read" and "epoch read" for a `start(projectB)` to land
/// in — the interleaving the P1 finding described is now structurally
/// unreachable, which is the intended outcome, not a gap in coverage. What
/// CAN still regress silently is the WIRING: a future edit to
/// `CrashReporter.swift` could reintroduce a separate
/// `TraceItX.shared.currentStartEpoch` read at the drain-kickoff line
/// instead of reusing `captured.user.startEpoch`, quietly reopening the
/// exact "sampled separately" hazard this round closed — indistinguishable
/// from the fixed code in any test that (like every test in this suite)
/// exercises the two reads sequentially, with nothing else running between
/// them. This gate pins the wiring itself, the same way
/// `ReporterSubmissionUserExtrasSourceGate` below pins wiring UIKit-gating
/// makes unreachable behaviourally on this host — reads `CrashReporter.swift`
/// as text and asserts on it directly. Mutation-verified: reverting the
/// drain-kickoff line to a bare `TraceItX.shared.currentStartEpoch` read
/// makes this fail.
///
/// Merge note (native-identity x captured-session, 2026-08-16): this
/// originally pinned the now-removed `TXCapturedConfig`/
/// `captureConfigSnapshot()` pairing — `configSnapshot.config` /
/// `configSnapshot.startEpoch`, from a SECOND `stateLock` acquisition
/// separate from the crash-entry `captureSessionSnapshot()` call above it.
/// `TXCapturedSession` subsumes that job (it already carries `config`
/// alongside `user`/`startEpoch` from the SAME acquisition captured at crash
/// entry), so the wiring this gate protects is now "read config and epoch
/// from `captured`, never re-acquire," not "call a second snapshot
/// function." Updated in place — the invariant is unchanged, only which
/// snapshot carries it.
final class CrashReporterConfigSnapshotSourceGate: XCTestCase {
    private static func crashReporterSource() throws -> String {
        let thisFile = URL(fileURLWithPath: #filePath)
        // …/Tests/TraceItXTests/EnvelopeUserTests.swift → up 3 → package root.
        let packageRoot = thisFile
            .deletingLastPathComponent()   // TraceItXTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // package root
        let file = packageRoot
            .appendingPathComponent("Sources/TraceItX/Crash/CrashReporter.swift")
        return try String(contentsOf: file, encoding: .utf8)
    }

    private static func strippingLineComments(_ source: String) -> String {
        source.split(separator: "\n", omittingEmptySubsequences: false)
            .map { line -> Substring in
                guard let slashes = line.range(of: "//") else { return line }
                return line[line.startIndex..<slashes.lowerBound]
            }
            .joined(separator: "\n")
    }

    func testConfigAndEpochAreReadFromOneAtomicSnapshotNotTwoSeparateReads() throws {
        let code = Self.strippingLineComments(try Self.crashReporterSource())

        let snapshotCall = try XCTUnwrap(
            code.range(of: "let captured = TraceItX.shared.captureSessionSnapshot()"),
            """
            CrashReporter.swift no longer captures the user, config and generation \
            counters together via captureSessionSnapshot(). Reading TraceItX.shared \
            .currentConfig and TraceItX.shared.currentStartEpoch as two SEPARATE \
            statements re-opens the round-9 P1 hazard: a start(projectB) landing \
            between the two reads pairs project A's config with project B's epoch, \
            and drainOutbox's guards cannot tell that pairing apart from a genuinely \
            consistent one.
            """
        )
        let guardLine = try XCTUnwrap(
            code.range(of: "guard let config = config ?? captured.config, config.capture.crash else {"),
            "CrashReporter.swift no longer resolves `config` from captured.config — has the guard been restructured?"
        )
        XCTAssertTrue(
            snapshotCall.upperBound <= guardLine.lowerBound,
            "captureSessionSnapshot() must be called before config is resolved from it"
        )

        let drainEpochArg = try XCTUnwrap(
            code.range(of: "let epochAtInitiation = captured.user.startEpoch"),
            """
            CrashReporter.swift's drain kickoff no longer threads epochAtInitiation from \
            captured.user.startEpoch — the SAME value config came from. A separate, later \
            `TraceItX.shared.currentStartEpoch` read here would reopen the round-9 P1 hazard: \
            reverting to two independently-sampled reads instead of one atomic snapshot.
            """
        )
        XCTAssertTrue(guardLine.upperBound < drainEpochArg.lowerBound)
    }
}

// MARK: - ReporterSubmission source gate

/// See the file header for why this is a source gate rather than a
/// behavioural test: `ReporterSubmission` is `#if canImport(UIKit)`-gated
/// (absent on this host) and its `submit(_:)` has no network injection seam.
/// This reads `ReporterSubmission.swift` as text — no UIKit, no `@testable`
/// symbol, so it runs (and can fail) on every host, including this one.
final class ReporterSubmissionUserExtrasSourceGate: XCTestCase {
    private static func submissionSource() throws -> String {
        let thisFile = URL(fileURLWithPath: #filePath)
        // …/Tests/TraceItXTests/EnvelopeUserTests.swift → up 3 → package root.
        let packageRoot = thisFile
            .deletingLastPathComponent()   // TraceItXTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // package root
        let file = packageRoot
            .appendingPathComponent("Sources/TraceItX/Reporter/ReporterSubmission.swift")
        return try String(contentsOf: file, encoding: .utf8)
    }

    /// Drops `//` line comments so the gate matches CODE, not the prose
    /// describing it.
    private static func strippingLineComments(_ source: String) -> String {
        source.split(separator: "\n", omittingEmptySubsequences: false)
            .map { line -> Substring in
                guard let slashes = line.range(of: "//") else { return line }
                return line[line.startIndex..<slashes.lowerBound]
            }
            .joined(separator: "\n")
    }

    func testUserExtrasAreWrittenOutsideMetadataToggleAndBeforeOverrides() throws {
        let code = Self.strippingLineComments(try Self.submissionSource())

        let metadataIfRange = try XCTUnwrap(
            code.range(of: "if inputs.includeMetadata {"),
            "includeMetadata block not found — has ReporterSubmission.swift been restructured?"
        )
        let overridesLoopRange = try XCTUnwrap(
            code.range(of: "for (key, value) in inputs.extraOverrides"),
            "extraOverrides merge loop not found — has ReporterSubmission.swift been restructured?"
        )
        XCTAssertTrue(
            metadataIfRange.upperBound < overridesLoopRange.lowerBound,
            "expected the includeMetadata block to appear before the extraOverrides loop"
        )

        let userBlockRange = try XCTUnwrap(
            code.range(of: "inputs.capturedSession.user"),
            """
            ReporterSubmission.swift does not read inputs.capturedSession.user. \
            Without that read, every self-declared identity set via setUser is \
            silently dropped from in-app reporter submissions (crash \
            submissions are covered separately by CrashReporter and are \
            unaffected).
            """
        )

        // Placement: strictly between the metadata block closing and the
        // overrides loop opening — never inside includeMetadata (the user is
        // host-set attribution with no such toggle) and always before the
        // overrides loop (so an explicit override still wins).
        XCTAssertTrue(
            userBlockRange.lowerBound > metadataIfRange.upperBound,
            "the user-extras block must sit OUTSIDE (after) the includeMetadata block"
        )
        XCTAssertTrue(
            userBlockRange.upperBound < overridesLoopRange.lowerBound,
            "the user-extras block must sit BEFORE the extraOverrides merge loop"
        )

        for key in ["user.id", "user.email", "user.displayName"] {
            XCTAssertNotNil(
                code.range(of: "extra[\"\(key)\"]"),
                "ReporterSubmission.swift never writes extra[\"\(key)\"]"
            )
        }
    }

    /// External review, finding 3 (Serious) — the submit-boundary half.
    /// `submit(_:)` is `async`: the caller's `Task` hop, per-shot annotation
    /// baking, image encoding, SHA-256 and multipart construction all run
    /// between the user tapping Send and the point this file assembles
    /// `extra`. Reading `TraceItX.shared.currentUser` there meant a `setUser`
    /// call landing in that window permanently regrouped A's report under B —
    /// the same defect web fixed with `captureUserSnapshot` at its own submit
    /// boundary. The fix threads a snapshot through `Inputs.capturedSession`, so
    /// the LIVE read must be gone from this file entirely, not merely
    /// supplemented.
    func testSubmitReadsTheCapturedSnapshotAndNeverTheLiveSingleton() throws {
        let code = Self.strippingLineComments(try Self.submissionSource())

        XCTAssertNil(
            code.range(of: "TraceItX.shared.currentUser"),
            """
            ReporterSubmission.swift reads TraceItX.shared.currentUser again. \
            submit(_:) runs asynchronously, seconds after Send was tapped — a \
            live read there attributes the report to whoever setUser named by \
            the time envelope assembly got round to it. Use \
            Inputs.capturedSession, snapshotted by the caller at the submit \
            boundary.
            """
        )
        XCTAssertNotNil(
            code.range(of: "public let capturedSession: TXCapturedSession"),
            "Inputs no longer declares capturedSession — the snapshot has nowhere to be threaded through."
        )
    }

    /// External review, finding 1 (Serious), then FOLLOW-UPS ITEM 9.
    ///
    /// This gate used to assert the opposite of what it asserts now, and the
    /// reversal is the point. Finding 1 left `submit(_:)` reading
    /// `TraceItX.shared.currentConfig` live and required the captured user to
    /// be `resolve()`d AFTER that read, so a matching epoch proved no
    /// `start()`/`kill()` had run across the whole window, config read
    /// included. That made the ATTRIBUTION safe and left the DESTINATION
    /// exposed: a `start(projectB)` in the window made `resolve()` correctly
    /// return nil and the report still went to B, carrying project A's
    /// screenshot, UI tree, breadcrumbs and network rows.
    ///
    /// Item 9 removed the live read entirely — the config now comes from the
    /// same snapshot as the user — so the ordering rule it enforced no longer
    /// has anything to order. What replaces it is stronger and simpler: this
    /// file must not consult the live singleton's config AT ALL.
    ///
    /// The behavioural guard is `ReporterSubmitKeyBindingTests`, which asserts
    /// the key on the wire. This source gate exists alongside it because that
    /// suite is UIKit-gated and runs only in the simulator lane, while this one
    /// runs on every macOS host — so a reintroduced live read fails fast, in
    /// the cheap job, instead of waiting for the simulator.
    func testSubmitRoutesByTheCapturedConfigAndNeverTheLiveOne() throws {
        let code = Self.strippingLineComments(try Self.submissionSource())

        // NOTE: `strippingLineComments` removes `//` lines but NOT `/** */`
        // blocks, so prose in a doc comment counts as a hit here. That is a
        // deliberate trade rather than a gap: loosening the gate to parse
        // block comments would make it fragile, and a doc comment can always
        // say "the live singleton's config" instead. If this fires on a
        // comment, fix the comment.
        XCTAssertNil(
            code.range(of: "TraceItX.shared.currentConfig"),
            """
            ReporterSubmission.swift reads the LIVE config again. That is \
            follow-ups item 9 exactly: the SDK key decides which project \
            receives this report, and everything between the Send tap and \
            that read — bake, encode, SHA-256, replay gzip, multipart — runs \
            for seconds. Route by inputs.capturedSession.config instead.
            """
        )
        XCTAssertNotNil(
            code.range(of: "inputs.capturedSession.config"),
            """
            submit(_:) no longer takes its config from the captured session — \
            the report has nothing binding it to the project it was captured \
            in.
            """
        )
        XCTAssertNotNil(
            code.range(of: "inputs.capturedSession.user.resolve()"),
            """
            ReporterSubmission.swift writes the captured user without \
            resolve()-ing it against the session it was captured in.
            """
        )

        // The revocation re-check must precede the submitter construction:
        // ReportSubmitter uploads live FIRST and only enqueues on a retryable
        // failure, so a check placed after it would run on the failure path
        // alone and a revoked report that uploaded successfully would never be
        // checked at all.
        let revocationCheck = try XCTUnwrap(
            code.range(of: "inputs.capturedSession.isRevoked"),
            "submit(_:) no longer re-checks revocation — a kill() during assembly would still upload."
        )
        let submitterBuild = try XCTUnwrap(
            code.range(of: "ReportSubmitter(config: cfg)"),
            "submitter construction not found — has ReporterSubmission.swift been restructured?"
        )
        XCTAssertTrue(
            revocationCheck.upperBound < submitterBuild.lowerBound,
            "the revocation check must run BEFORE the submitter is built, not after it has uploaded"
        )
    }

    /// Native identity Task 8b, fix round 1 (Minor finding 3). The CI-only
    /// shell grep this gate replaced (`swift.yml`'s "Identity live-submit
    /// wiring gate") could only catch the call vanishing or a fresh
    /// `IdentityTokenHolder()` being substituted — not `capturedSubject:`
    /// being switched to a live `_identityHolder.cachedSubject(...)` read
    /// (repointing an in-flight report the instant identity changes, the
    /// exact defect `capturedUser.resolve()` already prevents for the
    /// self-declared user), nor `identityToken:` being dropped from
    /// `submitter.submit(...)` (silently reverting the whole feature to
    /// inert while `resolveIdentityHeader` keeps computing the right answer
    /// and throwing it away). Positive assertions on the exact expected
    /// substrings catch both: a mutation to either line changes the text, so
    /// the match fails. Runs as a normal XCTest (this file's suite is
    /// already in `swift.yml`'s companion filter), so — unlike the shell
    /// script it replaces — it also runs locally under plain `swift test`.
    func testIdentityHeaderIsResolvedFromTheRealSingletonHolderAndThreadedIntoSubmit() throws {
        let code = Self.strippingLineComments(try Self.submissionSource())

        XCTAssertNotNil(
            code.range(of: "resolveIdentityHeader("),
            "ReporterSubmission.swift no longer calls resolveIdentityHeader(...) at the live submit boundary — identity wiring reverted to inert."
        )
        XCTAssertNotNil(
            code.range(of: "capturedSubject: inputs.capturedSession.user.identitySubject,"),
            """
            resolveIdentityHeader(...) no longer passes inputs.capturedSession.user.identitySubject as \
            capturedSubject. A live TraceItX.shared._identityHolder.cachedSubject(...) read there \
            would let an identity change mid-submit repoint an in-flight report to the wrong person — \
            exactly the defect capturedSession.user.resolve() already prevents for the self-declared user.
            """
        )
        XCTAssertNotNil(
            code.range(of: "holder: TraceItX.shared._identityHolder,"),
            "resolveIdentityHeader(...) no longer passes TraceItX.shared._identityHolder (the real singleton) as its holder — identity wiring reverted to inert."
        )
        XCTAssertNil(
            code.range(of: "holder: IdentityTokenHolder(),"),
            "resolveIdentityHeader(...) passes a FRESH IdentityTokenHolder() — this is the exact inert-default mistake Task 8b closed; it must resolve nil forever."
        )
        XCTAssertNotNil(
            code.range(of: "identityToken: identityToken"),
            "submitter.submit(...) no longer threads the resolved identityToken through — the header can never reach the wire even though resolveIdentityHeader still computes it."
        )
    }

    /// Final whole-branch review, Important 2 — the live path lacked the
    /// `startEpoch` re-check `inputs.capturedUser.resolve()` already performs
    /// two lines above (see `testTheCapturedUserIsResolvedAgainstItsSessionAfterTheConfigIsRead`)
    /// for the self-declared user. A subject match alone is not enough:
    /// `sub` is the host's own user id, typically unchanged across a tenant
    /// or dev/prod switch, so `start(projectB)` landing in this window,
    /// followed by the host calling `setIdentityToken` again (plausible
    /// immediately after switching projects), could let this report present
    /// project B's live token while everything else about it still belongs
    /// to project A. Same source-gate technique as the sibling tests in this
    /// class — `ReporterSubmission.swift` is entirely `#if canImport(UIKit)`
    /// and unreachable behaviourally from `swift test` on macOS.
    func testIdentityHeaderResolutionChecksTheEpochBeforeResolvingAndWithholdsOnMismatch() throws {
        let code = Self.strippingLineComments(try Self.submissionSource())
        let epochProbe = "inputs.capturedSession.user.startEpoch == TraceItX.shared.currentStartEpoch"

        let preCheck = try XCTUnwrap(
            code.range(of: epochProbe),
            """
            ReporterSubmission.swift no longer re-checks inputs.capturedSession.user.startEpoch against \
            TraceItX.shared.currentStartEpoch before resolving the identity header. Without it, a \
            start(projectB) landing during async prep, followed by the host calling \
            setIdentityToken again, could let this report present project B's live token even \
            though the envelope itself still belongs to project A.
            """
        )
        let resolveHeaderCall = try XCTUnwrap(
            code.range(of: "resolveIdentityHeader("),
            "ReporterSubmission.swift no longer calls resolveIdentityHeader(...) at the live submit boundary — identity wiring reverted to inert."
        )
        XCTAssertTrue(
            preCheck.upperBound < resolveHeaderCall.lowerBound,
            "the epoch check must gate the resolveIdentityHeader(...) call, not run after it (or not at all)"
        )
        XCTAssertNotNil(
            code.range(of: "identityToken = nil"),
            "an epoch mismatch must resolve identityToken to nil directly — the header must never reach submitter.submit(...) when the captured session is no longer the installed one."
        )

        // Independent review, Serious 1 — the pre-check alone is a TOCTOU
        // window: resolveIdentityHeader(...) is async, and a start(projectB)
        // + setIdentityToken(B) landing DURING its own await points (the
        // provider re-ask can take up to IDENTITY_PROVIDER_TIMEOUT) is
        // exactly what its `holder.get(now:)` can pick up, since
        // `_identityHolder` is one persistent object mutated in place. The
        // fix re-checks the SAME epoch comparison AFTER resolution
        // completes, before the resolved value is ever used — so the probe
        // string must appear a SECOND time, strictly after
        // resolveIdentityHeader(.
        let secondCheckRange = try XCTUnwrap(
            code.range(of: epochProbe, range: resolveHeaderCall.upperBound..<code.endIndex),
            """
            ReporterSubmission.swift no longer re-checks the epoch AFTER resolveIdentityHeader(...) \
            completes. A start(projectB) + setIdentityToken(B) landing during resolution's own await \
            points (the provider re-ask) is invisible to the pre-check alone — B's live token could \
            resolve and attach to a report whose envelope still belongs to project A.
            """
        )
        XCTAssertTrue(
            resolveHeaderCall.upperBound <= secondCheckRange.lowerBound,
            "the post-resolution epoch re-check must run AFTER resolveIdentityHeader(...) is called, not before"
        )
        XCTAssertNotNil(
            code.range(of: "? resolved : nil", range: secondCheckRange.upperBound..<code.endIndex),
            "the post-resolution re-check must gate USE of the resolved value — a mismatch must discard it, not merely be computed and ignored."
        )
    }

    /// The two call sites' half: `Inputs.capturedSession` is only a fix if the
    /// callers actually snapshot at their own submit boundary. `capturedUser`
    /// has no default precisely so this cannot be forgotten silently — but
    /// neither file is reachable from an executed test on a plain macOS host
    /// (both are entirely `#if canImport(UIKit)`), so the placement is gated
    /// as source, mirroring
    /// `CompanionAttributionHeaderTests_CompanionCaptureBridgeSourceGate`.
    func testBothSubmitPathsSnapshotTheUserAtTheirOwnBoundary() throws {
        let thisFile = URL(fileURLWithPath: #filePath)
        let packageRoot = thisFile
            .deletingLastPathComponent()   // TraceItXTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // package root

        // In-app reporter: captured in the synchronous Send handler and
        // THREADED into `Inputs` — see the dedicated ordering gate below for
        // where in that handler the capture has to happen.
        let vc = Self.strippingLineComments(
            try String(
                contentsOf: packageRoot.appendingPathComponent(
                    "Sources/TraceItXReporterUI/ReporterViewController.swift"),
                encoding: .utf8)
        )
        XCTAssertNotNil(
            vc.range(
                of: #"let capturedSession\s*=\s*TraceItX\.shared\.captureSessionSnapshot\(\)"#,
                options: .regularExpression),
            """
            ReporterViewController.swift no longer snapshots the user in \
            sendTapped(). It must use captureSessionSnapshot() — a bare \
            currentUser read captures the user WITHOUT the session it belongs \
            to (external review, finding 1), so a start(projectB) during prep \
            would ship it under B's SDK key.
            """
        )
        XCTAssertNotNil(
            vc.range(of: #"capturedSession:\s*capturedSession"#, options: .regularExpression),
            "ReporterViewController.swift no longer threads its snapshot into ReporterSubmission.Inputs."
        )

        // Companion: captured in `tryRunSubmit`, BEFORE the `Task { @MainActor }`
        // hop — so the snapshot must be a local bound outside the closure and
        // then passed in, never a live read inside it.
        let bridge = Self.strippingLineComments(
            try String(
                contentsOf: packageRoot.appendingPathComponent(
                    "Sources/TraceItX/Companion/CompanionCaptureBridge.swift"),
                encoding: .utf8)
        )
        let boundOutside = try XCTUnwrap(
            bridge.range(
                of: #"let capturedSession\s*=\s*TraceItX\.shared\.captureSessionSnapshot\(\)"#,
                options: .regularExpression),
            """
            CompanionCaptureBridge.swift no longer snapshots the user at the \
            submit boundary in tryRunSubmit — or does it with a bare \
            currentUser read, which captures no session (external review, \
            finding 1) and so cannot be invalidated by a start()/kill().
            """
        )
        let hop = try XCTUnwrap(
            bridge.range(of: "Task { @MainActor [weak self] in"),
            "tryRunSubmit's MainActor Task hop not found — has the bridge been restructured?"
        )
        XCTAssertTrue(
            boundOutside.upperBound < hop.lowerBound,
            """
            The user snapshot must be taken BEFORE tryRunSubmit's Task hop. \
            Taken inside it, it is no longer a submit boundary — the hop, the \
            image decode and the target re-resolution are all part of the \
            window an account switch has to land in.
            """
        )
        XCTAssertNotNil(
            bridge.range(
                of: #"capturedSession:\s*capturedSession"#,
                options: .regularExpression),
            "CompanionCaptureBridge.swift no longer threads its snapshot into ReporterSubmission.Inputs."
        )
    }

    /// Round-5 external review, finding 1 (Serious) — WHERE INSIDE the Send
    /// handler the snapshot is taken.
    ///
    /// `sendTapped()` bakes every annotated screenshot (`BakeRenderer.bake`)
    /// and serializes its annotation wire format synchronously, on the main
    /// thread, before it builds `ReporterSubmission.Inputs`. Rounds 3 and 4
    /// both put the capture in the `Inputs(...)` literal — i.e. AFTER all of
    /// that — so a `setUser(B)` landing during baking was captured as though
    /// it had been the user at the Send tap.
    ///
    /// The `TXCapturedUser` epoch guard cannot catch this: user and epoch are
    /// read in ONE lock acquisition, so a switch that already happened before
    /// the snapshot produces a self-consistent (new user, new epoch) pair that
    /// `resolve()` returns without complaint. A late snapshot is invisible to
    /// the epoch check by construction — the ONLY fix is taking it early, and
    /// the only thing that can pin "early" here is this ordering assertion.
    ///
    /// Behavioural coverage is unavailable: `ReporterViewController` is
    /// entirely `#if canImport(UIKit) && !os(tvOS)` and does not exist when
    /// `swift test --package-path packages/sdk-ios` runs on a macOS host (see
    /// this file's header). The mechanism the snapshot feeds is exercised for
    /// real in `EnvelopeUserTests` above; this gate covers the wiring.
    func testTheInAppReporterSnapshotsTheUserBeforeItBakesAnything() throws {
        let thisFile = URL(fileURLWithPath: #filePath)
        let packageRoot = thisFile
            .deletingLastPathComponent()   // TraceItXTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // package root
        let vc = Self.strippingLineComments(
            try String(
                contentsOf: packageRoot.appendingPathComponent(
                    "Sources/TraceItXReporterUI/ReporterViewController.swift"),
                encoding: .utf8)
        )

        // Scope every search to sendTapped()'s body — `BakeRenderer.bake` also
        // appears in the thumbnail-preview path far earlier in the file, and
        // matching that one would make this gate pass vacuously.
        let handler = try XCTUnwrap(
            vc.range(of: "@objc private func sendTapped() {"),
            "sendTapped() not found — has ReporterViewController.swift been restructured?"
        )
        let body = vc[handler.upperBound...]

        let capture = try XCTUnwrap(
            body.range(
                of: #"let capturedSession\s*=\s*TraceItX\.shared\.captureSessionSnapshot\(\)"#,
                options: .regularExpression),
            "sendTapped() does not snapshot the user at all."
        )
        let bake = try XCTUnwrap(
            body.range(of: "BakeRenderer.bake"),
            "sendTapped()'s per-shot bake not found — has it been restructured?"
        )
        let serialize = try XCTUnwrap(
            body.range(of: "AnnotationWireFormat.serialize"),
            "sendTapped()'s annotation serialization not found — has it been restructured?"
        )

        XCTAssertTrue(
            capture.upperBound < bake.lowerBound,
            """
            The user snapshot must be taken BEFORE sendTapped() bakes any \
            screenshot. Baking rasterizes every annotated shot on the main \
            thread; a setUser landing in that window is captured as the \
            Send-tap user, and the TXCapturedUser epoch guard cannot see it \
            (user and epoch are captured together, so a switch BEFORE the \
            snapshot leaves a consistent pair). External review round 5, \
            finding 1.
            """
        )
        XCTAssertTrue(
            capture.upperBound < serialize.lowerBound,
            """
            The user snapshot must also precede annotation serialization — \
            same window, same defect.
            """
        )

        // Non-vacuity: this gate is only meaningful while `sendTapped()` really
        // does its prep work before constructing Inputs.
        let inputs = try XCTUnwrap(
            body.range(of: "let inputs = ReporterSubmission.Inputs("),
            "sendTapped() no longer builds ReporterSubmission.Inputs — has it been restructured?"
        )
        XCTAssertTrue(
            bake.upperBound < inputs.lowerBound,
            """
            Baking no longer happens before Inputs is built, so this ordering \
            gate would pass vacuously — re-derive what the submit boundary is.
            """
        )
    }

    /// Independent review, P1 — the persisted `identitySubject` must be
    /// gated by the SAME epoch decision as the live `identityToken`, not
    /// unconditionally threaded through from `inputs.capturedSession.user`.
    /// Before this fix, an epoch mismatch correctly withheld the live
    /// `identityToken` (see
    /// `testIdentityHeaderResolutionChecksTheEpochBeforeResolvingAndWithholdsOnMismatch`)
    /// but still enqueued the raw captured subject onto the `OutboxEntry` —
    /// inconsistent with `inputs.capturedSession.user.resolve()` two lines
    /// above, which already drops the self-declared user on the identical
    /// mismatch. A later drain could then attach a header on the strength
    /// of a subject the SDK had already concluded it should not rely on.
    ///
    /// Pins two things: (1) the exact gated expression is passed as
    /// `identitySubject:` to `submitter.submit(...)`, and (2) it shares the
    /// `capturedEpochStillCurrent` binding with `identityToken` — the "same
    /// place" requirement, so the two decisions cannot drift apart later.
    /// Same source-gate technique as the sibling tests in this class —
    /// `ReporterSubmission.swift` is entirely `#if canImport(UIKit)` and
    /// unreachable behaviourally from `swift test` on macOS.
    func testPersistedIdentitySubjectIsGatedByTheSameEpochDecisionAsTheLiveToken() throws {
        let code = Self.strippingLineComments(try Self.submissionSource())

        let declRange = try XCTUnwrap(
            code.range(of: "let capturedEpochStillCurrent: Bool"),
            "ReporterSubmission.swift no longer declares capturedEpochStillCurrent — has the identity gating been restructured?"
        )
        let subjectArgRange = try XCTUnwrap(
            code.range(of: "identitySubject: capturedEpochStillCurrent ? inputs.capturedSession.user.identitySubject : nil,"),
            """
            submitter.submit(...) no longer gates identitySubject on capturedEpochStillCurrent. \
            An epoch mismatch already withholds the live identityToken but this makes it also \
            enqueue the raw captured subject onto the OutboxEntry unconditionally — a later drain \
            could attach a header on the strength of a subject the SDK had already concluded it \
            should not rely on.
            """
        )
        XCTAssertTrue(
            declRange.upperBound < subjectArgRange.lowerBound,
            "capturedEpochStillCurrent must be declared before it gates identitySubject:"
        )

        // identityToken must be governed by the SAME binding, not a second,
        // independently-derived epoch comparison — that is what "make the
        // two decisions come from the same place" means, and what keeps
        // them from drifting apart later.
        XCTAssertNotNil(
            code.range(of: "identityToken = (capturedEpochStillCurrent && stillEnabled) ? resolved : nil"),
            "identityToken is no longer gated by capturedEpochStillCurrent — has the identity gating been restructured?"
        )
    }
}

/// Independent review, round 15, Serious — the live submit boundary
/// (`ReporterSubmission.swift`) snapshotted `identity.enabled`, then waited
/// up to `IDENTITY_PROVIDER_TIMEOUT` for the provider, then re-checked ONLY
/// the session epoch. A periodic config refresh can disable identity during
/// that wait without changing the epoch (only `start()`/`kill()` bump it),
/// so a report could still attach a resolved token after identity had
/// already been turned off. `ReportSubmitter.drainOutbox`'s own drain
/// paths already re-read enablement after the identical await
/// (`ReportSubmitterTests`, round 11 P1(c)) — this closes the gap the LIVE
/// reporter path had that the drain never did.
///
/// Same source-gate technique as the sibling classes above —
/// `ReporterSubmission.swift` is entirely `#if canImport(UIKit)` and
/// unreachable behaviourally from `swift test` on macOS; CI's
/// `xcodebuild test` job (a pinned Xcode against a real simulator) is the
/// authoritative behavioural verifier for this file, same as every other
/// gate in this class/file.
final class ReporterSubmissionIdentityEnablementSourceGate: XCTestCase {
    private static func submissionSource() throws -> String {
        let thisFile = URL(fileURLWithPath: #filePath)
        let packageRoot = thisFile
            .deletingLastPathComponent()   // TraceItXTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // package root
        let file = packageRoot
            .appendingPathComponent("Sources/TraceItX/Reporter/ReporterSubmission.swift")
        return try String(contentsOf: file, encoding: .utf8)
    }

    private static func strippingLineComments(_ source: String) -> String {
        source.split(separator: "\n", omittingEmptySubsequences: false)
            .map { line -> Substring in
                guard let slashes = line.range(of: "//") else { return line }
                return line[line.startIndex..<slashes.lowerBound]
            }
            .joined(separator: "\n")
    }

    func testIdentityEnablementIsReReadAfterResolutionAndGatesTheToken() throws {
        let code = Self.strippingLineComments(try Self.submissionSource())

        let resolveHeaderCall = try XCTUnwrap(
            code.range(of: "resolveIdentityHeader("),
            "ReporterSubmission.swift no longer calls resolveIdentityHeader(...) at the live submit boundary — identity wiring reverted to inert."
        )

        // The fresh, POST-resolution enablement read must exist, and must
        // appear strictly AFTER resolveIdentityHeader( — reading it only
        // before the await (the pre-fix shape) leaves the exact TOCTOU
        // window the coordinator flagged: a config refresh disabling
        // identity during the up-to-IDENTITY_PROVIDER_TIMEOUT wait would
        // never be seen.
        let stillEnabledRange = try XCTUnwrap(
            code.range(of: "let stillEnabled = isIdentityEnabled(await TraceItX.shared.currentReplayConfig())",
                       range: resolveHeaderCall.upperBound..<code.endIndex),
            """
            ReporterSubmission.swift no longer re-reads isIdentityEnabled on a FRESH currentReplayConfig() \
            read after resolveIdentityHeader(...) returns. resolveIdentityHeader's own suspension (the \
            provider re-ask, up to IDENTITY_PROVIDER_TIMEOUT) gives a remote config change that disables \
            identity — without bumping the epoch — a window to land during resolution, unnoticed by an \
            epoch-only re-check.
            """
        )

        // The token decision must actually USE both the epoch check AND the
        // fresh enablement read — not merely compute stillEnabled and
        // ignore it.
        XCTAssertNotNil(
            code.range(of: "identityToken = (capturedEpochStillCurrent && stillEnabled) ? resolved : nil",
                       range: stillEnabledRange.upperBound..<code.endIndex),
            "identityToken must be gated by BOTH capturedEpochStillCurrent AND the freshly re-read stillEnabled — a mismatch or a live disablement must both withhold the header."
        )

        // Deliberately NOT folded into capturedEpochStillCurrent itself —
        // that value also gates whether identitySubject is trustworthy
        // enough to PERSIST on a retry, a question purely about
        // project/session identity via the epoch. A live enablement flip
        // with no project switch at all must not make the captured
        // snapshot itself untrustworthy.
        let declRange = try XCTUnwrap(
            code.range(of: "let capturedEpochStillCurrent: Bool"),
            "capturedEpochStillCurrent is no longer declared — has the identity gating been restructured?"
        )
        let assignRange = try XCTUnwrap(
            code.range(of: "capturedEpochStillCurrent = inputs.capturedSession.user.startEpoch == TraceItX.shared.currentStartEpoch"),
            "capturedEpochStillCurrent's assignment no longer reads only the epoch comparison — has stillEnabled leaked into it?"
        )
        XCTAssertTrue(
            declRange.upperBound < assignRange.lowerBound,
            "capturedEpochStillCurrent must be declared before it is assigned"
        )
    }
}

// MARK: - ReporterSubmission resources source gate (fix round 1, CRITICAL 1)

/// Report Resource Window (spec 2026-09-05) — same source-gate technique as
/// the sibling classes above: `ReporterSubmission.swift` is entirely
/// `#if canImport(UIKit)` and unreachable behaviourally from `swift test` on
/// macOS (no network injection seam either — see the file header's
/// established note on `submit(_:)`), so a source gate is the only way this
/// runs on every host including this one; CI's `xcodebuild test` job is the
/// authoritative behavioural verifier.
///
/// Fix round 1, CRITICAL 1: `builder.buildEncoded(...)` at this call site
/// shipped `resources: nil` by omission — only `CrashReporter.swift` stamped
/// `payload.resources`. The user-submitted bug-report path is the feature's
/// PRIMARY use case, so every ordinary report shipped an empty resources
/// block despite the ring/envelope/config plumbing all being correct
/// end-to-end. Fixed by passing a live `ResourceRingBuffer.shared.snapshot()`
/// read, same as the crash path.
final class ReporterSubmissionResourcesSourceGate: XCTestCase {
    private static func submissionSource() throws -> String {
        let thisFile = URL(fileURLWithPath: #filePath)
        let packageRoot = thisFile
            .deletingLastPathComponent()   // TraceItXTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // package root
        let file = packageRoot
            .appendingPathComponent("Sources/TraceItX/Reporter/ReporterSubmission.swift")
        return try String(contentsOf: file, encoding: .utf8)
    }

    private static func strippingLineComments(_ source: String) -> String {
        source.split(separator: "\n", omittingEmptySubsequences: false)
            .map { line -> Substring in
                guard let slashes = line.range(of: "//") else { return line }
                return line[line.startIndex..<slashes.lowerBound]
            }
            .joined(separator: "\n")
    }

    func testBuildEncodedIsPassedALiveResourcesSnapshot() throws {
        let code = Self.strippingLineComments(try Self.submissionSource())

        let buildCall = try XCTUnwrap(
            code.range(of: "builder.buildEncoded("),
            "ReporterSubmission.swift no longer calls builder.buildEncoded(...) — has the submit path been restructured?"
        )
        let closeParen = try XCTUnwrap(
            code.range(of: ")\n\n", range: buildCall.upperBound..<code.endIndex),
            "could not locate the end of the buildEncoded(...) call to scope the resources: search"
        )

        XCTAssertNotNil(
            code.range(of: "resources: ResourceRingBuffer.shared.snapshot()",
                       range: buildCall.upperBound..<closeParen.upperBound),
            """
            ReporterSubmission.swift's buildEncoded(...) call no longer passes \
            resources: ResourceRingBuffer.shared.snapshot() — every user-submitted \
            bug report would once again ship payload.resources as nil/absent, the \
            one path this feature exists to serve (the crash path alone is not \
            enough: CrashReporter.swift covers only automatic crash/error reports).
            """
        )
    }
}
