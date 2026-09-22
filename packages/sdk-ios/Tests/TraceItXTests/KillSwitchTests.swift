// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// DEFE-03 emergency kill switch tests. The captureGate flag is read by the
// capture pipeline (wired in 04-03); this plan owns the flag itself.
import Testing
import Foundation
import TraceItXProtocol
@testable import TraceItXKit

@Suite(.serialized)
struct KillSwitchTests {
    /// Every `start()` in this suite MUST disable log capture.
    ///
    /// `TraceItX.start(config:)` schedules `LogCapture.install()` on an
    /// un-awaited `Task` whenever `config.capture.logs` is true (the default),
    /// and `StderrIntercept` then dup2's STDERR_FILENO **for the whole test
    /// process** and dual-writes every captured line — including the
    /// swift-testing runner's own "✔ Test … passed" diagnostics — into
    /// `BreadcrumbRingBuffer.shared` as `.console` crumbs, from a libdispatch
    /// readability handler on an arbitrary thread at an arbitrary time.
    ///
    /// Two cases in this suite used to start with the default capture config,
    /// which installed exactly that intercept and made
    /// `killZeroizesBreadcrumbBufferIncludingFrozenSnapshot` below flaky (~10%
    /// on its own, more under load): the handler could append a `.console`
    /// crumb between `kill()`'s `BreadcrumbRingBuffer.clear()` and its
    /// `size == 0` assertion, since `add()` samples `captureGate` before doing
    /// its (comparatively slow) redaction work and only appends afterwards.
    /// Disabling log capture is the same isolation `BreadcrumbRingBufferTests`
    /// and `BreadcrumbAdaptersTests` already apply for the same reason — and it
    /// also stops this suite leaking a process-global stderr intercept into
    /// every suite that runs after it.
    private static func config(
        appId: String = "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU",
        environment: TraceItXConfig.Environment = .production
    ) -> TraceItXConfig {
        TraceItXConfig(
            appId: appId, environment: environment, capture: CaptureConfig(logs: false))
    }

    @Test func killDisablesCaptureGate() throws {
        let config = Self.config(environment: .development)
        try TraceItX.shared.start(config: config)
        #expect(TraceItX.shared.captureGate == true)
        TraceItX.shared.kill()
        #expect(TraceItX.shared.captureGate == false)
    }

    @Test func killIsIdempotent() {
        TraceItX.shared.kill()
        TraceItX.shared.kill()  // must not error
        #expect(TraceItX.shared.captureGate == false)
    }

    @Test func startAfterKillReenablesCapture() throws {
        let config = Self.config(environment: .development)
        TraceItX.shared.kill()
        try TraceItX.shared.start(config: config)
        #expect(TraceItX.shared.captureGate == true)
    }

