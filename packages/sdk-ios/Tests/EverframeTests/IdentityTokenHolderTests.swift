// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The holder is the only piece of C1 with real logic, and it is deliberately
// NOT on the Everframe singleton: Everframe.swift is canImport(UIKit)-gated, so a
// holder living there would be unreachable from `swift test` on macOS — which
// is every test run this Everframe SDK has in CI.
//
// The decode is not a verification. the server identity-token verifier is the
// only place a signature is checked; here an undecodable or expired token is
// simply ABSENT, exactly like a host that never called setIdentityToken.
import XCTest
@testable import EverframeKit

final class IdentityTokenHolderTests: XCTestCase {

    /// Build an unsigned-but-well-formed JWT with the given claims. The holder
    /// never verifies, so a fake signature is the honest fixture here.
    private func jwt(sub: String?, exp: Date?) -> String {
        var claims: [String: Any] = [:]
        if let sub { claims["sub"] = sub }
        if let exp { claims["exp"] = Int(exp.timeIntervalSince1970) }
        let header = #"{"alg":"HS256","typ":"JWT"}"#.data(using: .utf8)!
        let payload = try! JSONSerialization.data(withJSONObject: claims)
        func b64(_ d: Data) -> String {
            d.base64EncodedString()
                .replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
        }
        return "\(b64(header)).\(b64(payload)).not-a-real-signature"
    }

    func testServesAStringTokenWellBeforeExpiry() async {
        let now = Date()
        let holder = IdentityTokenHolder()
        let t = jwt(sub: "alice", exp: now.addingTimeInterval(300))
        holder.set(.token(t))
        let got = await holder.get(now: now)
        XCTAssertEqual(got, t)
        let sub = await holder.currentSubject(now: now)
        XCTAssertEqual(sub, "alice")
    }

    func testRefusesATokenInsideTheThirtySecondMargin() async {
        let now = Date()
        let holder = IdentityTokenHolder()
        // 29s of life left — inside the margin, so presenting it buys nothing:
        // it may well have expired by the time it reaches the server.
        holder.set(.token(jwt(sub: "alice", exp: now.addingTimeInterval(29))))
        let got = await holder.get(now: now)
        XCTAssertNil(got)
    }

    func testServesATokenJustOutsideTheMargin() async {
        let now = Date()
        let holder = IdentityTokenHolder()
        holder.set(.token(jwt(sub: "alice", exp: now.addingTimeInterval(31))))
        let got = await holder.get(now: now)
        XCTAssertNotNil(got)
    }

    func testAnAlreadyExpiredTokenIsAbsentNotAnError() async {
        let now = Date()
        let holder = IdentityTokenHolder()
        holder.set(.token(jwt(sub: "alice", exp: now.addingTimeInterval(-1))))
        let got = await holder.get(now: now)
        XCTAssertNil(got)
    }

    func testAnUndecodableTokenIsTreatedAsAbsent() async {
        let holder = IdentityTokenHolder()
        holder.set(.token("this is not a jwt"))
        let got = await holder.get(now: Date())
        XCTAssertNil(got)
    }

    /// Independent review, round 4 (Serious 2, Android-side finding; checked
    /// here per the coordinator's explicit ask). A token whose header or
    /// signature segment contains a character outside the base64url
    /// alphabet used to decode FINE — `decodeIdentityClaims` only ever
    /// inspected the payload segment. Mutation-verified: reverting the
    /// character-safety check makes this fail (the malformed token would be
    /// served rather than rejected).
    func testATokenWithAnIllegalHeaderCharacterInTheSignatureSegmentIsTreatedAsAbsent() async {
        let now = Date()
        let holder = IdentityTokenHolder()
        let wellFormed = jwt(sub: "alice", exp: now.addingTimeInterval(300))
        // Same header + payload as a perfectly valid token — only the
        // signature segment is corrupted with a bare newline.
        let lastDot = wellFormed.lastIndex(of: ".")!
        let malformed = wellFormed[..<lastDot] + ".bad\nsignature"
        holder.set(.token(String(malformed)))
        let got = await holder.get(now: now)
        XCTAssertNil(got, "a token with an illegal header character anywhere in it must be treated as absent")
    }

    func testATokenWithAnIllegalHeaderCharacterInTheHeaderSegmentIsTreatedAsAbsent() async {
        let now = Date()
        let holder = IdentityTokenHolder()
        let wellFormed = jwt(sub: "alice", exp: now.addingTimeInterval(300))
        let firstDot = wellFormed.firstIndex(of: ".")!
        let malformed = "bad\nheader" + wellFormed[firstDot...]
        holder.set(.token(String(malformed)))
        let got = await holder.get(now: now)
        XCTAssertNil(got, "a corrupted header segment must also be rejected, not just the signature segment")
    }

    func testAnOverLengthTokenPastTheServersOwnCeilingIsTreatedAsAbsent() async {
        let now = Date()
        let holder = IdentityTokenHolder()
        // Mirrors the server identity-token verifier's own
        // IDENTITY_TOKEN_MAX_CHARS — refusing here is cheap and saves a
        // pointless round trip.
        let tooLong = jwt(sub: String(repeating: "a", count: IDENTITY_TOKEN_MAX_CHARS), exp: now.addingTimeInterval(300))
        XCTAssertGreaterThan(tooLong.count, IDENTITY_TOKEN_MAX_CHARS, "fixture sanity: the built token must actually exceed the ceiling")
        holder.set(.token(tooLong))
        let got = await holder.get(now: now)
        XCTAssertNil(got)
    }

    /// The provider path routes through the SAME `decodeIdentityClaims`
    /// choke point — the rejection must apply there too, not just to a
    /// one-shot `.token` source.
    func testAProviderResultWithAnIllegalHeaderCharacterIsTreatedAsAbsentNotCached() async {
        let now = Date()
        let wellFormed = jwt(sub: "alice", exp: now.addingTimeInterval(300))
        let lastDot = wellFormed.lastIndex(of: ".")!
        let malformed = String(wellFormed[..<lastDot] + ".bad\nsignature")
        let holder = IdentityTokenHolder()
        holder.set(.provider { malformed })
        let got = await holder.get(now: now)
        XCTAssertNil(got, "a provider result with an illegal header character must be treated as absent, not cached/served verbatim")
    }

