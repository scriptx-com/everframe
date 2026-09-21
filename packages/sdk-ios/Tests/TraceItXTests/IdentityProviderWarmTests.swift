// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Final whole-branch review, Critical 1 — the PROVIDER form of
// `setIdentityToken` could never attach a header, on either platform, and the
// documentation actively recommends it ("Use the provider form").
//
// The chain that made this inert:
//   1. `IdentityTokenHolder.set(.provider { ... })` caches NOTHING — only
//      `.token(jwt)` self-caches inside `set()` (see that file's own doc
//      comment on `cached`/`cachedExp`).
//   2. `TraceItX.captureUserSnapshot()` stamps `identitySubject` from the
//      SYNCHRONOUS `_identityHolder.cachedSubject(now:)` — a cold cache reads
//      `nil`.
//   3. `resolveIdentityHeader` short-circuits on `capturedSubject == nil`
//      BEFORE it ever calls `holder.get(now:)` (`IdentityGate.swift`), so the
//      provider is never invoked and the cache is never warmed.
//   4. `IdentityTokenHolder.currentSubject(now:)` — whose own doc comment
//      calls it "the warm-up path … called elsewhere off the capture
//      boundary" — had ZERO production callers. Nothing ever warmed the
//      cache, so step 2 stamped `nil` FOREVER after installing a provider.
//
// The fix: `TraceItX.setIdentityToken` kicks off a detached warm
// (`_identityHolder.currentSubject(now:)`) when a non-nil source is
// installed. This suite drives the fix END TO END — through
// `setIdentityToken` → the detached warm → `captureUserSnapshot()` →
// `resolveIdentityHeader` — not the holder in isolation (`IdentityTokenHolderTests`
// already covers the holder's own `get`/`currentSubject` behaviour). Neither
// `TraceItX.swift` nor `IdentityTokenHolder.swift` nor `IdentityGate.swift` is
// UIKit-gated, so this runs under plain `swift test` on macOS, like
// `IdentityTokenHolderTests`' own singleton-driving cases.
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

/// Actor so the provider closure below can record its own invocation without
/// a data race. Deliberately a plain boolean, not the `Gate` actor used
/// elsewhere in this target: `Gate.wait()` blocks indefinitely until
/// `open()` is called, which is exactly wrong here — against the pre-fix
/// code the provider is never invoked at all, and this suite must FAIL
/// cleanly in that case, not hang the test run forever.
actor InvocationFlag {
    private(set) var value = false
    func mark() { value = true }
}

/// Minimal open/wait gate for deterministically parking
/// `TraceItX.__warmIdentityTokenPreReadHookForTesting` — mirrors
/// `ReplaySessionSupersessionTests.swift`'s own private `AsyncGate`
/// byte-for-byte; re-declared here rather than shared, per that file's own
/// documented convention for this target's small test-only fakes.
private actor AsyncGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func open() {
        isOpen = true
        let pending = waiters
        waiters.removeAll()
        pending.forEach { $0.resume() }
    }

    func waitUntilOpen() async {
        if isOpen { return }
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            waiters.append(cont)
        }
    }
}

final class IdentityProviderWarmTests: XCTestCase {

    override func tearDown() async throws {
        TraceItX.shared.kill()
        try await super.tearDown()
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
            configUrl: URL(string: "https://traceitx.com/api/config")!,
            apiKey: "tx_test_key",
            fetcher: SingleResponseFetcher(
                #"{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1,"identity":{"enabled":true}}"#)
        )
        await provider.refresh()
        return await provider.current
    }

    /// Polls `captureUserSnapshot()` until it stamps a subject or a budget
    /// expires. There is no synchronous signal for "the detached warm Task
    /// launched by `setIdentityToken` has finished" — `setIdentityToken`
    /// itself must stay synchronous (host code calls it from ordinary,
    /// non-async call sites) — so this is the only honest way to observe it
    /// settling, exactly like `AsyncTestHelpers.waitFor` used elsewhere in
    /// this target.
    private func pollForCapturedSubject() async -> TXCapturedUser {
        var captured = TraceItX.shared.captureUserSnapshot()
        var attempts = 0
        while captured.identitySubject == nil && attempts < 100 {
            try? await Task.sleep(nanoseconds: 20_000_000)  // 20ms
            captured = TraceItX.shared.captureUserSnapshot()
            attempts += 1
        }
        return captured
    }