    /// Final-review fix: cross-SDK posture parity with web (sdk-core
    /// client.ts kill() calls state.breadcrumbs.clear()). Pre-kill live
    /// entries AND a frozen snapshot (the reporter-open freeze) must both be
    /// zeroized by kill() — otherwise a submit on an already-frozen report
    /// could still ship crumbs captured before the kill (GDPR erasure /
    /// DEFE-03 posture). `capture.logs: false` (now via `Self.config()`, for
    /// every case in this suite — see its doc comment) keeps StderrIntercept
    /// off so it can't race a stray `.console` crumb into this exact-count
    /// assertion (same isolation BreadcrumbRingBufferTests uses).
    ///
    /// That alone is necessary but not sufficient, because the intercept is
    /// process-global: any OTHER suite's `start()` — or `LogRingBufferTests`'
    /// direct `LogCapture.install()` — can arm it, including from an
    /// un-awaited `Task` that lands mid-test. So the buffer is additionally
    /// pinned to exactly the kind this test writes (`.tap`) for the duration.
    /// `BreadcrumbRingBuffer.add` re-checks BOTH the kill gate and the live
    /// kind set *inside the same `NSLock` that `clear()` takes*. The gate
    /// re-check closes the race this comment used to describe as open: a
    /// `.console` crumb sampling `captureGate`, spending comparatively long in
    /// `RedactionEngine`, and appending into a buffer `kill()` had already
    /// zeroized (see `killGateRaceDoesNotAppendAfterConcurrentClear`). The
    /// kind pinning below is kept regardless — it independently rejects
    /// `.console` crumbs armed by ANY other suite's process-global stderr
    /// intercept, including ones that arrive while the gate is legitimately
    /// open. Both are a total order, not a timing hope.
    @Test func killZeroizesBreadcrumbBufferIncludingFrozenSnapshot() throws {
        BreadcrumbRingBuffer.shared.applyConfig(
            BreadcrumbsConfigWire(
                enabled: true,
                kinds: [BreadcrumbKind.tap.rawValue],
                maxCount: BreadcrumbRingBuffer.defaultMaxCount,
                byteBudget: 16384,
                consoleEntryCap: 1024
            )
        )
        BreadcrumbRingBuffer.shared.clear()
        let config = Self.config()
        try TraceItX.shared.start(config: config)

        BreadcrumbRingBuffer.shared.add(kind: .tap, message: "pre-kill-live")
        BreadcrumbRingBuffer.shared.freeze()
        BreadcrumbRingBuffer.shared.add(kind: .tap, message: "pre-kill-after-freeze")

        TraceItX.shared.kill()

        #expect(BreadcrumbRingBuffer.shared.size == 0)
        #expect(BreadcrumbRingBuffer.shared.takeFrozen() == nil)

        // Restore shared-singleton hygiene for the rest of the suite: the
        // buffer's live config goes back to the boot-time defaults (all kinds
        // enabled) that other suites assume, and the chain is re-zeroized.
        try TraceItX.shared.start(config: config)
        BreadcrumbRingBuffer.shared.applyConfig(nil)
        BreadcrumbRingBuffer.shared.clear()
    }

    /// Regression for the breadcrumb half of the kill-gate/append race that
    /// `NetworkRingBuffer` (F15) and `NetworkBodyRingBuffer` already close:
    ///   1. add() reads `captureGate == true` (the cheap pre-lock fast path)
    ///   2. kill() flips the gate false, then clear()s the buffer
    ///   3. add() finally acquires the lock and appends — after zeroization
    /// `preLockHook` pauses `add` right after step 1's read so this test can
    /// force `TraceItX.shared.kill()` to run to completion before releasing
    /// `add` into the lock. Uses `BreadcrumbRingBuffer.shared` (not a fresh
    /// instance) so `kill()`'s real production `clear()` targets the same
    /// buffer `add` is racing into.
    @Test func killGateRaceDoesNotAppendAfterConcurrentClear() async throws {
        try await withGlobalCaptureStateLock {
            let buf = BreadcrumbRingBuffer.shared
            let config = Self.config()
            try TraceItX.shared.start(config: config)
            buf.clear()

            let reachedPreLock = DispatchSemaphore(value: 0)
            let releaseAdd = DispatchSemaphore(value: 0)
            buf.preLockHook = {
                reachedPreLock.signal()
                releaseAdd.wait()
            }

            let addDone = DispatchSemaphore(value: 0)
            DispatchQueue.global().async {
                buf.add(kind: .tap, message: "raced-past-the-gate")
                addDone.signal()
            }

            reachedPreLock.wait()
            // kill() flips captureGate false, THEN clears `buf` — same order
            // as production (TraceItX.swift's kill()).
            TraceItX.shared.kill()
            releaseAdd.signal()
            addDone.wait()

            #expect(buf.size == 0)

            buf.preLockHook = nil
            try TraceItX.shared.start(config: config)
            BreadcrumbRingBuffer.shared.applyConfig(nil)
            buf.clear()
        }
    }