    /// Independent review, round 4 — empirically pins the platform fact
    /// `decodeIdentityClaims`'s doc comment relies on, rather than assuming
    /// it: `URLRequest.setValue(_:forHTTPHeaderField:)` is not `throws` (so
    /// it structurally CANNOT reproduce Android's "OkHttp throws and the
    /// report is lost" failure mode), and empirically, for a value
    /// containing a bare `\n` or `\r`, it silently declines to set the
    /// field at all rather than storing a corrupted value — confirmed here
    /// via `allHTTPHeaderFields`, not via the higher-level holder (which
    /// now rejects such tokens earlier anyway, so this test's whole point
    /// is to prove what happens on the platform side, independent of that
    /// guard).
    func testFoundationSilentlyDropsAHeaderValueContainingCRLF() {
        var req = URLRequest(url: URL(string: "https://example.com/api")!)
        req.setValue("hdr.payload.bad\nsignature", forHTTPHeaderField: "X-Probe")
        XCTAssertNil(
            req.value(forHTTPHeaderField: "X-Probe"),
            "Foundation must silently decline a header value containing a bare newline, not store it"
        )
        XCTAssertEqual(
            req.allHTTPHeaderFields?["X-Probe"], nil,
            "the field must be entirely absent, not present with a truncated/sanitized value"
        )

        var reqCR = URLRequest(url: URL(string: "https://example.com/api")!)
        reqCR.setValue("hdr.payload.bad\rsignature", forHTTPHeaderField: "X-Probe")
        XCTAssertNil(reqCR.value(forHTTPHeaderField: "X-Probe"), "same for a bare carriage return")
    }