    /// THE test that would have caught the defect: install a PROVIDER (not a
    /// one-shot token — `.token(jwt)` already self-caches inside `set()` and
    /// was never the broken case), let the warm happen, capture a report, and
    /// assert the gate actually attaches the header. Mutation-verified: this
    /// fails (times out with `captured.identitySubject == nil`) against the
    /// pre-fix `setIdentityToken`, which only calls `_identityHolder.set(source)`.
    func testInstallingAProviderWarmsTheCacheSoTheNextCaptureStampsTheSubject() async throws {
        let now = Date()
        let token = jwt(sub: "carol", exp: now.addingTimeInterval(300))
        let invoked = InvocationFlag()

        // Fix round 3, Serious 3 — the warm now refuses to invoke the
        // provider at all unless identity is enabled for the live config, so
        // this fixture must arm that (a project with identity disabled is
        // covered by its own dedicated test below).
        TraceItX.shared.__replayConfigOverrideForTesting = await enabledConfig()

        TraceItX.shared.setIdentityToken(.provider {
            await invoked.mark()
            return token
        })

        // Bounded polling throughout — deliberately NOT `await
        // invoked.wait()`-style blocking on an unbounded gate: against the
        // pre-fix code the provider is never invoked at all, and this test
        // must FAIL (not hang forever) in that case.
        let captured = await pollForCapturedSubject()
        XCTAssertEqual(
            captured.identitySubject, "carol",
            "installing a provider must warm the cache so the very next capture stamps the subject, not nil forever"
        )
        let wasInvoked = await invoked.value
        XCTAssertTrue(wasInvoked, "not vacuous: the provider must actually have been invoked as part of the warm")

        let header = await resolveIdentityHeader(
            capturedSubject: captured.identitySubject,
            holder: TraceItX.shared._identityHolder,
            config: await enabledConfig(),
            now: Date()
        )
        XCTAssertEqual(
            header, token,
            "the gate must attach the real (stubbed) header once the provider form has been given a chance to warm"
        )
    }