    /// Fix round 3 residual hygiene. Unlike every other piece of session
    /// state, `__replayConfigOverrideForTesting` was not cleared by `kill()`
    /// — a value left set (a forgotten test cleanup, or any future misuse)
    /// would silently override the fail-closed `.off` default for EVERY
    /// submit path across a `kill()`/re-`start()` cycle, since
    /// `currentReplayConfig()` checks it unconditionally, first.
    /// Mutation-verified: removing the clear line in `kill()` makes this
    /// fail.
    @Test func killClearsTheReplayConfigTestOverride() throws {
        let config = Self.config()
        try TraceItX.shared.start(config: config)
        TraceItX.shared.__replayConfigOverrideForTesting = ReplayConfig(
            replayEnabled: true, replayDurationSec: 30, samplingRate: 1.0,
            identity: IdentityConfigWire(enabled: true))
        #expect(TraceItX.shared.__replayConfigOverrideForTesting != nil)

        TraceItX.shared.kill()

        #expect(TraceItX.shared.__replayConfigOverrideForTesting == nil)
    }

    /// `killGeneration` is what separates "a start() ran" from "a kill() ran"
    /// when both have already moved `_startEpoch`. `start()` must NOT move it,
    /// or a legitimate project switch would discard a crash that belongs to
    /// the project it was captured under.
    @Test func startDoesNotBumpKillGeneration() throws {
        try TraceItX.shared.start(config: Self.config(appId: "txx_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))
        let before = TraceItX.shared.captureSessionSnapshot().killGeneration
        try TraceItX.shared.start(config: Self.config(appId: "txx_live_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"))
        #expect(
            !TraceItX.killGenerationChanged(since: before),
            "start() must not look like a revocation — the crash still belongs to the project it was captured under"
        )
    }

    @Test func killBumpsKillGeneration() throws {
        try TraceItX.shared.start(config: Self.config(appId: "txx_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))
        let before = TraceItX.shared.captureSessionSnapshot().killGeneration
        TraceItX.shared.kill()
        #expect(TraceItX.killGenerationChanged(since: before))
    }

    /// THE CASE A BOOLEAN GATE CANNOT EXPRESS. `kill()` closes `captureGate`
    /// and `start()` re-opens it, so a gate check would see "open" here and
    /// ship a crash whose capture was revoked. Monotonicity is the whole point.
    @Test func killThenStartStillReadsAsRevoked() throws {
        try TraceItX.shared.start(config: Self.config(appId: "txx_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))
        let before = TraceItX.shared.captureSessionSnapshot().killGeneration
        TraceItX.shared.kill()
        try TraceItX.shared.start(config: Self.config(appId: "txx_live_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"))
        #expect(TraceItX.shared.captureGate, "precondition: start() re-opened the gate")
        #expect(
            TraceItX.killGenerationChanged(since: before),
            "a later start() must not resurrect a revoked capture"
        )
    }

    /// The snapshot's three fields must come from ONE critical section: two
    /// reads could straddle a start() and pair A's user with B's config, which
    /// is worse than either read alone.
    @Test func snapshotPairsUserWithTheConfigOfTheSameSession() throws {
        try TraceItX.shared.start(config: Self.config(appId: "txx_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))
        TraceItX.shared.setUser(TXUser(id: "u_1", email: nil, displayName: nil))
        let snap = TraceItX.shared.captureSessionSnapshot()
        #expect(snap.user.user?.id == "u_1")
        #expect(snap.config?.appId == "txx_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        #expect(snap.user.startEpoch == TraceItX.shared.currentStartEpoch)
    }

    /// Follow-ups item 9 — the submit boundaries need this check from
    /// `TraceItXReporterUI`, a different target from the one declaring
    /// `killGenerationChanged` (`internal`, invisible there). Exposed as a
    /// member on the snapshot; this pins the semantics, including the one a
    /// boolean gate cannot express.
    @Test func aSessionSnapshotReportsRevokedOnlyAfterAKill() throws {
        try TraceItX.shared.start(config: Self.config())
        let captured = TraceItX.shared.captureSessionSnapshot()
        #expect(!captured.isRevoked, "a live session must not report itself revoked")

        TraceItX.shared.kill()
        #expect(captured.isRevoked, "a snapshot taken before kill() must report revoked after it")

        // start() re-opens `captureGate`, so a boolean gate check would report
        // "fine" here — only a monotonic counter survives a restart.
        try TraceItX.shared.start(config: Self.config(appId: "txx_live_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"))
        #expect(captured.isRevoked, "a restart must not un-revoke a snapshot")
        TraceItX.shared.kill()
    }
}