    /// Independent review, round 4 (Serious 2) — the "report survives" half,
    /// matching the Android fix's requirement exactly even though the
    /// specific "OkHttp throws and the report is lost" mechanism has no iOS
    /// equivalent (see `testFoundationSilentlyDropsAHeaderValueContainingCRLF`
    /// above). A malformed token must resolve to no header, end to end
    /// through the real submit path, and the report must still reach the
    /// server successfully.
    func testAMalformedTokenStillLetsTheReportSubmit() async throws {
        RecordingURLProtocol.reset()
        let now = Date()
        let holder = IdentityTokenHolder()
        let wellFormed = jwt(sub: "alice", exp: now.addingTimeInterval(300))
        let lastDot = wellFormed.lastIndex(of: ".")!
        let malformed = String(wellFormed[..<lastDot] + ".bad\nsignature")
        holder.set(.token(malformed))

        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [RecordingURLProtocol.self]
        let session = URLSession(configuration: cfg)

        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("everframe-malformed-token-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        let outbox = JSONLOutbox(testFileURL: tempDir.appendingPathComponent("outbox.jsonl"))

        let submitter = ReportSubmitter(
            config: EverframeConfig(appId: "app"), outbox: outbox, session: session)

        let resolved = await resolveIdentityHeader(
            capturedSubject: "alice",
            holder: holder,
            config: ReplayConfig(
                replayEnabled: true, replayDurationSec: 30, samplingRate: 1.0,
                identity: IdentityConfigWire(enabled: true)
            ),
            now: now
        )
        XCTAssertNil(resolved, "fixture sanity: a malformed token must resolve to no header")

        let result = try await submitter.submit(
            envelopeBytes: Data("{}".utf8),
            idempotencyKey: "idem-malformed",
            attachments: [],
            identitySubject: "alice",
            identityToken: resolved
        )

        guard case .submitted = result else {
            XCTFail("a malformed token must not prevent the report from submitting — got \(result)")
            return
        }
        XCTAssertEqual(RecordingURLProtocol.recorded.count, 1, "the report must actually reach the server")
        XCTAssertNil(
            RecordingURLProtocol.recorded.first?.identityToken,
            "the token was malformed, so this must ship anonymously — no header, but the report must still ship"
        )
    }

    func testATokenWithNoExpIsTreatedAsAbsent() async {
        let now = Date()
        let holder = IdentityTokenHolder()
        // No `exp` means we cannot know when to stop presenting it. Refusing is
        // the fail-closed direction; the verifier would reject it anyway.
        holder.set(.token(jwt(sub: "alice", exp: nil)))
        let got = await holder.get(now: now)
        XCTAssertNil(got)
    }

    func testSetNilSignsOutImmediatelyEvenMidLifetime() async {
        let now = Date()
        let holder = IdentityTokenHolder()
        holder.set(.token(jwt(sub: "alice", exp: now.addingTimeInterval(300))))
        holder.set(nil)
        let got = await holder.get(now: now)
        XCTAssertNil(got)
    }

    func testAProviderIsInvokedAndItsResultCached() async {
        let now = Date()
        let t = jwt(sub: "bob", exp: now.addingTimeInterval(300))
        let counter = CallCounter()
        let holder = IdentityTokenHolder()
        holder.set(.provider { await counter.bump(); return t })

        let first = await holder.get(now: now)
        let second = await holder.get(now: now)
        XCTAssertEqual(first, t)
        XCTAssertEqual(second, t)
        let calls = await counter.value
        XCTAssertEqual(calls, 1, "a cached, still-fresh token must not re-ask the provider")
    }

    /// Independent review, round 11, P1(a) follow-up — a genuine race this
    /// round's own `ProviderCall` redesign introduced and then closed within
    /// the same round: `value(timeout:)` used to check "already resolved"
    /// and register its waiter as TWO SEPARATE lock acquisitions.
    /// `start(_:)`'s `Task` runs concurrently and can call `deliver(_:)` —
    /// which snapshots-then-clears `waiters` — in the window between those
    /// two steps. When a provider resolves fast enough (a purely
    /// synchronous closure, plausible for anything backed by an in-memory
    /// cache rather than a real network call), a caller could lose the
    /// delivery entirely: `deliver` sees this caller not yet registered,
    /// notifies nobody, and the caller's OWN registration then lands into a
    /// dictionary nothing will ever consult again — it falls through to its
    /// own timeout and wrongly resolves `nil` after the full ~2s bound
    /// instead of the value that, in truth, was already available.
    ///
    /// Found empirically, not by inspection: `DrainIdentityHeaderTests`'s
    /// mid-resolution identity-enablement race test (added earlier this same
    /// round, for P1(c)) intermittently took the full ~2s bound and returned
    /// the wrong (`nil`) result instead of resolving promptly — traced with
    /// temporary debug instrumentation to `resolvedOrRegister`'s pre-fix
    /// two-step shape specifically: `preConfig`/`resolved` both logged
    /// correctly, yet the caller still fell through to its own timeout.
    /// Fixed via `resolvedOrRegister(_:_:)` — an ATOMIC check-and-register
    /// under one lock acquisition (see that method's own doc comment for the
    /// full mechanism) — confirmed by re-running the SAME instrumented
    /// reproduction: elapsed time dropped from ~2.06s (timeout, wrong result)
    /// to ~0.009s (immediate, correct result).
    ///
    /// This specific test, run against BOTH the fixed code and a reverted
    /// two-step mutation, did NOT reliably reproduce the race on this
    /// machine either way (0 failures observed in 200 repetitions under the
    /// mutation, both sequentially and at 200-way concurrency) — the window
    /// is narrow enough that a raw statistical loop is not a dependable
    /// discriminator, only the direct instrumented reproduction above was.
    /// Kept anyway as a cheap, always-run regression net for the vulnerable
    /// shape (many concurrent callers joining a fast-resolving provider) —
    /// worth having even without a 100%-reliable mutation-kill guarantee,
    /// since a future regression along a slower code path (more registered
    /// waiters, more contention) is plausibly more likely to trip it than
    /// this exact narrow case did.
    func testAFastResolvingProviderNeverLosesADeliveryToARegistrationRace() async throws {
        // Genuinely CONCURRENT, not sequential: launching many holders'
        // first `get(now:)` call at once via `Task { }` (unawaited until
        // the gather loop below) at least gives the cooperative thread pool
        // real reason to migrate `ProviderCall.start(_:)`'s launched `Task`
        // onto a DIFFERENT worker thread than the one running
        // `value(timeout:)`'s check-and-register, which is the shape the
        // window needs — see this test's own doc comment above for why this
        // still is not a reliable discriminator on its own.
        let now = Date()
        let token = jwt(sub: "alice", exp: now.addingTimeInterval(300))
        let tasks = (0..<200).map { _ -> Task<String?, Never> in
            Task {
                let holder = IdentityTokenHolder()
                holder.set(.provider { token })  // purely synchronous — no suspension point at all
                return await holder.get(now: now)
            }
        }
        for task in tasks {
            let got = await task.value
            XCTAssertEqual(got, token, "a fast-resolving provider's result must never be lost to a registration race")
        }
    }

    func testAProviderIsReAskedOnceTheCachedTokenEntersTheMargin() async {
        let now = Date()
        let stale = jwt(sub: "bob", exp: now.addingTimeInterval(300))
        let fresh = jwt(sub: "bob", exp: now.addingTimeInterval(3000))
        let counter = CallCounter()
        let holder = IdentityTokenHolder()
        holder.set(.provider { await counter.bump(); return await counter.value == 1 ? stale : fresh })

        _ = await holder.get(now: now)
        // Jump to 10s before the cached token's expiry — inside the margin.
        let later = now.addingTimeInterval(290)
        let got = await holder.get(now: later)
        XCTAssertEqual(got, fresh)
        let calls = await counter.value
        XCTAssertEqual(calls, 2)
    }

    func testAProviderReturningNilResolvesToAnonymous() async {
        let holder = IdentityTokenHolder()
        holder.set(.provider { nil })
        let got = await holder.get(now: Date())
        XCTAssertNil(got)
    }

    // Independent review, round 14 (codex round 12), Serious 1 — `get()`'s
    // provider branch used to apply IDENTITY_REFRESH_MARGIN to a token the
    // provider had JUST returned, exactly like a cached read. That is wrong:
    // web's `identity-token.ts` `get()` applies the margin only to a cached
    // read and a one-shot string SOURCE, deliberately never to a freshly
    // fetched provider result — see that function's own doc comment. A
    // freshly-fetched token is the newest thing available; there is nothing
    // better to refresh TO, so rejecting it only ever produces an anonymous
    // report. `ttlSeconds` up to 600 is a supported `@everframe/identity`
    // config, and `ttlSeconds: 30` — exactly this holder's own margin — is a
    // short, security-conscious, entirely legal choice; the pre-fix code
    // rejected every such token outright, so `commitIfCurrent` never even
    // ran: nothing was ever cached, and every report shipped anonymous
    // forever. Mutation-verified: reinstating the margin check on the fresh
    // branch makes this fail.
    func testAFreshlyFetchedProviderTokenIsUsedEvenWhenItsOwnRemainingLifeIsInsideTheMargin() async {
        let now = Date()
        let counter = CallCounter()
        let holder = IdentityTokenHolder()
        // 10s of remaining life — deep inside the 30s margin — but this is
        // the FIRST call: no cached token to fall back to, and refusing this
        // one buys nothing (there is no fresher token to be had by waiting).
        let short = jwt(sub: "alice", exp: now.addingTimeInterval(10))
        holder.set(.provider { await counter.bump(); return short })

        let got = await holder.get(now: now)
        XCTAssertEqual(
            got, short,
            "a freshly-fetched provider token must be used even when its own remaining life is inside the refresh margin"
        )
        let sub = await holder.currentSubject(now: now)
        XCTAssertEqual(sub, "alice")
    }

    /// Companion to the test above, at the boundary this fix must NOT touch:
    /// a fresh provider result that is undecodable (no `exp` claim at all)
    /// must still be rejected — the margin removal is scoped to the
    /// expiry-vs-margin COMPARISON only, not the underlying decodability
    /// check `commitIfCurrent`'s caller still performs above it.
    func testAFreshlyFetchedProviderTokenWithNoExpIsStillAbsent() async {
        let now = Date()
        let holder = IdentityTokenHolder()
        holder.set(.provider { self.jwt(sub: "alice", exp: nil) })
        let got = await holder.get(now: now)
        XCTAssertNil(
            got,
            "a fresh provider result with no exp claim must still be rejected — the fix removes the MARGIN comparison only, not the decodability check"
        )
    }

    /// Documents the OTHER end of web's own rule, deliberately: a fresh
    /// provider result already PAST its own `exp` is still used — not
    /// rejected — matching `identity-token.ts`'s own doc comment verbatim
    /// ("a freshly-fetched result is cached and returned as-is even if it
    /// happens to already be inside the margin ... intentional, not a gap").
    /// This function is never the security boundary: an actually-expired
    /// token is simply rejected server-side, same as any other failure path
    /// here — so serving it costs nothing extra over the alternative
    /// (anonymous). A future "harden this" edit that adds an expiry check
    /// here would be REGRESSING native away from web's behaviour, not fixing
    /// anything; this test exists to catch that.
    func testAFreshlyFetchedProviderTokenAlreadyPastItsOwnExpIsStillUsedMatchingWeb() async {
        let now = Date()
        let holder = IdentityTokenHolder()
        let expired = jwt(sub: "alice", exp: now.addingTimeInterval(-1))
        holder.set(.provider { expired })
        let got = await holder.get(now: now)
        XCTAssertEqual(
            got, expired,
            "web's get() never checks a fresh provider result's exp against `now` at all, only decodability — native must match, not add a stricter check web doesn't have"
        )
    }

    // Independent review, round 14 FOLLOW-UP, Serious 1 — the coordinator's
    // re-review: the get()-only fix above was NOT sufficient to close the
    // finding. `Everframe.captureUserSnapshot()` never calls `get(now:)` at
    // all — it stamps `identitySubject` from `cachedSubject(now:)`, a
    // SEPARATE, synchronous read that still applied the SAME margin to a
    // CACHED value. For a token whose own TTL never exceeds that margin, the
    // cached copy can never again clear it after the moment it's minted
    // (remaining life only decreases) — so `get(now:)`'s fix alone moved the
    // blockage one step down the chain (from "never cached" to "cached but
    // never read back") rather than removing it. `resolveIdentityHeader`
    // short-circuits on `capturedSubject == nil` BEFORE it ever calls
    // `get(now:)`, so a 30s-TTL token still produced an anonymous report,
    // exactly the symptom the original finding described.
    func testCachedSubjectAcceptsACachedTokenThatIsMerelyNotYetExpiredEvenInsideTheMargin() {
        let now = Date()
        let holder = IdentityTokenHolder()
        // 10s of remaining life — deep inside the 30s margin, but not
        // expired. The margin decides whether `get(now:)` should RE-ASK the
        // provider for something fresher; `cachedSubject(now:)` has no such
        // option (synchronous, must never invoke the provider), so it must
        // not apply the same bar.
        holder.set(.token(jwt(sub: "alice", exp: now.addingTimeInterval(10))))
        XCTAssertEqual(
            holder.cachedSubject(now: now), "alice",
            "cachedSubject(now:) must stamp a subject from a cached token that is merely not yet expired — " +
                "safe because resolveIdentityHeader never presents THIS token, only compares its subject " +
                "against whatever get() independently and separately resolves at submit time"
        )
    }

    /// The boundary this fix must NOT move: an actually-expired cached
    /// token must still be refused — only the MARGIN moved to "not yet
    /// expired," the underlying expiry check did not disappear.
    func testCachedSubjectStillRefusesAnActuallyExpiredCachedToken() {
        let now = Date()
        let holder = IdentityTokenHolder()
        holder.set(.token(jwt(sub: "alice", exp: now.addingTimeInterval(-1))))
        XCTAssertNil(
            holder.cachedSubject(now: now),
            "an actually-expired cached token must still be refused by cachedSubject(now:)"
        )
    }

    func testAHangingProviderIsBoundedAndDegradesToAnonymous() async {
        let holder = IdentityTokenHolder()
        holder.set(.provider {
            try? await Task.sleep(nanoseconds: 10_000_000_000)  // 10s, far past the 2s bound
            return "never-arrives"
        })
        let started = Date()
        let got = await holder.get(now: Date())
        let elapsed = Date().timeIntervalSince(started)
        XCTAssertNil(got, "recognition is an enhancement, never a blocker")
        XCTAssertLessThan(elapsed, 5.0, "must be bounded by IDENTITY_PROVIDER_TIMEOUT_MS, not by the provider")
    }

    func testCurrentSubjectIsNilWhenNoTokenIsServable() async {
        let now = Date()
        let holder = IdentityTokenHolder()
        holder.set(.token(jwt(sub: "alice", exp: now.addingTimeInterval(-1))))
        let sub = await holder.currentSubject(now: now)
        XCTAssertNil(sub)
    }

    // MARK: - Fix round 1: generation guard (Critical 1)
    //
    // These close the cross-identity leak the review found: `get()`'s
    // provider branch used to write `cached`/`cachedExp` unconditionally
    // after the await, with nothing checking that the source it started
    // under was still installed. A provider call started for one identity
    // must never repopulate the cache once `set()` has moved the holder on
    // to a different (or no) identity while that call was still in flight.

    func testSetNilMidFlightDiscardsTheStaleProviderResultAndCachesNothing() async {
        let now = Date()
        let staleToken = jwt(sub: "alice", exp: now.addingTimeInterval(300))
        let entered = Gate()
        let release = Gate()
        let holder = IdentityTokenHolder()
        holder.set(.provider {
            await entered.open()
            await release.wait()
            return staleToken
        })

        // Kick the provider call off, then wait until it's actually in
        // flight (blocked on `release`) before signing out underneath it.
        let inFlight = Task { await holder.get(now: now) }
        await entered.wait()

        holder.set(nil)   // sign-out while Alice's provider call is pending
        await release.open()   // let Alice's call resolve — too late

        let staleResult = await inFlight.value
        XCTAssertNil(staleResult, "a provider result resolving after set(nil) must be discarded, not served")

        // The discard must be real, not just this one call's return value —
        // nothing should have been left in the cache for a LATER call to
        // serve either.
        let after = await holder.get(now: now)
        XCTAssertNil(after, "set(nil) mid-flight must leave nothing cached for later calls to serve")
    }

    func testSwitchingProvidersMidFlightNeverServesThePreviousOnesToken() async {
        let now = Date()
        let aliceToken = jwt(sub: "alice", exp: now.addingTimeInterval(300))
        let bobToken = jwt(sub: "bob", exp: now.addingTimeInterval(300))
        let entered = Gate()
        let release = Gate()
        let holder = IdentityTokenHolder()
        holder.set(.provider {
            await entered.open()
            await release.wait()
            return aliceToken
        })

        let inFlight = Task { await holder.get(now: now) }
        await entered.wait()

        // Host switches identity while Alice's call is still pending.
        holder.set(.provider { bobToken })
        await release.open()   // let Alice's stale call resolve — too late

        let staleResult = await inFlight.value
        XCTAssertNil(staleResult, "Alice's in-flight call, started before the switch, must never resolve as the answer")

        let current = await holder.get(now: now)
        XCTAssertEqual(current, bobToken, "only the NEW provider may answer — never the stale in-flight one, and never nil forever")
    }

    // MARK: - Fix round 1: real bound on a non-cooperating provider (Critical 2)
    //
    // The bundled `testAHangingProviderIsBoundedAndDegradesToAnonymous` above
    // uses `Task.sleep`, which honors cooperative cancellation — so it kept
    // passing even when `withTimeout` was built on `withTaskGroup`, whose
    // `cancelAll()` is ALSO only cooperative and therefore never actually
    // bounded anything for a provider that doesn't check `Task.isCancelled`.
    // A host's real identity provider is realistically a completion-handler
    // API bridged via `withCheckedContinuation`, which has no cancellation
    // hook at all — this test exercises exactly that shape.
    // MARK: - Native identity Task 4: start()/kill() clear the installed token
    //
    // A token surviving a project switch is the same cross-tenant hazard
    // `_startEpoch` exists to prevent for `_user`: `start(projectA)` ->
    // setIdentityToken(alice) -> `start(projectB)` must not leave project A's
    // user's server-verified credential installed and presentable to project
    // B. These drive the real `Everframe.shared` singleton (mirroring
    // `EnvelopeUserTests`' kill()/start() coverage of `_user`) rather than a
    // bare `IdentityTokenHolder`, because the clearing lives in
    // `Everframe.swift`'s `start()`/`kill()`, not in the holder itself.

    func testKillClearsTheIdentityToken() async {
        let now = Date()
        Everframe.shared.setIdentityToken(.token(jwt(sub: "alice", exp: now.addingTimeInterval(300))))
        Everframe.shared.kill()
        let got = await Everframe.shared._identityHolder.get(now: now)
        XCTAssertNil(got, "a killed Everframe SDK must present nothing")
    }

    /// Independent review, round 10, P1 — proves the WIRING, not just
    /// `IdentityTokenHolder.cancelOutstandingWork()` in isolation
    /// (`testRepeatedCallsJoinTheSameOutstandingProviderCallAndCancelOutstandingWorkCancelsIt`
    /// above already covers the holder's own join/cancel mechanics
    /// exhaustively). `setIdentityToken(.provider)` kicks off an install-time
    /// warm that reaches `_identityHolder`'s own tracked task for the actual
    /// provider call; before this round, that task was an unstructured
    /// `Task { }` `kill()` could never reach at all — a never-resolving
    /// provider left running past `kill()` indefinitely, with no way to stop
    /// it short of process death. Mutation-verified: removing the
    /// `_identityHolder.cancelOutstandingWork()` call from `Everframe.swift`'s
    /// `kill()` makes the bounded poll below time out instead of observing
    /// `cancelledFlag.isOpenNow` flip to `true`.
    func testKillCancelsAnOutstandingProviderCall() async throws {
        let entered = Gate()
        let cancelledFlag = Gate()

        Everframe.shared.__replayConfigOverrideForTesting = ReplayConfig(
            replayEnabled: false, replayDurationSec: 30, samplingRate: 1.0,
            identity: IdentityConfigWire(enabled: true)
        )
        Everframe.shared.setIdentityToken(.provider {
            await entered.open()
            for _ in 0..<200 {  // ~10s, far past the 2s bound; self-terminating if never cancelled
                if Task.isCancelled {
                    await cancelledFlag.open()
                    return nil
                }
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
            return "never-arrives"
        })

        // setIdentityToken's own install-time warm (__warmIdentityToken)
        // kicks the provider call off.
        await entered.wait()

        Everframe.shared.kill()

        let deadline = Date().addingTimeInterval(3)
        while await !cancelledFlag.isOpenNow, Date() < deadline {
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        let cancelledObserved = await cancelledFlag.isOpenNow
        XCTAssertTrue(
            cancelledObserved,
            "kill() must reach and cancel the outstanding provider call through to the holder's own tracked task, not merely abandon it"
        )
    }

    // MARK: - Independent review, round 12, SERIOUS: lock-order inversion (deadlock)
    //
    // Round 11's P1(b) fix gave `IdentityEnabledFlag.set`'s `guard` closure a
    // FRESH epoch check, evaluated while the flag's OWN lock is held — but
    // the closure `ReplaySession` handed it read `Everframe.shared
    // .currentStartEpoch`, which (at the time) acquired `stateLock`.
    // Meanwhile `start()`/`kill()` acquire `stateLock` FIRST and only THEN
    // call into the flag (`_identityEnabledFlag.set(false)`, inside that
    // same critical section) — flag-lock -> stateLock in one thread,
    // stateLock -> flag-lock in another: a textbook AB-BA deadlock, real and
    // permanent (nothing times out or breaks it), reachable any time a
    // background `start()`/`kill()` races the periodic config refresh.
    //
    // Fixed by giving `currentStartEpoch` its own dedicated LEAF lock
    // (`_startEpochMirrorLock`, Everframe.swift) instead of `stateLock` — the
    // guard is still evaluated atomically, at the write, exactly as round
    // 11 required; it simply no longer touches `stateLock` to do it.

    /// Deterministically reproduces the exact lock-acquisition ORDER
    /// `start()`/`kill()` use — `stateLock` first, then a call into the
    /// flag — WITHOUT needing to drive the full `start()`/`kill()`
    /// heavy-init machinery on a real background thread (which would make
    /// the timing needed to actually overlap two live critical sections
    /// unreliable to hit on purpose). `Everframe.__lockStateLockForTesting()`
    /// (new, test-only, mirrors the pre-existing `__setConfigForTesting`
    /// pattern of a same-file `internal` wrapper touching the `private`
    /// `stateLock` directly) lets this test hold `stateLock` itself, on a
    /// controlled thread, standing in for `start()`/`kill()`'s own critical
    /// section — while a SEPARATE real thread drives `_identityEnabledFlag
    /// .set(_:guard:)` with the EXACT closure shape `ReplaySession` uses.
    ///
    /// Sequence: thread R enters the flag's `set` (acquiring the flag's
    /// lock) and parks INSIDE the guard closure, confirmed via a gate. This
    /// test then acquires `stateLock` and starts thread K, which calls the
    /// flag's plain `set(false)` (mirroring `start()`/`kill()`'s own
    /// unconditional call) WHILE this test still holds `stateLock` — thread
    /// K blocks immediately, since thread R holds the flag's lock. Finally,
    /// thread R's guard is released to actually evaluate
    /// `currentStartEpoch`: with the pre-fix code (guard reads
    /// `stateLock`-backed `currentStartEpoch`), thread R now blocks too —
    /// on `stateLock`, held by THIS test — and neither thread can ever
    /// proceed (thread K needs the flag's lock, held by thread R; thread R
    /// needs `stateLock`, held by this test, which will not release it
    /// until thread K's `set(false)` call — which cannot complete — returns.
    /// A genuine, permanent circular wait). With the fix, thread R's guard
    /// never touches `stateLock` at all, so it returns immediately
    /// regardless of what this test holds.
    ///
    /// Mutation-verified: reverting `currentStartEpoch` to acquire
    /// `stateLock` (round 11's shape) makes thread K's completion signal
    /// time out — this test hangs the exact way a real `start()`/`kill()`
    /// racing the periodic refresh would, just bounded by an assertion
    /// instead of hanging the whole test run.
    func testFlagSetGuardNeverDeadlocksAgainstAConcurrentStateLockHolderCallingIntoTheFlag() throws {
        let guardEntered = DispatchSemaphore(value: 0)
        let releaseGuard = DispatchSemaphore(value: 0)
        let epochAtCapture = Everframe.shared.currentStartEpoch

        // Thread R — mirrors `ReplaySession.refreshConfigNow()`'s call:
        // `_identityEnabledFlag.set(newValue, guard: { ... currentStartEpoch
        // ... })`. Parks INSIDE the guard, deliberately, so this test
        // controls exactly when the (potentially stateLock-touching) epoch
        // read actually happens.
        let threadR = Thread {
            Everframe.shared._identityEnabledFlag.set(true) {
                guardEntered.signal()
                releaseGuard.wait()
                return Everframe.shared.currentStartEpoch == epochAtCapture
            }
        }
        threadR.start()

        guard guardEntered.wait(timeout: .now() + 5) == .success else {
            XCTFail("fixture sanity: thread R never entered the guard closure — not exercising the race")
            return
        }
        // Thread R now holds the flag's OWN lock (set() acquires it before
        // calling guard()) and is parked, by construction, inside the guard.

        // This test's own thread now stands in for `start()`/`kill()`:
        // acquire `stateLock` FIRST, exactly like those functions do.
        Everframe.__lockStateLockForTesting()
        defer { Everframe.__unlockStateLockForTesting() }

        // Thread K — mirrors `start()`/`kill()`'s own unconditional
        // `_identityEnabledFlag.set(false)` call, made from INSIDE their
        // `stateLock` critical section (this test's thread holds it, from
        // the line above). Real background thread so this test can observe
        // whether it completes, rather than blocking its own execution.
        let threadKDone = DispatchSemaphore(value: 0)
        let threadK = Thread {
            Everframe.shared._identityEnabledFlag.set(false)
            threadKDone.signal()
        }
        threadK.start()

        // Give thread K a moment to actually reach and block on the flag's
        // lock (held by thread R) — not load-bearing for correctness, only
        // for making the intended interleaving likely on the first try;
        // the assertion below is a bounded timeout either way, not a race.
        Thread.sleep(forTimeInterval: 0.2)

        // Release thread R's guard now. Pre-fix, this is the moment the
        // deadlock actually forms: thread R's guard tries to acquire
        // `stateLock` (held by THIS test's thread), so thread R blocks —
        // while thread K remains blocked on the flag's lock (held by thread
        // R). Neither can ever unblock the other. Deliberately NOT
        // unlocking `stateLock` before checking the result below — doing so
        // would let the pre-fix code "resolve" the deadlock artificially
        // instead of actually reproducing it; the bounded `wait(timeout:)`
        // below is what turns a genuine hang into a clean test failure
        // instead of hanging the whole run.
        releaseGuard.signal()

        let result = threadKDone.wait(timeout: .now() + 3)
        XCTAssertEqual(
            result, .success,
            "IdentityEnabledFlag.set's guard closure deadlocked against a concurrent stateLock holder calling " +
                "into the flag — the flag's lock is no longer a leaf with respect to stateLock"
        )
    }

    /// The sibling of the `kill()` case above, and the more dangerous one:
    /// `start()` installs a NEW `_config` (the Everframe SDK key / destination project)
    /// without clearing a previously-installed identity source, so
    /// `start(projectA) -> setIdentityToken(alice) -> start(projectB)` would
    /// let project B's reports present project A's user's verified
    /// credential — a falsely-verified identity in a DIFFERENT customer's
    /// project, worse than the analogous `_user` leak `start()` already
    /// closes because a server actually trusts this one's signature.
    func testStartClearsTheIdentityToken() async throws {
        let now = Date()
        let projectA = EverframeConfig(
            appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU",
            capture: CaptureConfig(logs: false)
        )
        let projectB = EverframeConfig(
            appId: "txx_live_9wPQrSt2UvWxYz3AbCdEfGh4IjKlMn5O",
            capture: CaptureConfig(logs: false)
        )
        try Everframe.shared.start(config: projectA)
        Everframe.shared.setIdentityToken(.token(jwt(sub: "alice", exp: now.addingTimeInterval(300))))

        // Reconfigure onto a DIFFERENT project — no setIdentityToken call in
        // the new session anywhere.
        try Everframe.shared.start(config: projectB)

        let got = await Everframe.shared._identityHolder.get(now: now)
        XCTAssertNil(got, "a freshly-started session must never carry over a previous project's identity token")
    }

    func testAHangingCallbackBasedProviderIsBoundedAndDegradesToAnonymous() async {
        let holder = IdentityTokenHolder()
        holder.set(.provider {
            await withCheckedContinuation { (continuation: CheckedContinuation<String?, Never>) in
                // Fires on a background queue, far past the provider bound,
                // and never observes Task cancellation — nothing here can be
                // told to stop early.
                DispatchQueue.global().asyncAfter(deadline: .now() + 10) {
                    continuation.resume(returning: "never-arrives")
                }
            }
        })
        let started = Date()
        let got = await holder.get(now: Date())
        let elapsed = Date().timeIntervalSince(started)
        XCTAssertNil(got, "recognition is an enhancement, never a blocker")
        XCTAssertLessThan(elapsed, 4.0, "must be bounded by IDENTITY_PROVIDER_TIMEOUT (2s), not by a provider that ignores cancellation")
    }

    // MARK: - Independent review, round 10, P1: single-flight + cancellable
    // scope (the escalated twin of Task 5's deferred Minor). Each timeout
    // used to abandon the provider's unstructured `Task { }` outright, and
    // every subsequent `get()`/reporter-open warm started ANOTHER one —
    // unbounded, indefinitely, since reporter-open warms repeat (not
    // one-shot) — with no way for `kill()` to reach any of them. Two
    // properties close that: (1) a provider call already in flight for the
    // CURRENT generation is joined, not duplicated, bounding outstanding
    // work to one per holder; (2) that call is now tracked as a cancellable
    // `Task`, so `cancelOutstandingWork()` (wired into `Everframe.kill()`,
    // see `testKillCancelsAnOutstandingProviderCall` below) can actually
    // reach it.
    //
    // Mutation-verified: reverting `providerTask(_:generation:)` to
    // unconditionally launch a fresh `Task` (dropping the
    // generation/`inFlightTask` join check) makes the invocation-count
    // assertion below fail (the counter climbs past 1 instead of staying
    // there); reverting `cancelOutstandingWork()` to a no-op body makes the
    // bounded poll for `cancelledFlag.isOpenNow` below time out instead of
    // observing it flip to `true`.
    func testRepeatedCallsJoinTheSameOutstandingProviderCallAndCancelOutstandingWorkCancelsIt() async throws {
        let now = Date()
        let counter = CallCounter()
        let entered = Gate()
        let cancelledFlag = Gate()
        let holder = IdentityTokenHolder()
        holder.set(.provider {
            await counter.bump()
            await entered.open()
            // Cooperative polling loop, NOT `Task.sleep` wrapped in `try?`
            // alone — `.provider`'s closure type is non-throwing (see
            // `testProviderClosureTypeStaysNonThrowingByConstruction`), so a
            // thrown `CancellationError` can never propagate out of `fn()`;
            // this is what lets the closure itself OBSERVE cancellation and
            // report it, the way the test needs to prove
            // `cancelOutstandingWork()` actually delivered the signal rather
            // than merely abandoning the task. Bounded at 200 * 50ms = 10s —
            // far past the 2s bound, but self-terminating if never cancelled.
            for _ in 0..<200 {
                if Task.isCancelled {
                    await cancelledFlag.open()
                    return nil
                }
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
            return "never-arrives"
        })

        // Install, then several "reporter-open" style warms — all started
        // before the first has any chance to resolve (each individually
        // bounded at ~2s by the round-1 fix, so plenty of overlap window).
        let calls = (0..<4).map { _ in Task { await holder.get(now: now) } }
        await entered.wait()

        let countAfterEntry = await counter.value
        XCTAssertEqual(
            countAfterEntry, 1,
            "at most one outstanding provider call per holder, regardless of how many callers ask"
        )

        var results: [String?] = []
        for call in calls { results.append(await call.value) }
        XCTAssertTrue(results.allSatisfy { $0 == nil }, "every joined caller still degrades to anonymous, none blocks past its own bound")

        // The provider is still running, orphaned, past every caller's own
        // 2s bound — proves those callers' timeouts don't themselves cancel
        // the shared task (round-1 behaviour, unchanged).
        let notYetCancelled = await cancelledFlag.isOpenNow
        XCTAssertFalse(notYetCancelled, "provider must still be uncancelled at this point")

        // The kill-switch path: cancels the outstanding call directly.
        holder.cancelOutstandingWork()
        let deadline = Date().addingTimeInterval(2)
        while await !cancelledFlag.isOpenNow, Date() < deadline {
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        let cancelledObserved = await cancelledFlag.isOpenNow
        XCTAssertTrue(cancelledObserved, "cancelOutstandingWork() must actually cancel the outstanding provider task")

        // A later, independent call must not be permanently blocked by the
        // now-cancelled call — it launches its own fresh one.
        let afterCancel = await holder.get(now: now)
        XCTAssertNil(afterCancel)
        let finalCount = await counter.value
        XCTAssertEqual(finalCount, 2, "a call after cancelOutstandingWork() must be free to launch a fresh provider call")
    }

    // MARK: - Independent review, round 11, P1(a) — round 10's fix was
    // incomplete on Swift specifically. It bounded INVOCATIONS (one provider
    // call per generation) but not WAITERS: `get(now:)` raced a shared
    // `Task<String?, Never>`'s `.value` inside `withTimeout`'s own bridging
    // `Task { }`, and `Task.value` cannot be interrupted from the awaiting
    // side — Swift's cooperative cancellation does not propagate through
    // `await someTask.value` at all. A caller whose own 2s timer won the
    // race left that bridging `Task` permanently suspended whenever the
    // underlying provider never completed, so every reporter-open warm
    // joining the same single-flighted call still left behind ANOTHER
    // immortal waiter — the identical unbounded-accumulation defect round
    // 10 was meant to close, one layer up. Separately: `cancelOutstandingWork()`
    // only ever reached the SINGLE most-recently-launched call — a `set()`
    // superseding the source while an older generation's call was still
    // running overwrote that one handle, leaving the older call permanently
    // unreachable by `kill()`.
    //
    // The fix (`ProviderCall`, replacing the raw `Task` + module-level
    // `withTimeout`) closes both: every caller registers a plain callback
    // and races it against its OWN bounded timer `Task` (never a `Task`
    // suspended on anything unbounded), and `outstandingCalls` tracks EVERY
    // not-yet-finished call across every generation, not just the current
    // one — see `ProviderCall`'s and `outstandingCalls`' own doc comments
    // in IdentityTokenHolder.swift for the full mechanism.

    /// The second half of the finding, directly reproduced: two never-
    /// resolving, cancellation-observing providers installed back to back
    /// (the second SUPERSEDES the first as "current" for joins, but the
    /// first's call keeps running orphaned underneath it — the pre-existing,
    /// unchanged "orphaned but off the critical path" behaviour already
    /// proven by `testSwitchingProvidersMidFlightNeverServesThePreviousOnesToken`
    /// et al.). A SINGLE `cancelOutstandingWork()` call must reach BOTH.
    ///
    /// Mutation-verified: reverting `cancelOutstandingWork()` to cancel only
    /// `currentCall` (round 10's shape, dropping the `outstandingCalls`
    /// iteration) makes the FIRST generation's `cancelled` assertion below
    /// time out — the exact defect this round closes — while the SECOND
    /// generation's still passes, confirming the test isolates the right
    /// half rather than just re-proving round 10.
    func testCancelOutstandingWorkCancelsEveryOutstandingCallNotOnlyTheCurrentGeneration() async throws {
        let now = Date()
        let holder = IdentityTokenHolder()

        let firstEntered = Gate()
        let firstCancelled = Gate()
        holder.set(.provider {
            await firstEntered.open()
            for _ in 0..<200 {  // ~10s ceiling, far past the 2s bound; self-terminating if never cancelled
                if Task.isCancelled {
                    await firstCancelled.open()
                    return nil
                }
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
            return "never-arrives"
        })
        let firstCall = Task { await holder.get(now: now) }
        await firstEntered.wait()

        // Supersede: the SECOND provider becomes "current" for joins, but
        // the FIRST's call keeps running orphaned underneath it.
        let secondEntered = Gate()
        let secondCancelled = Gate()
        holder.set(.provider {
            await secondEntered.open()
            for _ in 0..<200 {
                if Task.isCancelled {
                    await secondCancelled.open()
                    return nil
                }
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
            return "never-arrives"
        })
        let secondCall = Task { await holder.get(now: now) }
        await secondEntered.wait()

        // ONE cancellation call must reach BOTH outstanding providers.
        holder.cancelOutstandingWork()

        let deadline = Date().addingTimeInterval(3)
        while Date() < deadline {
            let firstDone = await firstCancelled.isOpenNow
            let secondDone = await secondCancelled.isOpenNow
            if firstDone && secondDone { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        let firstWasCancelled = await firstCancelled.isOpenNow
        let secondWasCancelled = await secondCancelled.isOpenNow
        XCTAssertTrue(
            firstWasCancelled,
            "cancelOutstandingWork() must reach a SUPERSEDED generation's call too, not only the current one"
        )
        XCTAssertTrue(secondWasCancelled, "fixture sanity: the current generation's call must also be cancelled")

        _ = await firstCall.value
        _ = await secondCall.value
    }

    /// "Repeated warms must not grow outstanding work" — asserted directly
    /// via `IdentityTokenHolder.__outstandingWaiterCountForTesting()`
    /// (test-only; Swift's `Task` type offers no portable way to count live,
    /// suspended tasks from outside, so the holder exposes the one piece of
    /// its OWN bookkeeping that stands in for it). Many overlapping join
    /// rounds against a SINGLE never-resolving provider must each leave
    /// EXACTLY ZERO waiters registered once every caller in that round has
    /// either been delivered a result or given up via its own timer — the
    /// pre-fix `Task { await task.value }` bridging shape had no equivalent
    /// self-cleaning: a caller giving up locally left its bridging `Task`
    /// registered on `task.value` forever, invisible to any counter,
    /// growing by one per warm.
    ///
    /// Mutation-verified: reverting `removeWaiter(_:)` to a no-op (so a
    /// timed-out caller's registration is never cleaned up) makes the
    /// per-round waiter-count assertion below fail on the very first round.
    func testRepeatedWarmsAgainstANeverResolvingProviderRemainBoundedAcrossManyRounds() async throws {
        let now = Date()
        let counter = CallCounter()
        let cancelledFlag = Gate()
        let holder = IdentityTokenHolder()
        holder.set(.provider {
            await counter.bump()
            for _ in 0..<400 {  // ~20s ceiling, far past any round's own bound
                if Task.isCancelled {
                    await cancelledFlag.open()
                    return nil
                }
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
            return "never-arrives"
        })

        var maxElapsed: TimeInterval = 0
        for round in 0..<5 {
            let started = Date()
            let calls = (0..<8).map { _ in Task { await holder.get(now: now) } }
            var results: [String?] = []
            for call in calls { results.append(await call.value) }
            maxElapsed = max(maxElapsed, Date().timeIntervalSince(started))
            XCTAssertTrue(
                results.allSatisfy { $0 == nil },
                "every joined caller in every round must still degrade to anonymous"
            )
            XCTAssertEqual(
                holder.__outstandingWaiterCountForTesting(), 0,
                "round \(round): every caller in this round has already resolved (via delivery or its own " +
                    "timeout) — nothing should still be registered"
            )
        }

        let invocations = await counter.value
        XCTAssertEqual(invocations, 1, "single-flight must hold across many overlapping rounds, not just the first")
        XCTAssertLessThan(
            maxElapsed, 4.0,
            "no round should take measurably longer than a single call's own ~2s bound — growth here would " +
                "indicate accumulated outstanding work degrading later rounds"
        )

        // The mechanism must still work correctly after many overlapping
        // rounds — not wedged or corrupted by the prior load.
        holder.cancelOutstandingWork()
        let deadline = Date().addingTimeInterval(2)
        while await !cancelledFlag.isOpenNow, Date() < deadline {
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        let cancelledObserved = await cancelledFlag.isOpenNow
        XCTAssertTrue(cancelledObserved, "cancelOutstandingWork() must still reach the provider after many overlapping rounds")
    }

    // MARK: - Independent review, round 3 (Serious 2): provider throw/cancel hazard

    /// Kotlin's `IdentityTokenHolder.get()` had to rethrow any
    /// `CancellationException` surfacing from `provider.fn()` unconditionally
    /// distinguishing "our own coroutine was really cancelled" from "the
    /// host's provider threw a CancellationException for its own unrelated
    /// reasons (e.g. an internal `withTimeout`)" — because Kotlin has no
    /// non-throwing function-type modifier, so a `suspend () -> String?`
    /// CAN throw literally anything, cancellation included. This file's own
    /// header comment on `invokeSafely` (the Kotlin twin) says as much.
    ///
    /// Swift closes this the same class of hole a different way: `.provider`'s
    /// associated closure is declared `@Sendable () async -> String?` — no
    /// `throws`. That is enforced by the COMPILER, not by any runtime
    /// catch/rethrow logic in this file: a provider closure cannot propagate
    /// ANY thrown error, `CancellationError` included, out of `fn()` — any
    /// internal `try` inside a host's provider body must be handled locally
    /// (`try?`/`do`-`catch`) or the closure simply does not compile as a
    /// `.provider` argument. `get(now:)`, `resolveIdentityHeader`, and
    /// `ReportSubmitter.submit` are themselves all non-throwing/never
    /// propagate an error from this path either, so there is no way — by
    /// construction — for a misbehaving provider to turn into a cancelled
    /// submit path and drop a report on this platform. `withTimeout` (this
    /// file's own timeout racer) does not add its own version of the hazard
    /// either: it races two UNSTRUCTURED, un-cancelled `Task { }`s and never
    /// calls `.cancel()` on the loser — see the extensive doc comment above
    /// `withTimeout` — so a provider's own internal work is never even
    /// subjected to Swift's native cancellation from this holder.
    ///
    /// This test pins the ONE fact that actually makes the guarantee hold:
    /// the closure type has no `throws`. A future change that added one (say,
    /// "to let providers report a real error") would silently reopen the
    /// exact hazard round 3 found on Android — this fails loudly instead, as
    /// a source gate rather than a runtime behavioural test, because there is
    /// no way to even CONSTRUCT a throwing `.provider` value to test
    /// behaviourally without the type already having regressed.
    func testProviderClosureTypeStaysNonThrowingByConstruction() throws {
        let thisFile = URL(fileURLWithPath: #filePath)
        // …/Tests/EverframeTests/IdentityTokenHolderTests.swift → up 3 → package root.
        let packageRoot = thisFile
            .deletingLastPathComponent()   // EverframeTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // package root
        let source = try String(
            contentsOf: packageRoot.appendingPathComponent(
                "Sources/Everframe/Identity/IdentityTokenHolder.swift"),
            encoding: .utf8
        )
        XCTAssertNotNil(
            source.range(of: "case provider(@Sendable () async -> String?)"),
            """
            IdentityTokenSource.provider's closure type no longer matches the exact non-throwing \
            signature this test pins. If it gained `throws`, a host provider could once again \
            propagate a CancellationError (or any error) out of fn() and into get()/ \
            resolveIdentityHeader()/the submit path — the exact Serious-2 hazard independent \
            review round 3 found and fixed on Android (IdentityTokenHolder.kt's invokeSafely). \
            Swift closed it by construction instead of a runtime catch; keep it that way, or add \
            an equivalent runtime guard AND update this gate deliberately.
            """
        )
    }
}

/// Actor so the provider closures above can count invocations without a data race.
actor CallCounter {
    private(set) var value = 0
    func bump() { value += 1 }
}

/// A one-shot open/wait gate used to force a deterministic interleaving
/// between a test and a provider closure running concurrently: the provider
/// signals it has been ENTERED (so the test knows it's safely blocked) and
/// then waits to be RELEASED, letting the test perform a `set()` in between
/// with no race on when it lands relative to the provider call being in
/// flight.
actor Gate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func open() {
        isOpen = true
        let toResume = waiters
        waiters = []
        for w in toResume { w.resume() }
    }

    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            waiters.append(c)
        }
    }

    /// Non-blocking read (independent review, round 10, P1) — lets a test
    /// assert "not yet opened" without racing `wait()`'s own suspension.
    var isOpenNow: Bool { isOpen }
}