    /// Round 14 (codex round 12), Serious 1 — a provider token whose own TTL
    /// is at or below `IDENTITY_REFRESH_MARGIN` (30s) — `ttlSeconds: 30` is a
    /// supported `@traceitx/identity` configuration, exactly the kind of
    /// short-lived token a security-conscious customer would choose. Before
    /// the fix, `IdentityTokenHolder.get(now:)`'s provider branch applied the
    /// SAME margin check to a token the provider had JUST returned, so this
    /// scenario failed at the very first step: `commitIfCurrent` never ran,
    /// nothing was EVER cached, and the warm was permanently useless for any
    /// such provider — matching the finding's "never work at all."
    ///
    /// FOLLOW-UP (same round, coordinator re-review): the `get(now:)`-only
    /// fix above did NOT close this finding. `captureUserSnapshot()` never
    /// calls `get(now:)` — it stamps `identitySubject` from the SEPARATE,
    /// synchronous `cachedSubject(now:)`, which applied the SAME margin to a
    /// CACHED value. For a token whose own TTL never exceeds that margin the
    /// cached copy can never again clear it (remaining life only decreases
    /// from the moment it's minted), so the fix above moved the blockage one
    /// step down the chain — from "never cached" to "cached but never read
    /// back" — rather than removing it; `resolveIdentityHeader` still
    /// short-circuited on `capturedSubject == nil` before ever reaching
    /// `get(now:)`. Closed by widening `cachedSubject(now:)`'s own bar from
    /// "clears the margin" to "merely not yet expired" (see that function's
    /// own doc comment in `IdentityTokenHolder.swift` for why that's safe:
    /// this function's return value is only ever COMPARED against whatever
    /// `get` independently resolves at submit time, never presented itself).
    ///
    /// THE test that actually proves the finding is closed — drives the REAL
    /// capture path (`TraceItX.shared.captureUserSnapshot()`, via
    /// `pollForCapturedSubject()`, the SAME helper the ordinary-TTL test
    /// above uses), not the holder's `currentSubject`/`get` directly. A
    /// holder-level test alone could not have caught the residual: the
    /// holder was never the blocking step once `get(now:)` was fixed —
    /// `cachedSubject(now:)` was. Mutation-verified: reinstating the margin
    /// comparison in `cachedSubject(now:)` makes this fail (`captured
    /// .identitySubject` stays nil, the poll runs out its budget, and the
    /// header assertion never even gets a subject to work with).
    func testAProviderTokenWithAThirtySecondTTLStillWarmsIsStampedAtCaptureAndAttachesTheHeader() async throws {
        TraceItX.shared.__replayConfigOverrideForTesting = await enabledConfig()
        let invoked = InvocationFlag()

        TraceItX.shared.setIdentityToken(.provider {
            await invoked.mark()
            // Exactly a 30s TTL from the moment the provider is asked — the
            // shortest supported configuration, and the one both halves of
            // this finding rejected outright before their respective fixes.
            return self.jwt(sub: "kim", exp: Date().addingTimeInterval(30))
        })

        // Bounded polling on the provider having been invoked at all —
        // proves the warm actually fired before moving on to the real
        // capture-path assertion below.
        var wasInvoked = await invoked.value
        var attempts = 0
        while !wasInvoked, attempts < 100 {
            try? await Task.sleep(nanoseconds: 20_000_000)  // 20ms
            wasInvoked = await invoked.value
            attempts += 1
        }
        XCTAssertTrue(wasInvoked, "setIdentityToken must kick off a warm that invokes the provider")

        let captured = await pollForCapturedSubject()
        XCTAssertEqual(
            captured.identitySubject, "kim",
            "a 30s-TTL provider token must still warm the cache AND be stamped by the real, synchronous " +
                "captureUserSnapshot() capture path — not just usable via the holder's own async get()"
        )

        let header = await resolveIdentityHeader(
            capturedSubject: captured.identitySubject,
            holder: TraceItX.shared._identityHolder,
            config: await enabledConfig(),
            now: Date()
        )
        XCTAssertNotNil(
            header,
            "the header must attach end to end for a 30s-TTL provider token, not just a long-lived one"
        )
    }

    /// The one-shot `.token(...)` form already self-caches inside `set()`
    /// (unaffected by this defect) — pinned here so a future change to the
    /// warm logic cannot regress the already-working case while "fixing" the
    /// provider form.
    func testInstallingAOneShotTokenStillWarmsTheCacheImmediately() async throws {
        // Independent review, round 4 (Serious 3) — `captureUserSnapshot()`
        // now also gates the stamp on identity being enabled for the
        // project (see `TraceItX._identityEnabledFlag`'s doc comment); this
        // test's own point is the one-shot self-cache timing, not that
        // gate, so arm it the same way the sibling tests in this file do.
        TraceItX.shared.__replayConfigOverrideForTesting = await enabledConfig()
        let now = Date()
        let token = jwt(sub: "dave", exp: now.addingTimeInterval(300))

        TraceItX.shared.setIdentityToken(.token(token))

        // No polling needed — `.token(...)` self-caches synchronously inside
        // `set()`, before `setIdentityToken` even returns.
        let captured = TraceItX.shared.captureUserSnapshot()
        XCTAssertEqual(captured.identitySubject, "dave")
    }

    /// Clearing identity (`setIdentityToken(nil)`) must not kick off a warm at
    /// all — nothing to warm, and a stray detached Task calling
    /// `currentSubject` on an empty holder would just be wasted work.
    func testClearingIdentityStampsNoSubject() async throws {
        TraceItX.shared.setIdentityToken(.token(jwt(sub: "eve", exp: Date().addingTimeInterval(300))))
        TraceItX.shared.setIdentityToken(nil)

        let captured = TraceItX.shared.captureUserSnapshot()
        XCTAssertNil(captured.identitySubject)
    }

    // MARK: - Fix round 2: the install warm alone is NOT sufficient
    //
    // Re-review finding: the warm added above fires only at install and
    // nothing ever re-warms. Once the install-warmed token ages inside
    // `IDENTITY_REFRESH_MARGIN`, `cachedSubject(now:)` reads nil again and
    // NOTHING re-invokes the provider — `resolveIdentityHeader` short-
    // circuits on a nil captured subject before it ever reaches
    // `holder.get(now:)`. The original dead-end chain reasserts itself
    // verbatim after at most one token lifetime (≤10 minutes) per
    // `setIdentityToken` call.
    //
    // Fix: `TraceItX.__warmIdentityToken()` — the same warm `setIdentityToken`
    // already fires — is now also called at reporter-open
    // (`TXReporterPresenter.openAndAwait()` / `CompanionCaptureBridge
    // .handleReportRequest`, both UIKit-gated and source-gated below).

    /// THE test that must exist per the re-review: age the cached token PAST
    /// the refresh margin, then capture, and assert the header still
    /// attaches. Reproduces the re-reviewer's own probe first (fixture
    /// sanity — proves aging alone really does go stale, matching their
    /// measured `identitySubject after token aged past margin = nil`), then
    /// drives the actual fix (`__warmIdentityToken()`, what reporter-open now
    /// calls) and proves it recovers. Mutation-verified: gutting
    /// `__warmIdentityToken()` to a no-op reproduces the re-reviewer's exact
    /// dead end at the final assertions.
    func testReporterOpenRewarmsAnAgedTokenBeforeTheNextCapture() async throws {
        let counter = CallCounter()
        // Fix round 3, Serious 3 — arm identity-enabled so the warm's own
        // gate lets it through (see the dedicated disabled-project test
        // below for the negative case).
        TraceItX.shared.__replayConfigOverrideForTesting = await enabledConfig()
        // Round 14 follow-up (Serious 1) — this used to use a 33s first TTL
        // and treat ~28.5s-remaining (inside the 30s margin, NOT expired) as
        // "stale." `cachedSubject(now:)` no longer agrees: it now accepts
        // any not-yet-expired cached token (see that function's own doc
        // comment in IdentityTokenHolder.swift), so a merely-inside-the-
        // margin token is exactly the case that round's fix was FOR, not a
        // staleness case anymore. A 6s first TTL, aged past with a 6.5s
        // sleep, is genuinely expired — what "stale" now means post-fix.
        TraceItX.shared.setIdentityToken(.provider {
            await counter.bump()
            let n = await counter.value
            let exp = n == 1 ? Date().addingTimeInterval(6) : Date().addingTimeInterval(300)
            return self.jwt(sub: "frank", exp: exp)
        })

        // Let the install warm (round 1) settle.
        var captured = await pollForCapturedSubject()
        XCTAssertEqual(captured.identitySubject, "frank", "fixture sanity: the install warm must land first")
        var calls = await counter.value
        XCTAssertEqual(calls, 1, "fixture sanity: exactly one call so far")

        // Age PAST actual expiry (not merely past the margin — see above) —
        // real wall-clock sleep, no clock injection in this holder by
        // design.
        try await Task.sleep(nanoseconds: 6_500_000_000)

        // Reproduces the re-reviewer's probe exactly: with nothing to
        // re-warm it, the cache is stale (now: actually expired) and
        // captureUserSnapshot() stamps nil again — the original dead end,
        // verbatim.
        let staleCaptured = TraceItX.shared.captureUserSnapshot()
        XCTAssertNil(
            staleCaptured.identitySubject,
            "fixture sanity: aging past actual expiry must go stale, or this test proves nothing"
        )
        calls = await counter.value
        XCTAssertEqual(calls, 1, "fixture sanity: nothing has re-invoked the provider yet")

        // THE FIX under test: this is exactly what `TXReporterPresenter
        // .openAndAwait()` and `CompanionCaptureBridge.handleReportRequest`
        // now call at reporter-open (see the source-gate tests below).
        TraceItX.shared.__warmIdentityToken()

        captured = await pollForCapturedSubject()
        XCTAssertEqual(
            captured.identitySubject, "frank",
            "reporter-open must re-warm an aged token so the NEXT capture stamps the subject again"
        )
        calls = await counter.value
        XCTAssertEqual(calls, 2, "not vacuous: the provider must actually have been RE-invoked, not just re-read a stale cache")

        let header = await resolveIdentityHeader(
            capturedSubject: captured.identitySubject,
            holder: TraceItX.shared._identityHolder,
            config: await enabledConfig(),
            now: Date()
        )
        XCTAssertNotNil(header, "the header must attach once reporter-open has re-warmed an aged token")
    }

    // MARK: - Fix round 3, Serious 3: the warm must respect `identity.enabled`
    //
    // Independent review finding: `__warmIdentityToken()` invoked the host's
    // provider UNCONDITIONALLY — before config exists, and for projects
    // where identity is disabled. That breaks the guarantee the whole
    // `identity.enabled` gate exists for ("a project with no signing secret
    // never calls the customer's endpoint"): installing a provider fired the
    // host's auth/network work for every project, including ones that will
    // never present a header, and cached a subject a subsequent capture
    // could persist into the outbox even though identity is off.

    /// THE test that must exist per the re-review: with identity disabled
    /// (the default — no config armed at all, matching a project with no
    /// signing secret, or one whose config simply hasn't fetched yet),
    /// installing a provider must never invoke it. Mutation-verified:
    /// reverting the `isIdentityEnabled` guard in `__warmIdentityToken()`
    /// makes this fail (the provider IS invoked).
    func testWarmDoesNotInvokeTheProviderWhenIdentityIsDisabledForTheProject() async throws {
        let invoked = InvocationFlag()

        // Deliberately NOT arming `__replayConfigOverrideForTesting` —
        // `currentReplayConfig()` therefore resolves the fail-closed `.off`
        // default, exactly like a project with no signing secret, or the
        // brief pre-fetch window before ANY project's config has settled.
        TraceItX.shared.setIdentityToken(.provider {
            await invoked.mark()
            return self.jwt(sub: "henry", exp: Date().addingTimeInterval(300))
        })

        // No timer, no wait — per the fix's own constraint, a disabled
        // project's warm must SKIP, not queue or retry. A generous but
        // bounded sleep is the only way to assert a negative ("this never
        // happens") for a fire-and-forget detached Task; `currentReplayConfig()`
        // resolving `.off` is synchronous-ish (a MainActor hop, no network),
        // so this is not racing anything slow.
        try? await Task.sleep(nanoseconds: 300_000_000)

        let wasInvoked = await invoked.value
        XCTAssertFalse(
            wasInvoked,
            "identity is disabled for this project (no config armed) — the warm must never invoke the provider"
        )

        let captured = TraceItX.shared.captureUserSnapshot()
        XCTAssertNil(captured.identitySubject, "not vacuous: nothing should have been cached either")
    }

    /// Companion case: reporter-open's re-warm call site must respect the
    /// SAME gate — driven through the actual `__warmIdentityToken()` entry
    /// point reporter-open calls, not a bespoke path.
    func testReporterOpenWarmDoesNotInvokeTheProviderWhenIdentityIsDisabled() async throws {
        let invoked = InvocationFlag()
        TraceItX.shared.setIdentityToken(.provider {
            await invoked.mark()
            return self.jwt(sub: "iris", exp: Date().addingTimeInterval(300))
        })

        // Exactly what `TXReporterPresenter.openAndAwait()` /
        // `CompanionCaptureBridge.handleReportRequest` call at reporter-open
        // — invoked explicitly a second time here to isolate it as its own
        // assertion, even though the install call above already exercises
        // the identical gate.
        TraceItX.shared.__warmIdentityToken()
        try? await Task.sleep(nanoseconds: 300_000_000)

        let wasInvoked = await invoked.value
        XCTAssertFalse(
            wasInvoked,
            "reporter-open's re-warm must also refuse to invoke the provider when identity is disabled"
        )
    }

    // MARK: - Round 19 (codex round 17): a warm racing a project switch
    // must never observe the OLD project's enablement.
    //
    // `__warmIdentityToken()` used to read `currentReplayConfig()`, which
    // falls back to `_replaySession.currentConfig` — but `start(projectB)`
    // tears down project A's `_replaySession` ASYNCHRONOUSLY (a `Task
    // { @MainActor in ... }`, `TraceItX.swift`'s `start()`), so a
    // `setIdentityToken(.provider)` racing `start(projectB)` could still
    // observe A's `identity.enabled == true` for as long as that async
    // teardown had not yet run, and invoke B's provider even though B has
    // identity disabled — breaking the guarantee this branch has now
    // defended three separate times ("a project with no signing secret
    // never triggers customer authentication or network work").
    //
    // Fix: `__warmIdentityToken()` now consults `_identityEnabledFlag`
    // instead — the SAME flag `captureUserSnapshot()` already reads for the
    // identical reason. `start()`/`kill()` reset this flag SYNCHRONOUSLY,
    // in the very first `stateLock` critical section, well before the
    // async session teardown — so a read of the flag taken AFTER
    // `start(projectB)` has run observes AT WORST `false`, never A's stale
    // `true`.

    /// Drives the REAL `start()`, via `TraceItX.__warmIdentityTokenPreReadHookForTesting`
    /// (this round's new parking hook, mirroring `ReplaySession`'s existing
    /// `preApplyHookForTesting` pattern): the warm is dispatched while A is
    /// still current (so its provider closure is already in flight, exactly
    /// like production), but its enablement READ is parked until AFTER
    /// `start(projectB)`'s own synchronous section has completed — the
    /// worst-case ordering for the fix to get right, since it grants the
    /// read every possible chance to observe B's state instead of A's stale
    /// one, through the REAL production reset path (not a substitute).
    ///
    /// NOT mutation-verifiable on this platform, honestly: the ORIGINAL bug
    /// was `_replaySession.currentConfig` staying stale during `start()`'s
    /// ASYNC session teardown — but `_replaySession` is `#if canImport(UIKit)`-gated,
    /// and `currentReplayConfig()`'s `#else` branch (what this macOS host
    /// build actually runs) returns `.off` UNCONDITIONALLY, never A's
    /// config, regardless of whether the fix is present. Confirmed
    /// empirically, not assumed: reverting `__warmIdentityToken()` to the
    /// pre-fix `currentReplayConfig()` read left this test GREEN — proving
    /// the mutation is inert here, not that the fix is unnecessary (round
    /// 17's own citation, `TraceItX.swift:741`, is real, iOS-only, UIKit-
    /// only code). This test still earns its place as a real, if weaker,
    /// regression pin: it proves the FIXED code behaves correctly end to
    /// end through a REAL `start()` call under the worst deterministic
    /// ordering this harness can produce. The sibling test below isolates
    /// the specific mechanism (fresh-read timing) that this test's
    /// correctness — and the real fix's correctness on iOS — depends on,
    /// and IS mutation-verified, on this same platform, without needing
    /// `_replaySession` at all. CI's `lifecycle-tests-iOS` job remains the
    /// only place the literal original bug (a stale, still-installed
    /// `ReplaySession`) can be reproduced and is therefore the authoritative
    /// verifier for that specific mechanism.
    func testAProviderWarmRacingAProjectSwitchNeverObservesTheOldProjectsEnablement() async throws {
        let gate = AsyncGate()
        TraceItX.__warmIdentityTokenPreReadHookForTesting = { await gate.waitUntilOpen() }
        defer { TraceItX.__warmIdentityTokenPreReadHookForTesting = nil }

        // Project A: identity enabled. Set directly on the flag rather than
        // driving a real ReplaySession/network fetch — the fix under test
        // is about race TIMING relative to `start()`'s synchronous reset,
        // not about how A's flag came to be `true` in the first place; this
        // mirrors how this file's OTHER fixtures arm "enabled" via
        // `__replayConfigOverrideForTesting` (a different test seam) rather
        // than a real fetch.
        TraceItX.shared._identityEnabledFlag.set(true)

        let invoked = InvocationFlag()
        // Dispatches the warm while A is still "current" — parks
        // immediately on the hook above, BEFORE reading anything.
        TraceItX.shared.setIdentityToken(.provider {
            await invoked.mark()
            return self.jwt(sub: "alice", exp: Date().addingTimeInterval(300))
        })

        // Project B: identity disabled (the default — no override armed,
        // no config fetched yet). `start()`'s own synchronous section
        // resets `_identityEnabledFlag` to `false` before this call even
        // returns — real production code, not a test seam.
        try TraceItX.shared.start(config: TraceItXConfig(appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"))

        // Release the parked warm's read — now guaranteed to run AFTER B's
        // synchronous reset above, the worst-case ordering for the fix.
        await gate.open()

        // Bounded wait, same discipline as `pollForCapturedSubject()`
        // above: proving a negative for a fire-and-forget detached Task
        // needs a generous but bounded window, not an unconditional sleep.
        var wasInvoked = await invoked.value
        var attempts = 0
        while !wasInvoked, attempts < 50 {
            try? await Task.sleep(nanoseconds: 20_000_000)  // 20ms
            wasInvoked = await invoked.value
            attempts += 1
        }

        XCTAssertFalse(
            wasInvoked,
            """
            a provider warm racing a project switch must never invoke the OLD project's provider off of the \
            NEW project's (disabled) enablement window
            """
        )
    }

    /// Isolates the SPECIFIC property the sibling test above depends on to
    /// be correct, and that the real iOS fix depends on against the literal
    /// `_replaySession` staleness that platform limitation prevents
    /// reproducing here: the warm's enablement check must read
    /// `_identityEnabledFlag` FRESH, at the moment it actually checks it —
    /// never a value captured earlier and carried across the parked hook.
    /// Deliberately flips the flag DIRECTLY rather than via `start()`/
    /// `kill()`: both of those ALSO clear `_identityHolder`'s SOURCE in the
    /// same synchronous section (see `start()`'s own doc comment on
    /// `_identityHolder.set(nil)`), which would independently defeat the
    /// warm regardless of the enablement check and confound this test's
    /// isolation of read-timing specifically — confirmed empirically: an
    /// earlier version of this test drove real `start()` here and the
    /// intended mutation (below) stayed GREEN, masked by that unrelated
    /// reset, not by the fix under test.
    ///
    /// Mutation-verified: capturing `identityEnabledFlag.get()` SYNCHRONOUSLY
    /// at dispatch time (before the parked hook releases), instead of
    /// freshly inside the detached `Task` after it, makes this fail — the
    /// provider IS invoked, using the STALE `true` snapshot instead of the
    /// flag's later `false`.
    func testTheWarmsEnablementCheckReadsTheFlagFreshNotAStaleSnapshot() async throws {
        let gate = AsyncGate()
        TraceItX.__warmIdentityTokenPreReadHookForTesting = { await gate.waitUntilOpen() }
        defer { TraceItX.__warmIdentityTokenPreReadHookForTesting = nil }

        // "Currently enabled" — matches the sibling test's fixture style.
        TraceItX.shared._identityEnabledFlag.set(true)

        let invoked = InvocationFlag()
        // Dispatches the warm while the flag still reads `true` — parks
        // immediately on the hook above, BEFORE reading anything.
        TraceItX.shared.setIdentityToken(.provider {
            await invoked.mark()
            return self.jwt(sub: "alice", exp: Date().addingTimeInterval(300))
        })

        // Flip the flag directly, AFTER the warm has been dispatched and
        // parked but BEFORE its read is released.
        TraceItX.shared._identityEnabledFlag.set(false)

        // Release the parked warm's read — now guaranteed to run AFTER the
        // flip above.
        await gate.open()

        var wasInvoked = await invoked.value
        var attempts = 0
        while !wasInvoked, attempts < 50 {
            try? await Task.sleep(nanoseconds: 20_000_000)  // 20ms
            wasInvoked = await invoked.value
            attempts += 1
        }

        XCTAssertFalse(
            wasInvoked,
            "the warm's enablement check must read the flag fresh at read time, not a snapshot captured before it was parked"
        )
    }
}

// `CallCounter` reused from `IdentityTokenHolderTests.swift` (file-scope,
// internal — visible target-wide) rather than re-declared here.

// MARK: - Source gates: the two UIKit-gated reporter-open call sites
//
// `TXReporterPresenter.swift` (TraceItXReporterUI module) and
// `CompanionCaptureBridge.swift`'s `handleReportRequest` are both entirely
// (or, for the latter, substantially) `#if canImport(UIKit)`-gated and do not
// exist in the macOS `swift test` binary — same established reason
// `ReporterSubmissionUserExtrasSourceGate` (EnvelopeUserTests.swift) source-
// gates `ReporterSubmission.swift` instead of driving it behaviourally. These
// pin that both real call sites actually invoke `__warmIdentityToken()`, not
// just that the mechanism itself works in isolation (proven above).

final class ReporterOpenIdentityWarmSourceGate: XCTestCase {
    private static func packageRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // TraceItXTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // package root
    }

    private static func source(_ relativePath: String) throws -> String {
        try String(contentsOf: packageRoot().appendingPathComponent(relativePath), encoding: .utf8)
    }

    private static func strippingLineComments(_ source: String) -> String {
        source.split(separator: "\n", omittingEmptySubsequences: false)
            .map { line -> Substring in
                guard let slashes = line.range(of: "//") else { return line }
                return line[line.startIndex..<slashes.lowerBound]
            }
            .joined(separator: "\n")
    }

    func testTXReporterPresenterWarmsIdentityAtReporterOpen() throws {
        let code = Self.strippingLineComments(
            try Self.source("Sources/TraceItXReporterUI/TXReporterPresenter.swift"))

        let warmCall = try XCTUnwrap(
            code.range(of: "TraceItX.shared.__warmIdentityToken()"),
            """
            TXReporterPresenter.swift no longer calls TraceItX.shared.__warmIdentityToken() at \
            reporter-open. Without it, a provider-form host's cache goes stale after one token \
            lifetime post-install and is never re-warmed before the Send tap.
            """
        )
        let captureCall = try XCTUnwrap(
            code.range(of: "ScreenshotCapture.captureKeyWindow()"),
            "capture-before-reporter ordering marker not found — has TXReporterPresenter.swift been restructured?"
        )
        XCTAssertTrue(
            warmCall.lowerBound < captureCall.lowerBound,
            "the identity warm should fire as early as possible — before capture — to maximise the provider's time to resolve before Send"
        )
    }

    func testCompanionCaptureBridgeWarmsIdentityAtReportRequest() throws {
        let code = Self.strippingLineComments(
            try Self.source("Sources/TraceItX/Companion/CompanionCaptureBridge.swift"))

        XCTAssertNotNil(
            code.range(of: "TraceItX.shared.__warmIdentityToken()"),
            """
            CompanionCaptureBridge.swift no longer calls TraceItX.shared.__warmIdentityToken() at \
            report.request (the companion path's own reporter-open moment — see this file's own \
            "report.request IS reporter-open" note).
            """
        )
    }
}
