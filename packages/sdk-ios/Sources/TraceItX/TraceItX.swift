// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Public singleton entry point for the TraceItX iOS SDK.
//
// File-ownership timeline:
//   • 04-01 — skeleton (lock state, ReportAPI placeholder)
//   • 04-02 — start()/kill()/setUser/setMetadata bodies + captureGate
//   • 04-06 — atomic Wave-4 integration of 04-03/04/05 subsystems via standalone
//             module APIs (this file). Per the B2-residual fix, plan 04-06 is
//             the SINGLE Wave-4 writer to TraceItX.swift; plans 04-03/04/05 do
//             not modify this file. They ship their subsystems as standalone
//             modules (SensitiveRectRegistry.mark, LogCapture.install/uninstall,
//             ReportSubmitter + drainOutbox) and 04-06 wires them here.
//
// Design contract (RESEARCH Finding 14 + Pitfall 5):
//   • start() is synchronous and returns in <5ms
//   • Heavy work (outbox hydrate, log capture install, overlay window install)
//     runs on `Task.detached(priority: .utility)`
//   • State mutations are NSLock-protected — fast, lock-free reads aren't
//     worth the actor-isolation cost given start() is called once per launch
//
// Sendable note: This class uses `@unchecked Sendable` because we manage
// concurrent access via NSLock rather than the strict-concurrency model.
// Switching to an actor would make start()/kill() async (every host caller
// needs to await), which violates the synchronous-API contract.
import Foundation
import Combine
import TraceItXProtocol
#if canImport(UIKit)
import UIKit
#endif

public final class TraceItX: @unchecked Sendable {
    public static let shared = TraceItX()

    /// Semver of the iOS SDK, embedded into every envelope's `reporter.version`.
    /// Sourced from `TraceItX.podspec`'s `spec.version` via the auto-generated
    /// `Generated/SDKVersion.swift` (refreshed by `scripts/sync-version.sh`).
    /// Single source of truth: edit the podspec, run the sync script — no
    /// other source files need to change at release time.
    public static let SDK_VERSION = TraceItXSDKVersion
    private init() {}

    // MARK: - State (NSLock-protected)

    private let stateLock = NSLock()
    private var _config: TraceItXConfig?
    /// Bumped in the SAME `stateLock` section that assigns `_config`, so
    /// "this generation" and "this config" can never be observed apart.
    ///
    /// Follow-ups item 9, fourth round (external review 2026-08-13, codex).
    /// `_startEpoch` cannot serve this purpose on iOS: `start()` bumps it in
    /// its FIRST critical section and installs `_config` in a SECOND one, with
    /// the buffer resets in between (that ordering is F39's, and merging the
    /// two would hold `stateLock` across `NetworkBodyCaptureGate.reset()` — an
    /// AB-BA deadlock hazard against a concurrent `applyConfig`). A snapshot
    /// landing between them pairs the NEW epoch with the OLD config, which
    /// `TXCapturedSession`'s header documents as harmless for the crash path
    /// and which is NOT harmless for `isSuperseded`: the epoch matches once
    /// `start()` finishes, so it would certify as current a session whose
    /// config is stale, and the submit paths would then accept the NEW
    /// session's buffers while routing by the OLD session's key.
    ///
    /// Android needs no equivalent — its `start()` writes `_config`,
    /// `captureGate` and `_startEpoch` in one `stateLock.withLock` block, so
    /// the mixed state cannot arise there at all. That divergence is recorded
    /// on `TXCapturedSession.isSuperseded` on both platforms.
    private var _configGeneration: UInt64 = 0
    private var _user: TXUser?
    private var _metadata: [String: Any] = [:]

    /// Holds the verified-identity token (recognition spec 2026-08-06),
    /// in-memory only. Its own type (`Identity/IdentityTokenHolder.swift`)
    /// rather than a raw string here, because it also owns the decode/expiry/
    /// generation logic — see that file's header. `captureUserSnapshot()`
    /// below reads its SYNCHRONOUS `cachedSubject(now:)`, never the `async
    /// get(now:)`, because a capture boundary must not block on a provider.
    ///
    /// `internal`, not `private` — `@testable import TraceItXKit` needs to
    /// reach it directly (see `IdentityTokenHolderTests`'
    /// `testKillClearsTheIdentityToken` / `testStartClearsTheIdentityToken`),
    /// the same seam shape as `currentStartEpoch` above. `start()` and
    /// `kill()` both clear it (`_identityHolder.set(nil)`) in the SAME
    /// `stateLock` critical section that clears `_user` — a token surviving a
    /// project switch is the identical cross-tenant hazard `_startEpoch`
    /// exists to prevent, now applied to a bearer credential instead of a
    /// self-declared label.
    internal let _identityHolder = IdentityTokenHolder()

    /// Thread-safe, non-MainActor mirror of `isIdentityEnabled(_replaySession
    /// ?.currentConfig)`. Independent review, round 4 (Serious 3) —
    /// `captureUserSnapshot()` below must consult this before stamping
    /// `identitySubject`, so a report captured while identity is disabled for
    /// this project is stamped anonymous from the start, not merely withheld
    /// later at the live submit boundary while the raw subject still reaches
    /// the persisted `OutboxEntry` on transient failure. Without this, an
    /// entry captured while identity was OFF could attach a header on a LATER
    /// drain if the project's identity setting flips on and the subjects
    /// happen to match — same inconsistency shape as the round-4 epoch fix.
    ///
    /// A plain lock-protected `Bool`, not a read through `_replaySession`
    /// itself, because `_replaySession` is `@MainActor`-isolated (it owns a
    /// `CADisplayLink`) and `captureUserSnapshot()` must stay synchronous —
    /// crash-entry and Send-tap callers need its <5ms, non-blocking contract
    /// (see that function's own doc). `ReplaySession.applyConfig` updates
    /// this synchronously at the exact point it applies each newly-fetched
    /// config, right alongside `configBox.value = latest` — no MainActor hop
    /// needed to WRITE a plain NSLock-protected value even from MainActor
    /// code. Defaults to `false`: the same fail-closed default
    /// `ReplayConfig.off`/`isIdentityEnabled` already use before the first
    /// fetch resolves. `start()`/`kill()` both reset it to `false` in the
    /// same `stateLock` critical section that clears `_identityHolder`, for
    /// the identical reason: a stale "identity was enabled" reading must
    /// never survive into a new session that hasn't fetched its own config
    /// yet.
    internal let _identityEnabledFlag = IdentityEnabledFlag()

    /// Round-2 review Finding F9 — monotonically increasing generation
    /// counter, bumped under `stateLock` by BOTH `start()` and `kill()`.
    /// `start()`'s async heavy-init tail captures the epoch current at
    /// launch and only installs its `ReplaySession` (on MainActor) if that
    /// epoch is STILL current when the MainActor hop runs. `kill()` bumps
    /// this immediately (synchronously), so any start() tail still in
    /// flight — e.g. parked in `await drainOutbox()` — discards its
    /// would-be install instead of arming a session built from the killed
    /// config after `kill()` already believed itself done. Without this, a
    /// stale session's provider/refresh loop could re-arm the global
    /// network-body gate off a dead app's config.
    private var _startEpoch: Int = 0

    /// Independent review, round 12, SERIOUS — a dedicated LEAF lock guarding
    /// a MIRROR of `_startEpoch`, existing solely so `currentStartEpoch` can
    /// be read WITHOUT acquiring `stateLock`. This is what closes the
    /// lock-order inversion round 11's P1(b) fix introduced: that fix gave
    /// `IdentityEnabledFlag.set`'s `guard` closure a fresh epoch check
    /// evaluated WHILE HOLDING the flag's own lock — correct in isolation,
    /// but the closure it was handed (`{ TraceItX.shared.currentStartEpoch
    /// == startEpochAtCreation }`) read `currentStartEpoch`, which acquired
    /// `stateLock`. Meanwhile `start()`/`kill()` acquire `stateLock` FIRST
    /// and only then call into the flag (`_identityEnabledFlag.set(false)`,
    /// a few lines below) — flag-lock -> stateLock in one thread,
    /// stateLock -> flag-lock in another: the textbook AB-BA deadlock,
    /// reachable any time a background `start()`/`kill()` races the
    /// periodic config refresh. `ReplaySession.swift`'s own doc comment (and
    /// earlier reviews, before round 11) explicitly required the flag's lock
    /// to stay a LEAF — never itself acquiring `stateLock` — precisely to
    /// rule this class of bug out; round 11 needed the guard to be atomic
    /// at the write and reached for the nearest live epoch source without
    /// re-checking that constraint.
    ///
    /// The fix keeps BOTH properties instead of trading one for the other:
    /// `currentStartEpoch` still returns the value current AT THE INSTANT OF
    /// THE CALL (so a guard evaluated atomically at the write is still
    /// genuinely atomic, not a stale value threaded through from earlier),
    /// and the flag's lock never touches `stateLock`, directly or
    /// transitively. `_startEpochMirrorLock` is a true leaf: its own
    /// critical sections do nothing but read/write a plain `Int`, never
    /// call anything else, so no cycle can form through it regardless of
    /// what order callers acquire `stateLock`/the flag's lock/this lock in.
    /// `_startEpoch` itself remains the single canonical value, written and
    /// read as before everywhere else (`captureUserSnapshot()`,
    /// `captureSessionSnapshot()`, `resolveCapturedUser`, the direct
    /// `_startEpoch == epoch` comparisons) — none of those needed to change,
    /// since they already hold `stateLock` for their OWN reasons (pairing
    /// `_startEpoch` atomically with `_user`/`_config`) and never call into
    /// the flag while holding it. Only the two WRITE sites (`start()`,
    /// `kill()`) gained one extra line each — updating the mirror in the
    /// SAME `stateLock` critical section as the canonical increment, so an
    /// `epochLock` reader can never observe the mirror lagging behind
    /// `_startEpoch` itself.
    private let _startEpochMirrorLock = NSLock()
    private var _startEpochMirror: Int = 0

    /// Monotonic revocation counter, bumped ONLY by `kill()` under `stateLock`.
    ///
    /// Separate from `_startEpoch` because three situations look identical to
    /// that counter and want different answers: `start(B)` alone (the crash
    /// still belongs to A and must reach A), `kill()` alone (nothing may ship),
    /// and `kill()` then `start(B)` (the gate is open again, but the
    /// revocation happened after the capture). Only a counter `start()` never
    /// touches can express the third.
    ///
    /// Deliberately NOT `CompanionAuthEpoch`, which has the right shape but is
    /// also bumped when a companion session ends
    /// (`Companion/RelayWSClient.swift`'s `.invalidate()` call) — reusing it
    /// would discard crashes on an unrelated event.
    private var _killGeneration: UInt64 = 0
    /// The in-flight start() heavy-init Task, retained so `kill()` can
    /// cancel it directly — belt-and-suspenders alongside the epoch guard
    /// above (cancellation alone isn't sufficient because `drainOutbox()`
    /// and friends aren't guaranteed to observe `Task.isCancelled`
    /// mid-await, which is exactly why the epoch guard is the primary fix).
    private var _startTask: Task<Void, Never>?

    #if canImport(UIKit)
    /// Live session-replay coordinator (Phase 22-04, VTREE-02). nil until
    /// `start()` constructs it; only spins up a CADisplayLink tick when the
    /// remote config says ON + the sampling gate passes (default-OFF / lazy —
    /// no overhead when disabled). MainActor-isolated; reached from the reporter
    /// presenter + submit path via the `__replay*` seams below.
    @MainActor private var _replaySession: ReplaySession?
    #endif

    // MARK: - Pending attachments (auto-consumed by report.open())

    /// Max chars for `extra` — anything longer is truncated. A deliberate
    /// ceiling sized against its siblings (a single breadcrumb message is
    /// 2048 chars) and generous enough that hosts should not need to trim;
    /// matches the cross-SDK ceiling (raised from 2000 to 16384 chars / 16
    /// KiB — the 2000 figure had no storage or ingest justification).
    public static let EXTRA_MAX_CHARS = 16384

    /// Sticky host-supplied metadata. Single opaque string — callers
    /// JSON.stringify nested data themselves. Truncated at
    /// `EXTRA_MAX_CHARS` on write. Consumed and cleared on next
    /// `report.open()`.
    private var _pendingExtra: String?
    /// Sticky React-fiber walk produced by a host (typically the RN bridge's
    /// bippy adapter). Legacy attachment storage only; never included in reports.
    /// Consumed and discarded when the next report opens.
    private var _pendingReactTreeJSON: Data?
    /// false = capture disabled (kill switch active OR pre-start). The capture
    /// pipeline (04-03+) reads this gate before each capture cycle.
    nonisolated(unsafe) internal static var captureGate: Bool = false

    /// Public read of the capture gate. Used by capture-side code to decide
    /// whether to record a frame, header, log line, etc.
    public var captureGate: Bool {
        Self.captureGate
    }

    /// Record a caught Swift Error or NSError through the encrypted error outbox.
    public func captureException(_ error: any Error) {
        captureException(error, options: nil)
    }

    /// Record a caught Swift Error or NSError with owned structured details.
    public func captureException(_ error: any Error, options: CaptureExceptionOptions?) {
        guard Self.captureGate else { return }
        dispatch("captureException") {
            _ = CrashReporter.captureHandledError(error, options: options)
        }
    }

    /// Read-only snapshot of the current config (nil before start()).
    public var currentConfig: TraceItXConfig? {
        stateLock.lock(); defer { stateLock.unlock() }
        return _config
    }

    /// Read-only snapshot of the current user.
    public var currentUser: TXUser? {
        stateLock.lock(); defer { stateLock.unlock() }
        return _user
    }

    /// Snapshot the self-declared user TOGETHER with the session it belongs
    /// to, in ONE `stateLock` critical section.
    ///
    /// External review, finding 1 (Serious) — see `TXCapturedUser.swift`'s
    /// file header for the full defect. In short: the submit paths snapshot
    /// the user at the Send tap, but read the CONFIG (which carries the SDK
    /// key, i.e. the destination project) later, asynchronously. A
    /// `start(projectB)` landing in between uploaded project A's user under
    /// B's key. Capturing the user and `_startEpoch` atomically here, and
    /// re-checking the epoch at envelope-assembly time
    /// (`resolveCapturedUser`), makes a captured user valid ONLY for the
    /// session it was captured in.
    ///
    /// The two fields must be read under one acquisition: two separate reads
    /// could straddle a `start()` and produce a snapshot claiming A's user
    /// belongs to B's session — a pairing worse than either read alone.
    ///
    /// Native identity Task 3 — the identity subject joins this same critical
    /// section as a third field, for the identical reason: the report being
    /// captured now must be bound to whichever identity was active AT THIS
    /// INSTANT, not whichever is active when the (asynchronous, possibly
    /// minutes-later) submit finally runs. `_identityHolder.cachedSubject(now:)`
    /// is synchronous — it reads the holder's already-resolved cache and never
    /// awaits a provider — so this function keeps its <5ms, non-blocking
    /// contract. A cold cache (no token yet fetched) resolves `nil`, stamping
    /// the report anonymous; that is the fail-closed direction, not a bug.
    public func captureUserSnapshot() -> TXCapturedUser {
        stateLock.lock(); defer { stateLock.unlock() }
        // Independent review, round 4 (Serious 3) — the stamp itself must
        // respect the SAME `identity.enabled` gate the live submit boundary
        // already consults (`resolveIdentityHeader`'s `isIdentityEnabled`
        // check), not just withhold the header later while still persisting
        // the raw subject onto a queued entry. See `_identityEnabledFlag`'s
        // doc comment for why this is a separate flag rather than a direct
        // config read.
        //
        // `__replayConfigOverrideForTesting` is checked first, mirroring
        // `currentReplayConfig()`'s own precedence one property above — the
        // established test seam for "pretend config has resolved to X" that
        // `IdentityProviderWarmTests`/`IdentitySubjectGateTests` already use
        // for the async `resolveIdentityHeader` half of this same decision.
        // Without this, a test setting the override would still see the
        // SYNCHRONOUS capture-time gate read the (unset) production flag,
        // stamping nil regardless of what the override says — the two
        // halves of one decision silently reading two different sources.
        let identityEnabled = __replayConfigOverrideForTesting.map(isIdentityEnabled) ?? _identityEnabledFlag.get()
        let identitySubject = identityEnabled ? _identityHolder.cachedSubject(now: Date()) : nil
        return TXCapturedUser(
            user: _user,
            startEpoch: _startEpoch,
            identitySubject: identitySubject)
    }

    /// The user, the config and the revocation counter in ONE `stateLock`
    /// critical section — see `TXCapturedSession`. The crash path's entry
    /// read; other callers keep using `captureUserSnapshot()`.
    ///
    /// Merge note (native-identity x captured-session): this must compute
    /// `identitySubject` the SAME way `captureUserSnapshot()` above does —
    /// gated on `_identityEnabledFlag` and read from `_identityHolder
    /// .cachedSubject(now:)` — and in this SAME `stateLock` critical section,
    /// not a later, separate read. Reading it apart from `user`/`startEpoch`
    /// would reopen the exact non-atomicity `TXCapturedUser` exists to
    /// remove (see that file's header): a `setIdentityToken`/`start()`/
    /// `kill()` landing between two separate reads could pair one instant's
    /// user with a different instant's identity subject.
    public func captureSessionSnapshot() -> TXCapturedSession {
        stateLock.lock(); defer { stateLock.unlock() }
        let identityEnabled = __replayConfigOverrideForTesting.map(isIdentityEnabled) ?? _identityEnabledFlag.get()
        let identitySubject = identityEnabled ? _identityHolder.cachedSubject(now: Date()) : nil
        return TXCapturedSession(
            user: TXCapturedUser(user: _user, startEpoch: _startEpoch, identitySubject: identitySubject),
            config: _config,
            killGeneration: _killGeneration,
            configGeneration: _configGeneration
        )
    }

    /// Has a `kill()` run since `generation` was captured? Checked immediately
    /// before a report is handed to the outbox, so a revocation arriving
    /// during assembly still suppresses it.
    /// Has the installed config been REPLACED since `generation` was
    /// captured? Backs `TXCapturedSession.isSuperseded` — see
    /// `_configGeneration` for why the start epoch cannot answer this on iOS.
    internal static func configGenerationChanged(since generation: UInt64) -> Bool {
        shared.stateLock.lock(); defer { shared.stateLock.unlock() }
        return shared._configGeneration != generation
    }

    internal static func killGenerationChanged(since generation: UInt64) -> Bool {
        shared.stateLock.lock(); defer { shared.stateLock.unlock() }
        return shared._killGeneration != generation
    }

    /// Session Vitals: the revocation counter as of now. Taken under `stateLock`;
    /// `VitalsRuntime` reads it while holding its own lock (runtime lock -> stateLock,
    /// never the reverse — start()/kill() call the runtime OUTSIDE stateLock).
    internal static func currentKillGeneration() -> UInt64 {
        shared.stateLock.lock(); defer { shared.stateLock.unlock() }
        return shared._killGeneration
    }

    /// Session Vitals: the start epoch read WITHOUT `stateLock`. The vitals transport's kill
    /// predicate runs under the collector's lock at every send boundary; taking `stateLock`
    /// there would let a flush park behind start/kill teardown and break the collector's
    /// never-blocking send contract (Android round-3, Important 7).
    ///
    /// Deliberately a thin alias for `currentStartEpoch` rather than a SECOND mirror of
    /// `_startEpoch`: that property is ALREADY the lock-free read this needs — it goes through
    /// `_startEpochMirrorLock`, a documented leaf that never acquires (directly or
    /// transitively) `stateLock`, precisely so it can be called from inside another lock's
    /// critical section. A duplicate mirror written by `bumpStartEpoch()` would carry the same
    /// value with a second way to drift out of step, and no property this one does not have.
    internal static func startEpochLockFree() -> Int { shared.currentStartEpoch }

    /// The counterpart read: `captured.user` iff its session is STILL the
    /// installed one, `nil` otherwise (degrade to anonymous — never attribute
    /// to the wrong person or the wrong project).
    ///
    /// Backs `TXCapturedUser.resolve()`; kept here because `_startEpoch` and
    /// its lock live here. `internal` — hosts resolve through the snapshot.
    internal func resolveCapturedUser(_ captured: TXCapturedUser) -> TXUser? {
        stateLock.lock(); defer { stateLock.unlock() }
        return captured.startEpoch == _startEpoch ? captured.user : nil
    }


    /// Round-6 review Finding F27 — synchronous, `stateLock`-protected read
    /// of `_startEpoch` (see its doc comment above). Lets a `ReplaySession`
    /// capture the epoch current at its OWN creation and later verify,
    /// synchronously and WITHOUT an `await`, that no superseding
    /// `start()`/`kill()` has run since.
    ///
    /// Why this is needed in addition to `ReplaySession`'s own session-local
    /// `epoch`/`teardown()` (round-3 Finding F13): `start(A) -> start(B)`
    /// resets the shared gate/buffer and bumps `_startEpoch` SYNCHRONOUSLY,
    /// but A's OWN session's `teardown()` is only requested via a dispatched
    /// `Task { @MainActor in ... }` (see `start()`'s doc comment for why —
    /// `_replaySession` is MainActor-isolated and `start()` must stay
    /// synchronous). A's already-in-flight `refreshConfigNow()` continuation
    /// can resume on MainActor BEFORE that dispatched teardown task runs,
    /// still pass A's UNCHANGED session-local epoch check, and re-arm the
    /// global gate off A's stale, superseded config — the session-local
    /// mechanism alone cannot see the supersession until its own teardown
    /// task actually executes, which has no ordering guarantee relative to
    /// A's resumed continuation.
    ///
    /// This global epoch closes that gap: it is bumped inside `start()`'s
    /// (and `kill()`'s) synchronous section, before either function returns,
    /// with no dispatch/await dependency — so it is visible to a racing
    /// continuation the INSTANT a superseding `start()`/`kill()` runs,
    /// regardless of MainActor scheduling order.
    ///
    /// Independent review, round 12, SERIOUS — reads via `_startEpochMirrorLock`,
    /// NOT `stateLock`, deliberately: this property is called from many
    /// independent sites across the codebase, including from INSIDE another
    /// lock's critical section (`IdentityEnabledFlag.set`'s `guard` closure,
    /// evaluated while that lock is held) where acquiring `stateLock` would
    /// risk a lock-order inversion against `start()`/`kill()`, which acquire
    /// `stateLock` first and only then call into the flag. See
    /// `_startEpochMirrorLock`'s own doc comment for the full mechanism and
    /// why this is still a genuinely fresh, atomic-at-the-call read, not a
    /// stale cached value.
    internal var currentStartEpoch: Int {
        _startEpochMirrorLock.lock(); defer { _startEpochMirrorLock.unlock() }
        return _startEpochMirror
    }

    /// Bump `_startEpoch` and keep `_startEpochMirror` in lockstep, in the
    /// SAME `stateLock` critical section as the canonical write — the only
    /// two call sites are `start()` and `kill()`, both already inside their
    /// own `stateLock.lock()`/`unlock()` pair. Centralized here (rather than
    /// duplicating the mirror-update line at both sites) so there is exactly
    /// ONE place that can drift the mirror out of sync with `_startEpoch` if
    /// a future edit gets it wrong, not two.
    private func bumpStartEpoch() -> Int {
        _startEpoch += 1
        let epoch = _startEpoch
        _startEpochMirrorLock.lock()
        _startEpochMirror = epoch
        _startEpochMirrorLock.unlock()
        return epoch
    }

    /// Test-only override of `currentReplayConfig()` (fix round 3). Public —
    /// unlike `_replaySession` itself — for the same cross-module test
    /// reachability reason `__resolveIdentityToken`-equivalents are public
    /// elsewhere on this branch; mirrors Android
    /// `TraceItX.__replayConfigOverrideForTesting` one-for-one, including
    /// being cleared by `kill()` below (a value left set would silently
    /// override the fail-closed `.off` default for every submit path across
    /// a kill()/re-start() cycle). `nil` (default/production) falls back to
    /// the live `_replaySession` exactly as before.
    public var __replayConfigOverrideForTesting: ReplayConfig?

    /// Native identity Task 8b — the ONE live `ReplayConfig` every submit path
    /// (live, drain, crash) reads to resolve `resolveIdentityHeader`'s
    /// `config:` parameter, so all three agree on whether identity is
    /// currently enabled and never drift onto their own private notion of
    /// "current."
    ///
    /// Declared UNCONDITIONALLY (not `#if canImport(UIKit)`) because
    /// `CrashReporter.swift` — which compiles on every platform, including the
    /// macOS host build these SPM tests run under — needs to call it from its
    /// non-fatal immediate-drain `Task`. `_replaySession` itself only exists on
    /// UIKit platforms (it owns the `CADisplayLink`-driven sampling tick), so
    /// on any platform without it — and before the FIRST `start()` call has
    /// even constructed one — this resolves the same fail-closed `.off`
    /// default `ReplayConfigProvider` itself starts at, never a hard error.
    /// `async` for the `MainActor` hop into `_replaySession` (`ReplaySession`
    /// is `@MainActor`); callable from any isolation domain.
    ///
    /// Checks `__replayConfigOverrideForTesting` first (fix round 3) —
    /// mirrors Android `TraceItX.__replayConfigOverrideForTesting`, added
    /// there for the identical cross-module test-fixture need. `nil`
    /// (default/production) falls back to the live `_replaySession` exactly
    /// as before.
    internal func currentReplayConfig() async -> ReplayConfig {
        if let override = __replayConfigOverrideForTesting { return override }
        #if canImport(UIKit)
        return await MainActor.run { self._replaySession?.currentConfig ?? .off }
        #else
        return .off
        #endif
    }

    // MARK: - Config test seam (round-5 review Finding F22 regression)

    /// Test-only seam: set `_config` directly, WITHOUT running `start()`'s
    /// async heavy-init tail (breadcrumb/tap adapter install, replay-session
    /// construction, ...) or its synchronous `NetworkBodyCaptureGate.reset()`
    /// / `NetworkBodyRingBuffer.clear()` side effects. Mirrors Android's
    /// `TraceItX.__setConfigForTesting` (added alongside this for the same
    /// finding — see `packages/sdk-android/.../TraceItX.kt`).
    ///
    /// `NetworkBodyCaptureGate.locallyDisabled(for:)` (F22) fails closed on a
    /// nil `currentConfig`, so specs that drive `ReplaySession` directly
    /// (bypassing `start()`, e.g. `ReplaySessionRefreshLoopTests`) need
    /// `currentConfig` populated with `capture.network == true` /
    /// `capture.networkBodies != false` for the gate to legitimately arm.
    /// This seam lets them do that without paying for/coordinating around
    /// `start()`'s full tail. Production code never calls this.
    ///
    /// **It cannot simulate a session change.** It writes `_config` and nothing
    /// else — it bumps neither `_startEpoch` nor `_killGeneration`. A spec that
    /// reached for it to drive the epoch rule (`resolveCapturedUser`) or the
    /// revocation rule (`killGenerationChanged`) would assert nothing: every
    /// snapshot taken around it keeps matching. Exercising either rule requires
    /// a real `start()` / `kill()`.
    internal static func __setConfigForTesting(_ config: TraceItXConfig?) {
        TraceItX.shared.stateLock.lock()
        TraceItX.shared._config = config
        TraceItX.shared._configGeneration &+= 1
        TraceItX.shared.stateLock.unlock()
    }

    // MARK: - stateLock test seam (independent review, round 12, SERIOUS)

    /// Test-only direct access to `stateLock`, mirroring
    /// `__setConfigForTesting`'s existing pattern of touching the `private`
    /// lock from a same-file `internal` wrapper. Exists so a test can
    /// deterministically reproduce the exact lock-acquisition ORDER
    /// `start()`/`kill()` use (`stateLock` first, then a call into
    /// `_identityEnabledFlag`) without needing to drive the full `start()`/
    /// `kill()` heavy-init machinery on a real background thread — see
    /// `IdentityTokenHolderTests.swift`'s
    /// `testFlagSetGuardNeverDeadlocksAgainstAConcurrentStateLockHolderCallingIntoTheFlag`
    /// for the deadlock reproduction this backs. Production code never
    /// calls these.
    internal static func __lockStateLockForTesting() {
        TraceItX.shared.stateLock.lock()
    }

    internal static func __unlockStateLockForTesting() {
        TraceItX.shared.stateLock.unlock()
    }

    // MARK: - Heavy-init test hook

    /// Visible to @testable importers. Flipped to true after Task.detached heavy
    /// init completes. StartPerfTests asserts this becomes true asynchronously.
    nonisolated(unsafe) internal static var __heavyInitDidRun = false

    /// Test-only reset. Production code does not call this.
    internal static func __resetHeavyInitFlagForTesting() {
        __heavyInitDidRun = false
    }

    #if canImport(UIKit)
    /// Test-only seam (final-review Finding 1) — true once `start()`'s heavy
    /// init has constructed the replay session, false once `kill()` has torn
    /// it down. Both transitions happen asynchronously (heavy init on a
    /// detached `Task`, teardown via a `Task { @MainActor in }` hop from the
    /// synchronous `kill()`), so tests poll this rather than reading it once.
    /// Production code does not call this.
    @MainActor
    internal static var __hasReplaySessionForTesting: Bool {
        TraceItX.shared._replaySession != nil
    }
    #endif

    // MARK: - Start-tail race test seam (round-2 review Finding F9)

    /// Test-only seam — when set, start()'s heavy-init tail `await`s this
    /// closure right after `drainOutbox()` returns and before the MainActor
    /// hop that installs `_replaySession`. This lets a test hold the async
    /// tail open long enough to interleave a `kill()` call deterministically
    /// (an empty local outbox drains near-instantly otherwise, making the
    /// real race window too narrow to hit reliably). `nil` in production —
    /// the tail proceeds straight through with no added delay.
    nonisolated(unsafe) internal static var __startTailDelayHookForTesting: (@Sendable () async -> Void)?

    /// Test-only reset for the start-tail delay hook. Production code does not call this.
    internal static func __resetStartTailDelayHookForTesting() {
        __startTailDelayHookForTesting = nil
    }

    // MARK: - Session-supersession test seam (round-4 review Finding F16)

    #if canImport(UIKit)
    /// Test-only seam — when set, start()'s heavy-init tail constructs its
    /// `ReplaySession` via this factory instead of the production
    /// `ReplaySession(baseURL:apiKey:locallyDisabled:)` initializer. Real
    /// network is unreachable/uncontrolled from here, so this lets specs
    /// inject a session built from a fake `ReplayConfigProvider` (mirroring
    /// `ReplaySessionTeardownRaceTests`' `GatedFetcher`/`MutableClock`
    /// pattern) so the A→B session-supersession race
    /// (`ReplaySessionSupersessionTests.swift`) can be exercised against the
    /// REAL install code path in `start()`, not just the `ReplaySession`
    /// class in isolation. `nil` in production — the tail builds its session
    /// normally.
    nonisolated(unsafe) internal static var __replaySessionFactoryForTesting: ((TraceItXConfig) -> ReplaySession)?

    /// Test-only reset for the session factory. Production code does not call this.
    @MainActor
    internal static func __resetReplaySessionFactoryForTesting() {
        __replaySessionFactoryForTesting = nil
    }
    #endif

    // MARK: - Body-state reset ordering test seam (round-8 review Finding F39)

    /// Test-only seam — when set, `start()` calls this closure synchronously,
    /// immediately after `NetworkBodyCaptureGate.shared.reset()` /
    /// `NetworkBodyRingBuffer.shared.clear()` have both run. Lets a test
    /// observe `currentStartEpoch` at exactly that point and assert it
    /// already reflects the NEW epoch — proving no reader can ever observe
    /// "the gate was just reset, but the epoch a concurrent
    /// `refreshConfigNow()` would compare against is still the OLD one" (see
    /// `start()`'s doc comment for the full ordering rationale). `nil` in
    /// production — zero overhead beyond one optional-closure check.
    ///
    /// External review, finding 9 (Serious) reuses this same seam for the
    /// second invariant that now holds at this exact point: `_user` must
    /// ALREADY be nil here. This is the only reachable instant between
    /// `start()`'s two `stateLock` acquisitions, so a snapshot taken from
    /// this closure is precisely the observation that used to pair A's user
    /// with B's epoch (see `EnvelopeUserTests
    /// .testASnapshotTakenInsideStartsResetWindowCannotResolve`).
    nonisolated(unsafe) internal static var __bodyStateResetHookForTesting: (() -> Void)?

    /// Test-only reset for the body-state reset hook. Production code does not call this.
    internal static func __resetBodyStateResetHookForTesting() {
        __bodyStateResetHookForTesting = nil
    }

    // MARK: - Public API

    /// Synchronous; returns in <5ms (RESEARCH Pitfall 5). Throws on bad config
    /// (HTTPS-only endpoint, missing/malformed sdkKey).
    public func start(config: TraceItXConfig) throws {
        try ConfigValidator.validate(config)

        // Round-5 review Finding F23 — `start(A) -> start(B)` is NOT a safe
        // app/session boundary by itself: everything below this point
        // synchronously overwrites `_config`/re-opens `captureGate`/changes
        // the submit key, but WITHOUT the two lines immediately below, A's
        // `NetworkBodyCaptureGate` state (including its STICKY sampling
        // draw — see that type's file header) and A's buffered request/
        // response bytes stayed live until the delayed async tail ran (or
        // forever, for the body buffer — nothing ever cleared it here). A
        // request captured in that window kept capturing under A's server
        // authorization, and a report opened under B could upload A's
        // buffered bodies to B's app/key.
        //
        // Both calls below are NSLock-guarded, non-actor-isolated
        // singletons (mirrors the same two calls already made from
        // `kill()`) — no MainActor hop needed, so this genuinely IS atomic
        // with the `_config`/`captureGate` flip a few lines down: by the
        // time `captureGate` observably flips true for B, A's sticky
        // sampling draw is gone and every byte A had buffered is gone. A
        // superseding `start()` is, from the body-capture subsystem's point
        // of view, exactly as much of a session boundary as an explicit
        // `kill()`.
        //
        // Follow-ups register item 10 (2026-08-13) — the BREADCRUMB chain and
        // the network METADATA ring are cleared here too, by the two extra
        // calls below. They were not until then, and this paragraph recorded
        // the opposite decision: "Network CRUMBS are deliberately NOT cleared
        // here", on the grounds that every other breadcrumb kind already
        // survived a bare `start()` -> `start()` and that widening F23's fix
        // to the whole ring was broader than that finding called for. That
        // reasoning weighed CONSISTENCY and never weighed TENANCY, which is
        // what overturns it. `_config` carries the SDK KEY, so
        // `start(A) -> activity -> start(B)` left A's crumb chain and A's
        // network rows — URLs, status codes, timings — alive in
        // process-global rings, and the NEXT ORDINARY REPORT IN B shipped
        // them to a different customer's project: deterministic, no race
        // needed, unbounded until the rings roll over, on the ordinary
        // reporter and companion paths. Same class as this spec's items 1 and
        // 6, and the reason the old cost/benefit does not survive contact
        // with it.
        //
        // Safe in this direction, which is what made the omission an
        // oversight rather than a trade: `BreadcrumbRingBuffer.add` no-ops
        // while the capture gate is closed, and the gate is closed before the
        // first `start()`, so a clear here can only ever discard a PREVIOUS
        // session's content. Identical to the argument `_user`'s
        // unconditional clear makes below — the only thing an earlier clear
        // can cost is attribution, never misattribution. It applies to a
        // same-config re-`start()` too (there is no config-equality early
        // return, by design), on the same one-sentence rule: `start()` begins
        // a session with nothing carried over.
        //
        // `clear()` covers the frozen reporter snapshot as well as the live
        // entries (`BreadcrumbRingBuffer.clear()` sets `frozen = nil`), so
        // these calls zeroize exactly what `kill()`'s do — there is no extra
        // snapshot step for `start()` to also make.
        //
        // The old paragraph's `reqId` correlation nit goes away with it:
        // metadata crumbs and bodies are now both emptied at the boundary, so
        // no session-A crumb survives to be re-correlated against a
        // freshly-minted session-B `reqId`.
        //
        // NOT airtight against a concurrent capture, and not claimed to be:
        // `captureGate` stays open across this whole block (it is A's gate
        // until the flip below), so an A request completing between a clear
        // and the `_config` install can still append one row. That window is
        // exactly the one the body ring has always had here, it is bounded by
        // a few statements, and it is a different order of problem from the
        // unbounded carry-over above.
        //
        // Round-8 review Finding F39 (continued) — `_startEpoch` is bumped
        // in its OWN `stateLock` acquisition, FIRST, strictly before
        // `NetworkBodyCaptureGate.shared.reset()` runs below (previously the
        // reset ran BEFORE the epoch bump, both together in a single block
        // further down). That earlier ordering left a real window: a
        // `ReplaySession.refreshConfigNow()` on another session (MainActor,
        // possibly a different thread than this synchronous, non-actor-
        // isolated call) could read `TraceItX.shared.currentStartEpoch`
        // strictly BETWEEN `reset()` having already deactivated the gate and
        // `_startEpoch` actually incrementing — observing the OLD epoch
        // (matching its own, so its guard would wrongly pass) even though
        // the reset it's about to stomp on has already happened. Bumping the
        // epoch FIRST closes that: any reader's fresh, lock-protected epoch
        // read (see `NetworkBodyCaptureGate.applyConfig`'s `guard` parameter,
        // also F39) can now only ever observe the epoch as OLD if `reset()`
        // genuinely hasn't run yet either (program order within this single,
        // synchronous function) — in which case that reader's own apply, if
        // it proceeds, simply happens-before `reset()` and is correctly
        // clobbered by it moments later, same as always.
        //
        // This is intentionally a SEPARATE `stateLock` acquisition from the
        // `_config`/`captureGate` flip below, not one shared critical
        // section spanning `reset()` too: `NetworkBodyCaptureGate.applyConfig`'s
        // new F39 guard closure reads `currentStartEpoch` (`stateLock`) from
        // INSIDE the gate's OWN lock — holding `stateLock` across a call
        // into `reset()` (which takes that same gate lock) would invert that
        // ordering and risk an AB-BA deadlock against a concurrent
        // `applyConfig` call elsewhere. Two short, sequential, un-nested
        // acquisitions avoid that while still closing the epoch/reset gap by
        // construction (program order), and `_config`/`captureGate` still
        // only flip to B AFTER `reset()`/`clear()` complete, preserving
        // F23's original ordering guarantee (no newly arriving request can
        // ever see B's identity paired with A's still-armed gate or
        // still-buffered bytes).
        //
        // External review, finding 9 (Serious) — `_user = nil` lives HERE,
        // in the same critical section as the epoch bump, and NOT in the
        // `_config`/`captureGate` block below where it originally sat.
        // Splitting those two writes across two acquisitions left a window
        // spanning `reset()`/`clear()` in which `_startEpoch` was already B's
        // while `_user` was still A's, and a concurrent
        // `captureUserSnapshot()` landing in it read A's user paired with B's
        // epoch — atomically, so the pair looked perfectly self-consistent.
        // `resolveCapturedUser()` then found a MATCHING epoch, concluded the
        // user belonged to the installed session, and shipped A's
        // id/email/display name under B's SDK key: exactly the cross-project
        // misattribution the epoch guard exists to prevent, invisible to it
        // because the guard detects a CHANGING epoch and here the captured
        // epoch was already the new one. Bumping the epoch and clearing the
        // user together makes "new epoch observed ⟹ old user already gone"
        // true by construction, for every observer, with no window at all.
        //
        // This does not disturb F23/F39 above: their guarantee is about the
        // epoch bump preceding `reset()`/`clear()`, which it still does, and
        // about `_config`/`captureGate` flipping to B only AFTER those resets
        // complete, which they still do. Clearing the user is strictly more
        // conservative the earlier it happens — the only thing an earlier
        // clear can cost is attribution, which degrades to anonymous, never
        // to the wrong person or the wrong project.
        //
        // See the `_config`/`captureGate` block below for WHY `start()`
        // clears the user unconditionally in the first place.
        // Native identity Task 4 — `_identityHolder.set(nil)` clears the
        // verified-identity token in the SAME critical section as `_user =
        // nil` immediately above, for the identical reason external review
        // finding 9 gives for that line: this is the earliest point in
        // start() and the only reachable instant between its two `stateLock`
        // acquisitions, so clearing here (rather than down in the
        // `_config`/`captureGate` block) means no observer can ever pair a
        // NEW epoch with project A's still-installed credential. A token
        // surviving `start(projectA) -> start(projectB)` would let project
        // B's reports present project A's user's server-verified identity —
        // worse than the self-declared `_user` leak this same line already
        // closes, since a verified credential is the one thing a receiving
        // server trusts without question. `IdentityTokenHolder.set` takes its
        // OWN lock, never `stateLock`, so calling it from inside this
        // critical section cannot deadlock or invert lock ordering.
        stateLock.lock()
        let epoch = bumpStartEpoch()
        _user = nil
        _identityHolder.set(nil)
        // Independent review, round 4 (Serious 3) — a fresh session has not
        // fetched its own config yet, so "identity was enabled" from the
        // PREVIOUS project must never survive into it; see
        // `_identityEnabledFlag`'s doc comment.
        _identityEnabledFlag.set(false)
        stateLock.unlock()

        // Codex round-1 fix D, finding 4 (partial by ruling — no
        // epoch-guarded setter). Same session-boundary argument as `_user`/
        // `_identityHolder` above, applied to the dashboard-configured
        // companion-badge override: a new start() against a different app
        // must not keep showing/hiding the badge per project A's server
        // block while project B's first config fetch is still in flight.
        // `CompanionBadgeServerConfigBox` is its own `NSLock`-guarded box
        // (not `stateLock`), so this is a separate, un-nested write — same
        // reasoning as `NetworkBodyCaptureGate.shared.reset()` a few lines
        // below not sharing `stateLock` either. Safe in this direction only:
        // `ReplaySession`/`CompanionBadge` only ever WRITE/READ this box from
        // a live config apply, never consult it to decide whether to fetch,
        // so clearing it here can only ever discard a PREVIOUS session's
        // override, never suppress a legitimate one.
        CompanionBadgeServerConfigBox.shared.value = nil

        // Branding (iOS spec 2026-08-26): same session-boundary argument as
        // the companion clear above — project B must not inherit project A's
        // paid entitlement/theme while B's first config fetch is in flight.
        BrandingServerConfigBox.shared.value = nil

        // Session Vitals (iOS spec 2026-09-05 §2; Android codex round-1/2/3 Critical 1–3):
        // a superseding start() is a session boundary for vitals. Unpublish A's runtime
        // FIRST, then publish B's identity below. Both calls run OUTSIDE stateLock —
        // shutdown() runs every integration's customer detach(). `dropPending: false`: a
        // trackPlayer() still queued is waiting for A SESSION, which this start provides.
        // The predicates are evaluated inside the callee's own lock, so a start(C) that
        // completed while B was blocked in customer teardown is never unpublished by B.
        let vitalsStillNewest: () -> Bool = { TraceItX.shared.currentStartEpoch == epoch }
        VitalsRuntime.shared.shutdown(dropPending: false, ifCurrent: vitalsStillNewest)
        VitalsServerConfigBox.shared.publish(nil, ifCurrent: vitalsStillNewest)
        ShakeToReportTrigger.shared.beginSession(
            localEnabled: config.shakeToReportEnabled,
            ifCurrent: vitalsStillNewest
        )

        NetworkBodyCaptureGate.shared.reset()
        NetworkBodyRingBuffer.shared.clear()
        // Follow-ups item 10 — the two `clear()` calls `kill()` has always
        // made (`TraceItX.swift`'s kill(), just below its own gate flip) and
        // `start()` never did. See the tenancy paragraph in this function's
        // header comment; guarded by
        // `EnvelopeUserTests.testAReportInTheNextProjectShipsNoneOfThePreviousProjectsBreadcrumbs`
        // and `...testTheNextProjectStartsWithNoneOfThePreviousProjectsNetworkRows`.
        BreadcrumbRingBuffer.shared.clear()
        NetworkRingBuffer.shared.clear()

        // Test-only seam (round-8 review Finding F39) — see its doc comment
        // below. No-op in production (`nil`).
        Self.__bodyStateResetHookForTesting?()

        stateLock.lock()
        // Publication re-check (Android round-3, Critical 2): a start that lost the race
        // while running customer teardown above publishes NOTHING and launches no tail.
        guard _startEpoch == epoch else { stateLock.unlock(); return }
        _config = config
        // Follow-ups item 9, fourth round — bumped HERE, with the assignment
        // it describes, never in the epoch section above. That is the whole
        // point of it being a separate counter.
        _configGeneration &+= 1
        // External review, finding 2 (Serious) — `start()` clears the
        // self-declared user (`setUser`, spec 2026-08-12). `_user = nil` is
        // NOT written here; it is written in the epoch-bump section ABOVE (see
        // finding 9 there for why it had to move earlier — this block runs
        // after `reset()`/`clear()`, and the gap between the two was itself
        // exploitable). What follows is the rationale for the clear itself,
        // which is unchanged by where the store lives.
        //
        // The clear must happen no later than the install of the new
        // configuration, so no observer can ever see B's SDK key paired with
        // A's user. `kill()` already did this (see its own comment below);
        // `start()` did not, and it is the more dangerous half: `_config`
        // carries the SDK KEY, i.e. the project every subsequent report is
        // uploaded to. `start(projectA) → setUser(X) → start(projectB)`
        // therefore uploaded A's id/email/display name under B's key, creating
        // a falsely attributed person in a DIFFERENT customer's project. React
        // Native makes it especially reachable: unmounting the provider leaves
        // this singleton's user intact, so a remount + reconfigure inherits
        // the previous one.
        //
        // UNCONDITIONAL, including a same-key re-`start()`. The rule an
        // integrator has to hold is one sentence — "start() begins a session
        // with no user; call setUser after start" — and that is worth more
        // than a config-equality predicate would be (TraceItXConfig carries
        // closures and is not Equatable, so "same project" is not even
        // cheaply decidable here). It also costs nothing correct: web's
        // `setUser` is already a no-op before `init` and Android's is a no-op
        // while the capture gate is closed, so setting the user AFTER start is
        // already the only ordering that works on every platform.
        //
        // `Self.captureGate = true` stays HERE, deliberately: it ARMS capture,
        // and F23 requires it to flip true only after A's gate/buffer state is
        // gone. Only the user clear moved earlier.
        Self.captureGate = true
        stateLock.unlock()

        #if canImport(UIKit)
        // Round-5 review Finding F23 (continued): request teardown of any
        // PRIOR session's refresh loop as early as possible — dispatched
        // right here, rather than gated behind the heavy-init tail's
        // `await drainOutbox()` below (which can take arbitrarily long
        // under bad network), so A's own periodic/initial refresh has the
        // smallest possible window to reapply its config before its epoch
        // is invalidated by `teardown()`. `_replaySession` is
        // MainActor-isolated and `start()` must stay synchronous/non-actor
        // per its documented <5ms contract, so this cannot be made
        // literally synchronous without risking a crash on a caller that
        // isn't already on the main thread (`MainActor.assumeIsolated`
        // would trap there). The NSLock-guarded resets above already
        // close the actual data-exposure window (gate inactive + body
        // buffer empty) regardless of when this hop actually runs; this
        // just shrinks the (already narrow) window in which A's OWN
        // refresh could re-open the gate with A's authorization before
        // teardown lands. The heavy-init tail's own MainActor.run block
        // below calls `teardown()` again before installing B's session —
        // idempotent, so harmless whichever of the two actually runs
        // first.
        Task { @MainActor in
            TraceItX.shared._replaySession?.teardown()
        }
        #endif

        // Task 7: breadcrumb adapters — lifecycle (background/foreground)
        // + uncaught-exception handler. Install-once, safe across repeated
        // start() calls (mirrors LogCapture.install()'s idempotency).
        // Console/network dual-writes need no install: they fire passively
        // from their existing capture call sites (StderrIntercept,
        // NetworkCaptureProtocol) and are gated by BreadcrumbRingBuffer's
        // live per-kind config, not by anything installed here.
        BreadcrumbAdapters.install()

        // Task 8: tap + navigation breadcrumb adapters (IMP-replace swizzles
        // of `UIApplication.sendAction`/`UIViewController.viewDidAppear`).
        // Install-once, safe across repeated start() calls. UIKit-only — the
        // whole file (and therefore this type) is compiled out on the macOS
        // host build.
        #if canImport(UIKit)
        BreadcrumbTapNavAdapters.install()
        #endif

        // Heavy work — DO NOT await. Host's main thread continues immediately.
        // This is the SINGLE place that 04-03/04/05 subsystems are wired into
        // start() (B2-residual single-writer invariant).
        //
        // Non-detached Task off MainActor: runs on the global concurrent
        // executor. `config` is now Sendable (TraceItXConfig: Sendable), so
        // capturing it by value in the Task is safe under Swift 6 region-
        // based isolation. The previous `Task.detached { @MainActor in ... }`
        // pattern tripped a compiler region-checker corner case and forced
        // log/outbox work onto the main thread unnecessarily.
        let startTask = Task { [config, epoch] in
            // 04-04: log capture (gated on config.capture.logs).
            // LogCapture.install() is idempotent — safe across multiple start()
            // calls if a host re-configures.
            if config.capture.logs {
                LogCapture.install()
            }

            // 04-05: outbox drain on launch (best-effort). Replays any queued
            // envelopes from previous sessions. ReportSubmitter constructs its
            // own URLSession that excludes our own URLProtocol-based capture
            // interceptor (so submission requests don't recurse).
            let submitter = ReportSubmitter(config: config)
            // Native identity Task 8b — the real singleton holder + the live
            // `ReplayConfig`, not the inert defaults `drainOutbox` used to
            // fall back to.
            //
            // ACCEPTED LIMITATION (fix round 1, Important finding 1) — this
            // call can NEVER attach an identity header, by construction, on
            // EVERY invocation, not just a cold cache: `_identityHolder` was
            // cleared under `stateLock` a few lines above `start()`'s
            // synchronous section (so `.get(now:)` always resolves nil), and
            // `currentReplayConfig()` resolves `.off` because the
            // `ReplaySession` that would have fetched a real one is installed
            // LATER in this same async tail, in the `#if canImport(UIKit)`
            // block below `start.replay` — this statement runs first. That
            // pairing degrades to exactly `resolveIdentityHeader`'s documented
            // fail-closed default, so it is safe, never a leak — but it does
            // mean this call site can never be the retry path that recovers
            // "Alice queues offline, Bob signs in, the retry fires": that
            // report ships unattributed on THIS drain and is then deleted on
            // 200, forever anonymous. Same accepted tradeoff web's
            // `enqueuedSubjects` map takes for an entry queued in a previous
            // page-load session (`sdk-react/src/transport/submit.ts`'s module
            // doc) — losing attribution is the safe direction, not a defect.
            //
            // `CrashReporter.swift`'s non-fatal immediate drain is the OTHER
            // production call site, and it does NOT share this limitation: it
            // runs whenever a still-alive app catches a non-fatal error,
            // arbitrarily long after `start()` returns — by which point the
            // `ReplaySession` below has had a real chance to fetch and the
            // host has had a real chance to call `setIdentityToken`. See
            // `CrashDrainIdentityHeaderTests.swift` for a demonstration.
            //
            // ACCEPTED LIMITATION (independent review, round 8, Serious 2) —
            // the gap above is wider than just this drain's OWN reports.
            // `await submitter.drainOutbox(...)` runs SEQUENTIALLY, entry by
            // entry, and each attempt can spend a full network timeout before
            // falling back to retryable-queue — so with a deep queue and a
            // bad network, this single `await` can legitimately take a long
            // time. `_identityEnabledFlag` (`captureUserSnapshot()`'s
            // synchronous gate) is not set until `ReplaySession.applyConfig`
            // runs, which cannot happen until the `ReplaySession` below is
            // constructed AND its first fetch resolves — both strictly AFTER
            // this `await` returns. So it is not only this drain's queued
            // reports that ship anonymous during that window: ANY capture
            // anywhere in the app — a crash, an in-app reporter submit, a
            // companion submit — that lands before this `await` returns is
            // ALSO permanently anonymous, even if the host already called
            // `setIdentityToken` moments after `start()`. Capture-time
            // binding means there is no "catching up" a report captured nil
            // once the window closes.
            //
            // Investigated, not assumed: moving the `ReplaySession`
            // construction/`enableIfConfigured()` block below to run before
            // or concurrently with this drain would shrink the window, and
            // was the first fix attempted here. It was reverted. That block,
            // its `stateLock`-guarded epoch re-check, and the MainActor hop
            // around it are the exact mechanism
            // `StartEpochGuardTests.swift` (round-2 Finding F9, round-6
            // Finding F31) pins byte-for-byte: `TraceItX
            // .__startTailDelayHookForTesting` parks the async tail at a
            // FIXED point — deliberately positioned right after this drain
            // and immediately around the `ReplaySession` construction — so a
            // test can interleave `kill()` into that exact gap
            // deterministically (an empty local outbox drains near-instantly
            // otherwise, making the real race window too narrow to hit on
            // purpose). Reordering or parallelizing the replay-install block
            // relative to this drain moves or splits that gap, which breaks
            // the hook's documented position and would require re-deriving
            // (not just relocating) that test's synchronization mechanism —
            // exactly the "rearranged wholesale" risk this branch has been
            // told repeatedly not to take for an attribution-only issue.
            // Lost attribution is the failure this design already nominates
            // as acceptable (same posture as the launch-drain limitation
            // immediately above, and the reporter-open warm race documented
            // in `TXReporterPresenter.swift`); a kill()/start() race
            // silently re-arming the network-body capture gate off a dead
            // app's config is not. Documented in
            // `the user-recognition contract`, not silently left as a
            // gap.
            // Independent review, round 8, Serious 1 — `epoch` here is the
            // SAME value already captured in this Task's `[config, epoch]`
            // closure list, synchronously, in `start()`'s own critical
            // section — before ANY of this async tail (including this
            // Task's own scheduling delay) could run. Passing it through as
            // `epochAtInitiation` closes the hole a live-sampled baseline
            // inside `drainOutbox` itself could not: see that parameter's
            // doc comment in ReportSubmitter.swift for the full mechanism.
            await submitter.drainOutbox(
                identityHolder: TraceItX.shared._identityHolder,
                currentReplayConfig: { await TraceItX.shared.currentReplayConfig() },
                epochAtInitiation: epoch,
                currentEpoch: { TraceItX.shared.currentStartEpoch }
            )

            // Round-2 review Finding F9 test seam — see its doc comment.
            // No-op in production (`nil`).
            if let hook = Self.__startTailDelayHookForTesting {
                await hook()
            }

            // Session Vitals (iOS spec 2026-09-05 §2) — build the controller here, off
            // the main thread; the server box (written by ReplaySession's config apply)
            // drives its start gate. The transport is bound to THIS start's epoch through
            // the lock-free mirror, so a retry fired after a later start()/kill() is silent.
            //
            // NOT inside the `#if canImport(UIKit)` block below: vitals have no UIKit
            // dependency beyond the lifecycle observer (itself gated), so the controller must
            // be installed on the macOS host too.
            let vitalsDims = VitalsDims.current(sdkVersion: TraceItX.SDK_VERSION)
            let vitalsEndpoint = IngestEndpoint.url.appendingPathComponent("api/ingest/vitals")
            let vitalsSession = ReportSubmitter.sharedIsolatedSessionForVitals
            let vitalsController = VitalsController(deps: VitalsController.Deps(
                localConfig: config.vitals,
                dims: vitalsDims,
                transport: {
                    VitalsTransport(session: vitalsSession, endpoint: vitalsEndpoint, apiKey: config.appId,
                                    isKilled: { !TraceItX.captureGate || TraceItX.startEpochLockFree() != epoch })
                },
                scheduler: DispatchVitalsScheduler(),
                samplerFactory: { onSample, onTick in
                    ResourceSampler(now: { Int64(Date().timeIntervalSince1970 * 1000) }, onSample: onSample, onTick: onTick)
                },
                lifecycle: { fg, bg in
                    #if canImport(UIKit)
                    return VitalsLifecycleObserver(onForeground: fg, onBackground: bg)
                    #else
                    return nil
                    #endif
                }))
            // The epoch predicate is evaluated INSIDE install()'s critical section (round-2,
            // Critical 2); install() refuses and shuts the candidate down when it is false.
            VitalsRuntime.shared.install(vitalsController, startEpoch: epoch) { TraceItX.shared.currentStartEpoch == epoch }

            // Buttons, overlays, hotkeys, and TV remote combos remain
            // host-owned. Native iOS shake-to-report is observed through the
            // existing UIWindow event interception and consumes the same
            // `report.isPresenting` guard as host-owned trigger UI.

            // Phase 22-04 (VTREE-02): construct + arm the session-replay
            // coordinator. It fetches the remote per-app config (default-OFF,
            // fail-closed) and only spins up a CADisplayLink tick when replay is
            // ON + the sampling gate passes — no overhead when disabled.

            #if canImport(UIKit)
            // MAI meter Plan 2b-i. Resolved HERE, before the MainActor hop
            // below (but still outside the `await MainActor.run` closure), so
            // the UserDefaults read (and the CSPRNG mint on first launch)
            // never runs on the main thread. `String?` is Sendable, so
            // capturing the resolved value is safe; capturing the closure and
            // calling it inside the hop would not be. Kept inside this
            // `#if canImport(UIKit)` gate — its only use is inside it — so a
            // macOS host build (this package's `swift test` job) neither
            // leaves it unused nor pays a real `UserDefaults.standard` write
            // on every `start()`; `KillSwitchTests` alone calls `start()`
            // about 15 times.
            //
            // MAI meter Plan 2b-ii. Built HERE, before the MainActor hop, so
            // the closure the session keeps is already resolved and Sendable.
            // The closure itself reads UserDefaults per config fetch — cheap
            // (UserDefaults is memory-backed after first load) and off the main
            // thread, since the provider fetches from its own actor context.
            //
            // The client veto is applied by BUILDING NOTHING: `enabled: false`
            // returns a supplier that computes nothing and stores nothing.
            let installIdProvider = InstallIdentifier.makeSupplier(
                enabled: config.installIdentifierEnabled
            )

            await MainActor.run {
                // Round-2 review Finding F9: if kill() ran while this tail was
                // awaiting drainOutbox()/the test hook above, it already bumped
                // `_startEpoch` (synchronously, before this hop). Discard the
                // would-be install rather than arming a session built from the
                // now-killed config — construct nothing, call
                // enableIfConfigured() on nothing, start no refresh loop.
                TraceItX.shared.stateLock.lock()
                let stillCurrent = TraceItX.shared._startEpoch == epoch
                TraceItX.shared.stateLock.unlock()
                guard stillCurrent else { return }

                // Round-4 review Finding F16 / round-5 Finding F23: tear down
                // any PRIOR session before installing its replacement.
                // `start()` is explicitly supported multiple times (restart
                // / re-init with a different app config) — a superseding
                // start() that simply overwrote `_replaySession` left the
                // OLD session's initial/periodic refresh running (nothing
                // had ever cancelled it), free to apply ITS
                // captureBodies/breadcrumb config to the process-global
                // gates even after this new session (built from a possibly
                // different app's config) had already taken over.
                // `teardown()` (round-3 Finding F13, commit 7a047bdd) bumps
                // the old session's generation epoch synchronously and
                // cancels its tasks; it is idempotent, so this is harmless
                // even when `_replaySession` is nil (first start()) or
                // already torn down — including by the early F23 teardown
                // Task dispatched at the top of `start()` above, which is
                // expected to have already won this race in the common
                // case; this call is belt-and-suspenders for the case where
                // it hasn't run yet.
                TraceItX.shared._replaySession?.teardown()

                let session: ReplaySession
                if let factory = Self.__replaySessionFactoryForTesting {
                    session = factory(config)
                } else {
                    session = ReplaySession(
                        baseURL: IngestEndpoint.url,
                        apiKey: config.appId,
                        locallyDisabled: false,
                        // Round-6 review Finding F27: pass the EXACT epoch
                        // this install was just gated on above (`stillCurrent`),
                        // rather than letting the initializer's default
                        // re-read `currentStartEpoch` a moment later — ties
                        // this session's supersession check to the precise
                        // value that authorized its own install.
                        startEpoch: epoch,
                        installIdProvider: installIdProvider
                    )
                }
                TraceItX.shared._replaySession = session
                session.enableIfConfigured()
            }
            #endif

            Self.__heavyInitDidRun = true
        }

        stateLock.lock()
        _startTask = startTask
        stateLock.unlock()
    }

    /// Set or clear the self-declared user (`setUser`, spec 2026-08-12).
    ///
    /// **No-op while `captureGate` is closed — i.e. before `start()`, and
    /// after `kill()`.** The rule is the same one sentence on every platform:
    /// *`start()` begins a session with no user; call `setUser` after
    /// `start`.*
    ///
    /// External review, finding 2 (Serious). This gate is new; iOS used to
    /// store a pre-`start()` value unconditionally, and
    /// `docs/user-recognition.md` told integrators it was "kept
    /// unconditionally, used by the next report". That stopped being true the
    /// moment `start()` began clearing `_user` (a451dc74) — the value was
    /// stored and then silently discarded, so the documented behaviour and the
    /// shipped behaviour disagreed on exactly the ordering hazard that section
    /// exists to warn about, and iOS was the only platform keeping the
    /// "the platforms do not agree" framing alive.
    ///
    /// Closing the gap by dropping the call, rather than by making `start()`
    /// preserve a user set moments earlier, is deliberate: `start()` installs
    /// `_config`, which carries the SDK KEY — the project every subsequent
    /// report is uploaded to — so a preserved user is exactly the
    /// `start(A) → setUser(X) → start(B)` cross-project leak a451dc74 closed.
    /// It must never come back.
    ///
    /// Two independent enforcement points now hold the rule up — this gate,
    /// and `start()`'s unconditional clear — so neither one alone can quietly
    /// falsify the documented behaviour again. Matches Android's `setUser`
    /// (`TraceItX.kt`, gated the same way) and web's (`client.ts`, a no-op
    /// before `init`).
    ///
    /// Note this makes `gate closed ⟹ _user == nil` an invariant: `start()`
    /// and `kill()` both clear it, and nothing else can write while closed.
    public func setUser(_ user: TXUser?) {
        stateLock.lock(); defer { stateLock.unlock() }
        guard Self.captureGate else { return }
        _user = user
    }

    /// Install or clear the verified-identity token source (recognition spec
    /// 2026-08-06).
    ///
    /// Pass `.token(jwt)` for a one-shot string, or `.provider { … }` to be
    /// re-asked as the cached token nears expiry — the provider form is what
    /// spares a host from writing its own refresh timer. `nil` signs out and
    /// drops the cached token immediately, even mid-lifetime.
    ///
    /// **Unlike `setUser`, this IS a credential**: `setUser` stores an
    /// unverifiable label the app itself asserts, with nothing checking that
    /// the caller is telling the truth. `setIdentityToken` hands the SDK a
    /// signed JWT whose signature `the server identity-token verifier` verifies
    /// server-side, so reports captured under it carry a PROVEN identity
    /// rather than a self-declared one. Call this when the host backend can
    /// mint a short-lived identity token for the signed-in user; call
    /// `setUser` when it cannot and the app is just supplying a label.
    ///
    /// Unlike `setUser`, there is no capture-gate check here — the holder
    /// itself is safe to populate before `start()` (it decodes/caches
    /// in-memory only, does nothing network-visible until a report or
    /// breadcrumb is actually captured), and `start()`/`kill()` both clear it
    /// unconditionally regardless of when it was set, exactly like `_user`.
    public func setIdentityToken(_ source: IdentityTokenSource?) {
        // Independent review, round 15, Critical, then round 16 (codex
        // round 14) re-review — round 15 tried to discard captured evidence
        // on any CONFIRMED identity change (`.token`/`.provider` comparing
        // the new subject against the previous one), not just sign-out. The
        // re-review found that attempt itself produced three further
        // Criticals, all consequences of trying to infer "did the identity
        // actually change" reactively instead of through a real transition
        // barrier: (1) an already-open reporter keeps the PREVIOUS user's
        // screenshot/UI-tree regardless of what the ring buffers do, so a
        // Send tapped after the switch could still attribute stale captured
        // state to the NEW, now-verified identity; (2) the provider-form
        // comparison was a ONE-SHOT check tied to the FIRST warm attempt —
        // if that attempt failed/timed out, no later warm (e.g.
        // reporter-open's own `__warmIdentityToken()`) ever retried the
        // comparison, so a transient failure PERMANENTLY lost it; (3) even
        // the synchronous `.token` path calls `_identityHolder.set(source)`
        // (publishing the new identity) BEFORE the evidence wipe completes,
        // so a concurrent capture could observe the NEW subject alongside
        // the OLD evidence in the gap between the two.
        //
        // Ruling: narrow this to the part that is unambiguous and free of
        // all three findings. Sign-out (`nil`) is kept — see below for why
        // it alone is exempt. The inferred `.token`/`.provider` comparison
        // is REMOVED entirely, not patched again — findings (1) and (2) are
        // not artifacts of which trigger form is used (an open reporter's
        // baked-in state and a warm's own retry path are unrelated to
        // whether the comparison was synchronous or async), and a
        // synchronous-only fix for (3) alone would still leave (1) and (2)
        // live. A correct account-switch transition is a cross-cutting
        // design problem (reporter UI, replay lifecycle, holder,
        // concurrency) that needs an actual transition barrier this branch
        // does not have — not something to keep reactively patching at the
        // end of this branch. See the accepted-limitation documentation
        // below and in `the user-recognition contract` for what remains
        // exposed, and this comment's own closing note for what a proper
        // fix would need.
        //
        // Why sign-out alone stays sound: `nil` always resolves to
        // ANONYMOUS, never to a DIFFERENT verified identity — so even in
        // the identical race window (evidence published as gone/anonymous
        // before the wipe finishes, or an open reporter still holding stale
        // captured state), the worst outcome is a report that ships with
        // less evidence than expected, or no header at all. Nothing is ever
        // attributed to the WRONG verified person, which is the one outcome
        // this whole feature exists to prevent. That asymmetry is exactly
        // what findings (1)-(3) do not have for `.token`/`.provider`: there,
        // the race's worst case is Alice's evidence reaching the wire under
        // Bob's proven identity.
        _identityHolder.set(source)
        // Final whole-branch review, Critical 1 — the PROVIDER form used to
        // cache NOTHING on install: only `.token(jwt)` self-caches inside
        // `set()` above. `captureUserSnapshot()` reads the SYNCHRONOUS
        // `cachedSubject(now:)`, and `resolveIdentityHeader` short-circuits
        // on a `nil` captured subject BEFORE it ever calls `holder.get(now:)`
        // — so a cold cache was never warmed, and
        // `IdentityTokenHolder.currentSubject(now:)` (documented as exactly
        // this warm-up path) had ZERO production callers. The documented,
        // RECOMMENDED integration ("Use the provider form") therefore
        // stamped every capture anonymous, forever, with no error anywhere.
        if source == nil {
            // ACCEPTED LIMITATION (round 16) — everything BUT sign-out: an
            // account switch that installs a NEW, different verified
            // identity (calling `setIdentityToken` again with a `.token`/
            // `.provider` for a different person, without an intervening
            // `nil`) does NOT discard previously captured evidence. A
            // report submitted after such a switch can carry the PREVIOUS
            // user's breadcrumbs, logs, and network data under the NEW
            // user's verified identity. This predates this branch —
            // `setUser` has always permitted the identical raw-buffer
            // mixing for a self-declared, unverified label — what this
            // branch adds is the aggravation that the mixed-in identity is
            // now cryptographically VERIFIED rather than a string the app
            // merely asserted. Documented in `the user-recognition contract`;
            // not silently left as a gap.
            //
            // Round 17 (codex round 16) — sign-out's own discard is now
            // narrower too: it zeroizes breadcrumbs/logs/network
            // metadata/bodies only, no longer the replay buffer (see
            // `discardCapturedEvidenceForIdentityChange()`'s own doc
            // comment for why). Stated plainly, not implied: sign-out is
            // NOT a complete evidence boundary on its own — it clears the
            // credential and most evidence, but a buffered replay frame can
            // survive it. In practice this rarely matters, since nothing is
            // attributed to anyone until a NEW identity is installed, at
            // which point the account-switch residual above governs
            // regardless.
            discardCapturedEvidenceForIdentityChange()
        } else {
            __warmIdentityToken()
        }
    }

    /// Fire a detached warm of `_identityHolder`'s cache —
    /// `IdentityTokenHolder.currentSubject(now:)`, discarding its result;
    /// only the SIDE EFFECT of populating the cache matters to any caller of
    /// this function. Public — unlike `_identityHolder` itself — because
    /// `TraceItXReporterUI`'s `TXReporterPresenter` calls this from a
    /// SEPARATE module and `_identityHolder` is not part of `TraceItXKit`'s
    /// public surface, the same cross-module reason `__replayFreeze` above is
    /// public despite the double-underscore convention. NOT gated behind
    /// `canImport(UIKit)` — unlike `__replayFreeze` — because this has no
    /// UIKit dependency and staying reachable from plain `swift test` on
    /// macOS is what makes it directly testable at all.
    ///
    /// Two call sites (fix round 2, Critical 1 still not fully closed after
    /// round 1):
    ///   1. `setIdentityToken` above, on every non-nil install — covers the
    ///      FIRST token lifetime after a host calls this.
    ///   2. `TXReporterPresenter.openAndAwait()` (`TraceItXReporterUI`), at
    ///      reporter-open, alongside `__replayFreeze()` — covers a report
    ///      captured minutes/hours after install, once the cache from (1)
    ///      has long since aged past `IDENTITY_REFRESH_MARGIN`. Without this
    ///      second call site, `IdentityTokenHolder.cachedSubject(now:)` — the
    ///      SYNCHRONOUS read `captureUserSnapshot()` uses — reads `nil` the
    ///      instant the install-time warm's token ages inside the margin,
    ///      and NOTHING re-invokes the provider from then on:
    ///      `resolveIdentityHeader` short-circuits on a `nil` captured
    ///      subject before it ever reaches `holder.get(now:)`, so
    ///      `currentSubject(now:)` — the only thing that would re-ask the
    ///      provider — is never called again. A provider-form host therefore
    ///      worked for exactly one token lifetime (at most 10 minutes) per
    ///      `setIdentityToken` call, then went permanently anonymous,
    ///      silently.
    ///
    /// Reporter-open is real time BEFORE the Send tap and off the capture's
    /// own critical path — the same rationale `__replayFreeze()` documents
    /// for freezing the replay buffer there. It does NOT cover the crash
    /// path (`CrashReporter.captureFacts`): a crash captures synchronously,
    /// with no "opening" moment to warm ahead of, and this SDK deliberately
    /// carries no periodic re-warm timer (see the identity guard's
    /// documented no-timer posture). A provider-form host's crash reports
    /// therefore remain anonymous once the last warm (install or a prior
    /// reporter-open) has aged past the margin. Documented in
    /// `the user-recognition contract`, not silently left as a gap.
    ///
    /// `setIdentityToken` (and therefore this, when called from there) MUST
    /// stay synchronous — host code calls it from ordinary, non-async call
    /// sites — so this fires an unstructured, detached `Task` rather than
    /// suspending the caller.
    ///
    /// Independent review, Serious 3 — gated on `isIdentityEnabled` before
    /// EVER invoking the provider. The unconditional version of this
    /// function broke the guarantee the whole `identity.enabled` gate exists
    /// for ("a project with no signing secret never calls the customer's
    /// endpoint"): installing a provider fired the host's auth/network work
    /// for every project, including ones that will never present a header,
    /// and cached a subject a subsequent capture could persist into the
    /// outbox even though identity is off for that project. The check reads
    /// `currentReplayConfig()` — the SAME live config every submit path
    /// already agrees on — INSIDE the detached Task, so `__warmIdentityToken`
    /// itself stays synchronous; if config hasn't settled yet (pre-`start()`,
    /// or before the first fetch completes) that resolves the fail-closed
    /// `.off` default, so the warm simply skips rather than waiting or
    /// invoking anything — no wait, no timer, matching this branch's
    /// standing no-timer decision. A later warm (the next `setIdentityToken`
    /// call, or the next reporter-open) picks it up once config is live.
    /// Independent review, round 19 (codex round 17), Serious — reading
    /// `currentReplayConfig()` here used to be able to observe PROJECT A's
    /// live config even after `start(projectB)` had already begun: A's
    /// `_replaySession` (what `currentReplayConfig()` falls back to) is torn
    /// down ASYNCHRONOUSLY (see the `Task { @MainActor in TraceItX.shared
    /// ._replaySession?.teardown() }` inside `start()` above), so a
    /// `setIdentityToken(.provider)` racing `start(projectB)` could see A's
    /// `identity.enabled == true` and invoke B's provider even though B has
    /// identity disabled — breaking the guarantee this branch has now
    /// defended three separate times ("a project with no signing secret
    /// never triggers customer authentication or network work").
    ///
    /// Fix: consult `_identityEnabledFlag` instead — the SAME flag
    /// `captureUserSnapshot()` (this file, above) already reads instead of
    /// `currentReplayConfig()`, for the identical reason (the live config
    /// is not synchronously reachable there either). Reusing it here closes
    /// this from the SAME single source of truth rather than adding a
    /// fourth mechanism, and removes the pre-existing oddity where capture
    /// and the warm answered "is identity enabled?" from two different
    /// places. `start()`/`kill()` reset this flag SYNCHRONOUSLY, in the
    /// very first `stateLock` critical section — before `_config` is even
    /// installed, and long before the async session teardown above — so any
    /// read of this flag once `start(projectB)` has begun observes AT WORST
    /// `false` (never A's stale `true`); it only flips back to `true` once
    /// B's OWN `refreshConfigNow()` independently confirms B's config says
    /// enabled, via `IdentityEnabledFlag.set(_:guard:)`'s own epoch guard
    /// (round 11's P1(b) fix) — a stale write from A's superseded session
    /// cannot land after that guard re-checks the epoch atomically at the
    /// write.
    ///
    /// Checked the other two `currentReplayConfig()`-for-enablement call
    /// sites (`ReportSubmitter.swift`, `ReporterSubmission.swift`'s mirror)
    /// for the identical hazard: both are independently protected by a
    /// SEPARATE, synchronous epoch check (`currentEpoch() ==
    /// epochAtInitiation`) bracketing the read, which `start()`'s epoch
    /// bump — synchronous, same critical section as this flag's own reset —
    /// closes regardless of any staleness in `currentReplayConfig()` itself.
    /// `__warmIdentityToken()` has no such per-call epoch to check against
    /// (it warms whatever project is live right now, not a specific
    /// captured entry), which is why it alone needed this fix.
    public func __warmIdentityToken() {
        let holder = _identityHolder
        let identityEnabledFlag = _identityEnabledFlag
        // Mirrors `captureUserSnapshot()`'s own precedence exactly (see that
        // function's doc comment): `__replayConfigOverrideForTesting` first,
        // falling back to the flag. Reading the flag ALONE broke every
        // existing test that arms "identity enabled" via the override
        // (`IdentityProviderWarmTests.swift` et al.) rather than by driving
        // a real `ReplaySession.refreshConfigNow()` — the override is
        // exactly what `_identityEnabledFlag` does NOT observe, since it is
        // only ever written by that real config-apply path. Both halves of
        // this decision (capture-time stamping and the warm) must keep
        // agreeing on the same source, in the same order, or they drift
        // again exactly as the flag's own introduction was written to
        // prevent.
        let override = __replayConfigOverrideForTesting
        Task.detached(priority: .utility) {
            // Test-only seam (round 19, codex round 17) — see
            // `__warmIdentityTokenPreReadHookForTesting`'s own doc comment.
            // `nil` in production: no added delay, the read proceeds
            // immediately.
            await TraceItX.__warmIdentityTokenPreReadHookForTesting?()
            let identityEnabled = override.map(isIdentityEnabled) ?? identityEnabledFlag.get()
            guard identityEnabled else { return }
            _ = await holder.currentSubject(now: Date())
        }
    }

    /// Test-only seam (round 19, codex round 17) — when set,
    /// `__warmIdentityToken()`'s detached `Task` awaits this closure
    /// immediately BEFORE reading `_identityEnabledFlag`
    /// /`__replayConfigOverrideForTesting`, so a test can force a
    /// `start()`/`kill()` racing the warm to land BEFORE that read is
    /// taken, deterministically, rather than hoping real scheduler
    /// interleaving happens to hit the exact window on demand. This is the
    /// same category of parking hook this branch already uses elsewhere for
    /// races that are real but too narrow to reproduce reliably by racing
    /// real threads (e.g. `ReplaySession`'s `preApplyHookForTesting`).
    /// `nil` in production — the read proceeds immediately with no added
    /// delay. `nonisolated(unsafe)`, matching `__heavyInitDidRun`/
    /// `__replayTimelineOverrideForTesting` above: a plain global only ever
    /// written by test setup/teardown on the test's own thread, never
    /// concurrently with itself.
    nonisolated(unsafe) internal static var __warmIdentityTokenPreReadHookForTesting: (() async -> Void)?

    public func setMetadata(_ metadata: [String: Any]) {
        stateLock.lock(); defer { stateLock.unlock() }
        _metadata = metadata
    }

    // MARK: - Sticky attachments (consumed by next report.open())

    /// Set host-supplied free-form metadata for the next report. Truncated
    /// at `EXTRA_MAX_CHARS` (16384) on write. Each call REPLACES the previous
    /// value (not merge — `extra` is a single string, not a bag). Auto-cleared
    /// after the next `report.open()` resolves; explicit `clearExtra()` is
    /// also available. Pass an empty string or call `clearExtra()` to detach.
    public func setExtra(_ value: String) {
        stateLock.lock(); defer { stateLock.unlock() }
        _pendingExtra = String(value.prefix(Self.EXTRA_MAX_CHARS))
    }

    /// Wipe the pending `extra` value without opening a report.
    public func clearExtra() {
        stateLock.lock(); defer { stateLock.unlock() }
        _pendingExtra = nil
    }

    /// Extra-resolver ask-and-wait seam (spec 2026-09-17 setExtra-resolver —
    /// RN parity with the resolver form of `setExtra` @traceitx/sdk-core and
    /// @traceitx/web already have). `nil` for every pure-native host, and
    /// for an RN host that has never registered a resolver via JS
    /// `setExtra(() => ...)` — `__consumePendingAttachments()` then costs
    /// nothing extra beyond the nil check below. The RN bridge
    /// (`TraceItXBridge.configure`) installs a non-nil implementation once;
    /// that implementation itself no-ops immediately (no event, no wait)
    /// unless a resolver is CURRENTLY registered — see its own doc comment
    /// for why this stays a per-call decision rather than a push made at
    /// registration time.
    ///
    /// `async`, non-throwing (`() async -> Void`) so the bounded wait
    /// SUSPENDS rather than blocks, and so "fail open" holds BY
    /// CONSTRUCTION — there is no throw path for
    /// `__consumePendingAttachments()` to swallow. Both existing callers
    /// (`TXReporterPresenter.openAndAwait`, `CompanionCaptureBridge
    /// .handleReportRequest`) already run inside an `async` context.
    ///
    /// `nonisolated(unsafe)` mirrors `__warmIdentityTokenPreReadHookForTesting`
    /// above: a plain global, written once by `TraceItXBridge.configure`
    /// and never concurrently with itself.
    nonisolated(unsafe) public static var __pendingExtraResolveHook: (@Sendable () async -> Void)?

    /// Async-safe mutual exclusion for the ask-and-wait + drain sequence
    /// (review finding F5). `NSLock` can't be held across an `await` (see
    /// `drainPendingAttachmentsLocked()`'s own doc comment on
    /// `__consumePendingAttachments()`), and this needs to guard a span
    /// that includes one — an `actor` is Swift's async-safe equivalent.
    ///
    /// WHY THIS EXISTS: without it, two reports racing
    /// `__consumePendingAttachments()` concurrently (e.g. the in-app modal
    /// reporter and the phone-companion capture path, both funnelling
    /// through this seam) can each suspend in the hook at once — JS then
    /// answers BOTH out of band via the single-slot `_pendingExtra` plus a
    /// separate correlation-id ack (`signalExtraResolverReady`), with no
    /// guarantee the ack order matches the `setExtra()` write order
    /// relative to which caller's drain runs next. Concretely: A and B both
    /// ask; JS answers A (`setExtra(X)`) then B (`setExtra(Y)`, overwriting
    /// X) before either resumes; whichever drains first gets Y, not X, and
    /// the other gets nil. Serialising means at most one ask-and-wait (and
    /// its matching drain) is ever in flight, so `_pendingExtra`
    /// unambiguously belongs to the sole outstanding request when it is
    /// read.
    private actor ExtraResolveSerializer {
        private var isLocked = false
        private var waiters: [CheckedContinuation<Void, Never>] = []

        func acquire() async {
            if !isLocked {
                isLocked = true
                return
            }
            await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
                waiters.append(cont)
            }
        }

        func release() {
            if waiters.isEmpty {
                isLocked = false
            } else {
                waiters.removeFirst().resume()
            }
        }

        /// D2 fix. `acquire()`/`release()` used to be called separately by
        /// `__consumePendingAttachments()`, with `release()` reached only on
        /// the straight-line path — nothing throws there TODAY, but any
        /// future early return or throw added between the two (e.g. a new
        /// guard clause in that method's ask-and-wait body) would leak the
        /// lock permanently: `acquire()` suspends on a non-cancellable
        /// `withCheckedContinuation`, so every subsequent report would hang
        /// in it forever, and fail-open — the entire point of this
        /// feature — would be gone. Kotlin's `withLock` on the Android twin
        /// is already `finally`-safe; this is the Swift-structural
        /// equivalent.
        ///
        /// `defer` cannot itself contain `await` (a hard Swift limitation —
        /// defer blocks always run synchronously, even inside an `async`
        /// function), which is exactly why the old call site couldn't just
        /// wrap its own `await ...release()` in a `defer { }`. The fix is to
        /// move the `defer` INSIDE the actor: a call to `release()` made
        /// from `self`, within the actor's own isolation domain, is an
        /// ordinary synchronous same-actor call and needs no `await` — only
        /// callers OUTSIDE the actor (e.g. `TraceItX.__consumePendingAttachments`)
        /// must `await` it. That makes `defer { release() }` legal here, and
        /// it fires on every exit from `body` — normal return, or a throw —
        /// with no way for a future edit to `body` to bypass it. Callers now
        /// go through this one entry point instead of pairing `acquire()`/
        /// `release()` by hand, which is what makes forgetting the release
        /// structurally impossible rather than merely unlikely.
        func withLock<T>(_ body: () async throws -> T) async rethrows -> T {
            await acquire()
            defer { release() }
            return try await body()
        }
    }

    private static let extraResolveSerializer = ExtraResolveSerializer()

    /// Drop a host-supplied marker into the action-timeline chain (spec §5).
    /// Unknown/omitted kind strings coerce to `.custom`; unknown levels are
    /// dropped (not defaulted); never throws. Redaction-passed and size-capped
    /// exactly like automatic crumbs — routes straight through
    /// `BreadcrumbRingBuffer.shared.add`, which already honors the kill gate
    /// (DEFE-03) and the live config gate (Task 1's wire), so this is a no-op
    /// pre-start and while killed with no extra checks needed here.
    public func addBreadcrumb(
        message: String, kind: String? = nil, level: String? = nil, data: [String: Any]? = nil
    ) {
        let resolvedKind = kind.flatMap(BreadcrumbKind.init(rawValue:)) ?? .custom
        let resolvedLevel = level.flatMap(Level.init(rawValue:))
        let resolvedData = data.map(BreadcrumbRingBuffer.coerceHostData)
        BreadcrumbRingBuffer.shared.add(
            kind: resolvedKind, message: message, level: resolvedLevel, data: resolvedData)
    }

    /// Record a screen appearance — the framework-agnostic navigation marker
    /// (spec 2026-07-14). Feeds the SAME global from→to chain as the
    /// UIKit `viewDidAppear` auto-capture. Primary consumer today is the RN
    /// bridge (`useTXScreen` / `recordScreen` on JS); native SwiftUI hosts
    /// can call it from `.onAppear` (a `.txScreen()` modifier is a planned
    /// follow-up). `name` should be a route identifier, never user content.
    /// Blank names are dropped. No-op if captureGate is closed (pre-start /
    /// killed) or while the `navigation` kind is disabled — mirrors the
    /// Android twin (`TraceItX.recordScreen`). `from`/`to` win over `data`
    /// keys on collision.
    public func recordScreen(_ name: String, data: [String: Any]? = nil) {
        guard captureGate else { return }
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        #if canImport(UIKit)
        NavigationBreadcrumbAdapter.recordTransition(toName: name, hostData: data)
        #endif
    }

    /// Session Vitals (iOS spec 2026-09-05): attach a player integration. Returns a
    /// handle even when vitals are off, not yet started, or killed — the registration is
    /// honoured the moment a controller is installed. Use `trackPlayer(_ player: AVPlayer,
    /// name:)` for AVPlayer; implement `PlayerIntegration` for anything else.
    public func trackPlayer(_ integration: PlayerIntegration, name: String? = nil) -> PlayerHandle {
        VitalsRuntime.shared.trackPlayer(integration, name: name)
    }

    /// Session Vitals: a customer-fed log line on the session timeline, ≤ 2 KB serialised
    /// (truncated, never dropped). The player-scoped form routes through the HANDLE, which
    /// alone knows whether its registration is still live (Android round-3, Important 11).
    public func trackVitals(_ name: String, data: Any? = nil, player: PlayerHandle? = nil) {
        if let player { player.track(name, data: data); return }
        VitalsRuntime.shared.current()?.trackVitals(name, data: data, playerId: nil)
    }

    /// Attach a React-fiber tree (as JSON-encoded `ReactTree`).
    ///
    /// NO LONGER SHIPPED. UI-tree capture and tap-to-identify are gone (spec
    /// 2026-08-29): the envelope no longer declares tree fields, the
    /// in-process reporter presenter drains this slot into `_`, and the
    /// companion bridge also discards it at request time.
    /// Whatever is attached here is consumed once and discarded — it never
    /// reaches `payload.reactTree` or any other part of the report.
    ///
    /// Retained (with `detachReactTree()` and `__consumePendingAttachments()`)
    /// purely so the consume-once drain keeps its contract for the pairing
    /// flow, and so a pure-native host that still calls this keeps compiling.
    @available(
        *, deprecated,
        message: "The attached tree is no longer shipped in any report — it is drained and discarded. Remove the call."
    )
    public func attachReactTree(_ json: Data) {
        stateLock.lock(); defer { stateLock.unlock() }
        _pendingReactTreeJSON = json
    }

    /// Detach without opening a report.
    public func detachReactTree() {
        stateLock.lock(); defer { stateLock.unlock() }
        _pendingReactTreeJSON = nil
    }

    /// Drain pending attachments. Returns the snapshot and clears state in a
    /// single critical section so two concurrent reports can't both consume.
    /// `public` only because the reporter UI lives in a separate SwiftPM
    /// product (`TraceItXReporterUI`) and can't see internal symbols. Treat
    /// as private — the `__` prefix marks it as an SDK seam; production
    /// callers use `report.open()` which drains via this method.
    public func __consumePendingAttachments() async -> (extra: String?, reactTreeJSON: Data?) {
        // No hook installed (pure-native host, or an RN host before its
        // bridge configures) — drain immediately, exactly as before this
        // feature landed. Never touches `extraResolveSerializer`.
        guard let hook = Self.__pendingExtraResolveHook else {
            return drainPendingAttachmentsLocked()
        }
        // Serialise the ask-and-wait + drain sequence (finding F5's fix —
        // see `extraResolveSerializer`'s own doc comment for why) so at
        // most one correlation id is ever outstanding, and this call's
        // drain unambiguously reads back what THIS call's hook invocation
        // asked for.
        //
        // D2 fix: acquire/body/release go through `withLock` (see its own
        // doc comment) rather than being paired by hand here, so a future
        // early return or throw added to this closure still releases the
        // serializer instead of leaking it.
        return await Self.extraResolveSerializer.withLock {
            // Ask-and-wait BEFORE the critical section below (spec
            // 2026-09-17 setExtra-resolver) — deliberately OUTSIDE
            // `stateLock`: the RN hook's JS answer path re-enters this
            // object's public surface (`setExtra`), and `stateLock` is a
            // plain `NSLock`, not reentrant.
            await hook()
            // `NSLock.lock()`/`.unlock()` are `NS_SWIFT_UNAVAILABLE_FROM_ASYNC`
            // — calling them directly inside an `async` function is a
            // warning today and an error under the Swift 6 language mode.
            // Draining is itself purely synchronous, so it lives in its own
            // ordinary (non-async) method; calling a sync method FROM async
            // code is always fine, only the direct `.lock()`/`.unlock()`
            // syntax inside an async body is not.
            return drainPendingAttachmentsLocked()
        }
    }

    /// Synchronous drain — see `__consumePendingAttachments()`'s doc comment
    /// for why this is split out.
    private func drainPendingAttachmentsLocked() -> (extra: String?, reactTreeJSON: Data?) {
        stateLock.lock(); defer { stateLock.unlock() }
        let extra = _pendingExtra
        let tree = _pendingReactTreeJSON
        _pendingExtra = nil
        _pendingReactTreeJSON = nil
        return (extra, tree)
    }

    #if canImport(UIKit)
    /// 04-03 passthrough: forward to SensitiveRectRegistry.mark so hosts can
    /// flag arbitrary UIView instances as sensitive without importing the
    /// internal capture module. Wired here per the B2-residual single-writer
    /// invariant (plan 04-03 ships the registry; plan 04-06 wires the public
    /// passthrough).
    @MainActor
    public func markSensitive(_ view: UIView) {
        SensitiveRectRegistry.mark(view)
    }

    // MARK: - Session-replay seams (Phase 22-04, VTREE-02)
    //
    // The reporter presenter (TraceItXReporterUI module) and the submit path
    // (this module) drive the replay lifecycle through these `__`-prefixed
    // seams on the singleton — same indirection as `__resolver` /
    // `__setPresenting`, avoiding a TraceItX → ReporterUI dependency cycle.
    // No-op when replay was never armed (config OFF / pre-start).

    /// Freeze the replay buffer the INSTANT the reporter opens — call this BEFORE
    /// the reporter UIWindow mounts (capture-before-reporter ordering). Stops the
    /// sampling tick so the reporter UI is never recorded. Also freezes the
    /// breadcrumb ring buffer (Task 6) so the reporter's own actions (taps,
    /// navigation) never pollute the chain that ships with THIS report — same
    /// capture-before-reporter ordering, own seam so a breadcrumb hiccup can
    /// never block the replay freeze above it.
    // SAFETY: BreadcrumbRingBuffer.freeze()/discardAndResume()/takeFrozen() are
    // non-throwing by design; if the buffer ever gains a throwing path, wrap
    // these in their own guard so breadcrumbs can never block the replay seam
    // or a report.
    @MainActor
    public func __replayFreeze() {
        _replaySession?.freezeForReporter()
        BreadcrumbRingBuffer.shared.freeze()
        // Network-body freeze (network-body-capture spec): same
        // capture-before-reporter ordering as breadcrumbs above — stop
        // accepting the live chain into what THIS report will ship the
        // instant the reporter opens. Non-throwing by design, same as the
        // BreadcrumbRingBuffer seams.
        NetworkBodyRingBuffer.shared.freeze()
    }

    /// Consume only this session's frozen video; reporter stays paused until close.
    @MainActor
    internal func __replayCompleteVideo() async -> NativeVideoClaim? {
        let session = _replaySession
        return await session?.completeVideoForSubmit()
    }

    /// Called after the reporter window is removed, including successful Send.
    @MainActor
    public func __replayReporterDidClose() {
        _replaySession?.cancelForReporter()
    }

    /// Reporter cancel/close: discard the frozen window, resume a fresh buffer.
    /// Also discards the frozen breadcrumb snapshot (Task 6) so a
    /// cancelled/closed reporter doesn't leave a stale freeze sitting under
    /// the next report — live capture resumes immediately, same as replay.
    // SAFETY: BreadcrumbRingBuffer.freeze()/discardAndResume()/takeFrozen() are
    // non-throwing by design; if the buffer ever gains a throwing path, wrap
    // these in their own guard so breadcrumbs can never block the replay seam
    // or a report.
    @MainActor
    public func __replayCancel() {
        _replaySession?.cancelForReporter()
        BreadcrumbRingBuffer.shared.discardAndResume()
        // Network-body cancel (network-body-capture spec): mirror
        // BreadcrumbRingBuffer above — drop the frozen snapshot so a
        // cancelled/closed reporter doesn't leave a stale freeze sitting
        // under the next report; live capture resumes immediately.
        NetworkBodyRingBuffer.shared.discardAndResume()
    }
    #endif

    /// DEFE-03 emergency switch. Idempotent; synchronous. Stops further capture
    /// by flipping the gate; outbox drain attempt is detached.
    ///
    /// COST, with Session Vitals in use (documented rather than restructured — whole-branch
    /// review O3): this tears every tracked player down on the CALLING thread. The built-in
    /// AVPlayer integration detaches synchronously, so the cost is negligible; a custom
    /// `PlayerIntegration` whose `detach(onComplete:)` hops to its player's own thread makes
    /// this call block for that teardown plus up to `VitalsController.detachDrainTimeoutMs`
    /// (250 ms). Calling `kill()` on the main thread with such an integration registered can
    /// therefore block the main thread for up to 250 ms. A superseding `start()` carries the
    /// same cost, for the same reason.
    public func kill() {
        // Companion capture is bound to an EPOCH, not just to this boolean.
        // `kill()` lowers the gate and `start()` raises it again, so a capture
        // suspended across both never observes `false` and would carry on
        // streaming under the pre-kill request. Bumping the epoch cannot be
        // undone by a later start().
        CompanionAuthEpoch.invalidate()

        // Round-2 review Finding F9: bump the start epoch FIRST, synchronously,
        // before anything else below — this is what closes the race window for
        // a start() Task still parked mid-tail (e.g. in `await drainOutbox()`):
        // once this epoch bump lands, that tail's later MainActor install
        // check will see a stale epoch and discard itself instead of arming a
        // session built from the config we're about to kill. Also cancel the
        // retained task handle directly (belt-and-suspenders — see
        // `_startTask`'s doc comment for why the epoch guard, not cancellation,
        // is the primary defense).
        //
        // Round-8 review Finding F39: verified `kill()` does NOT have
        // `start()`'s window-(b) ordering gap (see that method's doc
        // comment) — the epoch bump here already happens FIRST, strictly
        // before `NetworkBodyCaptureGate.shared.reset()` below, so no
        // reordering was needed. `start()` was the one that had
        // `reset()`/`clear()` running before the epoch bump.
        stateLock.lock()
        let killEpoch = bumpStartEpoch()
        // Monotonic and never lowered — this is what makes a revocation
        // survive a later start() that re-opens `captureGate`.
        _killGeneration &+= 1
        let taskToCancel = _startTask
        _startTask = nil
        // External review, finding 2 (Serious): clear the self-declared user
        // (`setUser`, spec 2026-08-12) here, inside the SAME `stateLock`
        // critical section that owns it — same GDPR/kill-switch posture the
        // ring-buffer zeroization below is done under ("so nothing captured
        // before the kill can ship afterward"), applied to host-supplied PII
        // (id / email / display name) that is at least as sensitive.
        //
        // Not merely a posture point: restart after kill is explicitly
        // supported (`KillSwitchTests.startAfterKillReenablesCapture`), and
        // `_user` survived it — so `start → setUser(A) → kill → start →
        // report` attributed the NEW session's report to A with no `setUser`
        // call anywhere in it. The crash path had the same exposure, since
        // `CrashReporter` reads the same `currentUser`.
        //
        // Parity with Android, which has always cleared `_user` inside
        // `kill()`'s own `stateLock.withLock` block alongside `_config`
        // (TraceItX.kt), and with web (sdk-core `client.ts` kill(), which
        // now clears `state.user` next to `state.identityToken.set(null)`).
        _user = nil
        // Native identity Task 4 — clear the verified-identity token in the
        // SAME critical section as `_user = nil` immediately above, same
        // GDPR/kill-switch posture as the ring-buffer zeroization below
        // ("nothing captured before the kill can ship afterward") applied to
        // a server-verified credential rather than a self-declared label.
        // `IdentityTokenHolder.set` takes its OWN lock, never `stateLock`, so
        // this cannot deadlock or invert lock ordering.
        _identityHolder.set(nil)
        // Independent review, round 10, P1 — `set(nil)` above already bumps
        // `generation`, which alone keeps a NEW caller from ever joining a
        // stale in-flight provider call, but does nothing to STOP one
        // already running: before this, a hung/never-resolving provider
        // (accumulating one abandoned task per timeout, since reporter-open
        // warms repeat) had no way to be reached by the kill switch at all.
        // `cancelOutstandingWork()` delivers the actual cancellation signal
        // to whatever is currently tracked in `_identityHolder`'s own
        // single-flighted task. Must land in the SAME stateLock critical
        // section as `set(nil)` for the identical reason that call is here:
        // `IdentityTokenHolder` takes its own lock, never `stateLock`, so
        // this cannot deadlock or invert lock ordering. Kotlin twin:
        // TraceItX.kt kill() -> `_identityHolder.cancelOutstandingWork()`.
        _identityHolder.cancelOutstandingWork()
        // Independent review, round 4 (Serious 3) — same reasoning as
        // start()'s reset above: a killed session's "identity was enabled"
        // reading must not survive.
        _identityEnabledFlag.set(false)
        stateLock.unlock()
        taskToCancel?.cancel()

        // Fix round 3 residual hygiene — unlike every other piece of session
        // state, this public test-only override was not cleared by kill():
        // a value left set (a forgotten test cleanup, or any future misuse)
        // would silently override the fail-closed `.off` default for EVERY
        // submit path across a kill()/re-start() cycle. Mirrors the
        // identical Android fix (TraceItX.kt kill()).
        __replayConfigOverrideForTesting = nil

        Self.captureGate = false
        // GDPR/kill-switch posture parity with web (sdk-core client.ts kill()):
        // zeroize every capture-evidence ring buffer (breadcrumbs, network
        // metadata, network bodies, log lines) — both live entries and any
        // frozen snapshot held for an in-flight reporter — so nothing
        // captured before the kill can ship afterward. Extracted into
        // `clearCapturedEvidenceBuffers()` (round 15) so
        // `setIdentityToken`'s account-switch discard can apply the
        // IDENTICAL zeroization to a LIVE session — see that function's own
        // doc comment.
        Self.clearCapturedEvidenceBuffers()
        // Final-review Finding 1 (post-kill capture) / Finding 3
        // (process-lifetime sampling): deactivate the network-body gate and
        // restore its boot-time defaults, INCLUDING the one-shot sampling
        // draw — see NetworkBodyCaptureGate.reset()'s doc comment for why a
        // kill()/start() cycle must not inherit the old process's draw.
        // Synchronous — NetworkBodyCaptureGate is its own NSLock, not
        // MainActor-isolated — so this closes the race window immediately,
        // before the async replay-session teardown below even starts.
        NetworkBodyCaptureGate.shared.reset()
        // Session Vitals: zeroize the recent ring, detach every tracked player and drop
        // queued declarations older than this kill (its evidence contract). The transport
        // is already silenced by `captureGate` + the epoch mirror, so the final-summary
        // send this triggers is a no-op on the wire. OUTSIDE stateLock (customer detach()).
        // Guarded on THIS kill's epoch: a stale kill tail must not tear down — or clear the
        // gate of — a session a newer start() has already installed (round-4, #2/#4).
        let stillThisKill: () -> Bool = { TraceItX.shared.currentStartEpoch == killEpoch }
        VitalsRuntime.shared.shutdown(dropPending: true, ifCurrent: stillThisKill)
        VitalsServerConfigBox.shared.publish(nil, ifCurrent: stillThisKill)
        ShakeToReportTrigger.shared.teardown(ifCurrent: stillThisKill)
        // 04-04: uninstall stderr intercept and restore the original FD so the
        // host's stderr pipeline returns to baseline. Idempotent.
        LogCapture.uninstall()
        // Host-owned triggers manage their own lifecycle. The SDK-owned mobile
        // shake gate was synchronously disarmed above before replay teardown.
        #if canImport(UIKit)
        // Final-review Finding 1: tear down the replay session so its
        // periodic config-refresh loop (ReplaySession
        // .startPeriodicRefreshLoop(), ~300s cadence) stops re-arming the
        // network-body gate after a kill. `_replaySession` is MainActor-
        // isolated (kill() itself must stay synchronous per its documented
        // contract), so the teardown + nil-out is dispatched via a
        // `Task { @MainActor }` hop rather than done inline.
        //
        // Round-3 review Finding F13: nil'ing the reference and waiting on
        // `ReplaySession.deinit` is NOT sufficient by itself — an in-flight
        // `refreshConfigNow()` `await` holds its own strong `self`
        // reference for as long as its network call is outstanding, so
        // `deinit` can run arbitrarily late (well after a stale fetch has
        // already resolved and tried to re-arm the global network-body
        // gate off a dead session's config). Call `teardown()` explicitly
        // first — it bumps the session's generation epoch synchronously,
        // which `refreshConfigNow()` re-checks immediately before any
        // global apply, closing that window regardless of when `deinit`
        // eventually fires. Safe to call on a MainActor-isolated
        // `ReplaySession` from this hop; idempotent, so harmless even if
        // `deinit` also runs it implicitly afterward.
        Task { @MainActor in
            TraceItX.shared._replaySession?.teardown()
            TraceItX.shared._replaySession = nil

            // Codex round-2 fix — `start()`'s session-boundary reset (this
            // file, alongside `_user = nil`/`_identityHolder.set(nil)`)
            // already clears `CompanionBadgeServerConfigBox` so a new app
            // never inherits the previous one's dashboard-configured
            // companion-badge override; `kill()` had no twin, so an
            // override delivered before kill() (e.g. `enabled: true` over
            // an inline `false`, or a position override) survived a kill()
            // indefinitely even though the companion client keeps running
            // by design and the config machinery that delivered the
            // override is now dead. Placed AFTER the teardown/nil-out
            // immediately above (its periodic refresh loop is what would
            // otherwise keep re-delivering the override) so no NEW refresh
            // can be armed afterward; an in-flight refresh that already
            // passed `refreshConfigNow()`'s epoch check is handled by that
            // function's own pre-write re-check (see its doc comment), not
            // by ordering here.
            CompanionBadgeServerConfigBox.shared.value = nil

            // Branding (iOS spec 2026-08-26): kill()'s twin of the start()
            // clear above; placed after teardown for the same reason, and an
            // in-flight refresh is handled by refreshConfigNow()'s own
            // pre-write epoch re-check.
            BrandingServerConfigBox.shared.value = nil
        }
        #endif
    }

    /// Independent review, round 15 — the GDPR/kill-switch zeroization
    /// `kill()` already applies to these four evidence buffers, extracted
    /// here so `setIdentityToken`'s account-switch path
    /// (`discardCapturedEvidenceForIdentityChange()` below) can apply the
    /// IDENTICAL zeroization to a LIVE session, without tearing the session
    /// down and rebuilding it the way `kill()` does. Also closes a
    /// pre-existing gap discovered while wiring this: `LogRingBuffer` (the
    /// log lines `LogCapture`/`StderrIntercept` accumulate) was the ONE
    /// evidence buffer `kill()` itself never zeroized — every other buffer
    /// already had this posture; this one was simply missed until now.
    ///
    /// Deliberately does NOT touch: replay (round 17/codex round 16 removed
    /// the one caller that used to zeroize it on sign-out specifically,
    /// after that call produced two further Serious findings — see
    /// `discardCapturedEvidenceForIdentityChange()`'s own doc comment below
    /// for the full account) or `NetworkBodyCaptureGate`'s sampling/config
    /// state (an identity change
    /// must not re-roll the one-shot sampling draw for whoever is now
    /// signed in — that draw is a process-lifetime decision, unrelated to
    /// who the current user is).
    private static func clearCapturedEvidenceBuffers() {
        BreadcrumbRingBuffer.shared.clear()
        NetworkBodyRingBuffer.shared.clear()
        NetworkRingBuffer.shared.clear()
        LogRingBuffer.shared.clear()
        // Report Resource Window (spec 2026-09-05, fix round 1 IMPORTANT 2)
        // — this ring was the one sibling NOT zeroized here, so up to
        // `windowSec` of pre-kill/pre-sign-out CPU/memory samples could
        // survive into the next session's first report, breaking the
        // documented contract every OTHER buffer in this function honours:
        // nothing captured before the kill/sign-out can ship afterward.
        ResourceRingBuffer.shared.clear()
    }

    /// Independent review, round 15, Critical — an account switch
    /// (`setIdentityToken` resolving a DIFFERENT verified subject than the
    /// one this holder previously represented) used to retain every piece
    /// of capture evidence from the PREVIOUS identity — replay, breadcrumbs,
    /// logs, network bodies — and let the NEW, now-verified identity submit
    /// it.
    ///
    /// Zeroizes ONLY the four evidence buffers, via
    /// `clearCapturedEvidenceBuffers()` above — lock-guarded per buffer,
    /// thread-agnostic, callable from whatever thread `setIdentityToken`
    /// happens to run on (an ordinary auth callback is very often a
    /// background thread).
    ///
    /// Round 16 (codex round 14) re-review — narrowed this mechanism to run
    /// ONLY from `setIdentityToken`'s `nil` (sign-out) branch, having
    /// previously also been reached by inferring an identity CHANGE from
    /// `.token`/`.provider`; that inference produced three further
    /// Criticals and was removed — see `setIdentityToken`'s own doc
    /// comment.
    ///
    /// Round 17 (codex round 16) re-review — this used to ALSO zeroize the
    /// replay buffer via `ReplaySession.forceDiscardForIdentityChange()`
    /// (`lifecycle.forceDiscard()` immediately followed by an attempt to
    /// resume buffering), dispatched via `Task { @MainActor in ... }`. Two
    /// further Serious findings, both consequences of that one call:
    /// (1) `forceDiscard()` unconditionally flipped a FROZEN lifecycle (an
    /// open reporter) back to buffering and restarted the `CADisplayLink`
    /// tick WHILE reporter chrome was on screen — capturing reporter UI
    /// into the next report, and leaving the open reporter's own pending
    /// submit/cancel to no-op against a lifecycle that was no longer
    /// frozen; (2) the Android twin of this same call held its equivalent
    /// of `stateLock` while synchronously driving the main-thread-confined
    /// `ReplaySession` from whatever thread `setIdentityToken` happened to
    /// run on. Removed outright, not patched again — a correct fix needs
    /// the same transition barrier and open-reporter handling already
    /// deferred for the account-switch residual below, not a third
    /// reactive patch to this one call site. `ReplayLifecycle.forceDiscard()`
    /// itself is untouched (still exercised by its own tests) — only
    /// `ReplaySession`'s identity-triggered wrapper around it was removed,
    /// since nothing else called it.
    ///
    /// ACCEPTED LIMITATION, honestly stated (see
    /// `the user-recognition contract`): sign-out no longer discards
    /// buffered REPLAY frames either — only breadcrumbs/logs/network
    /// metadata/bodies are zeroized. In practice this rarely matters: the
    /// credential is cleared immediately, so nothing is attributed to
    /// anyone until a NEW identity is installed, at which point the
    /// already-accepted account-switch residual (this same file's
    /// `setIdentityToken` doc comment) governs regardless of whether
    /// sign-out ever ran in between.
    private func discardCapturedEvidenceForIdentityChange() {
        Self.clearCapturedEvidenceBuffers()
    }

    public let report = ReportAPI()

    /// Phase 06.2-07 — Phone-companion reporter state surface.
    ///
    /// Hosts read `state` (`.unpaired | .paired | .reportInProgress | .phoneDisconnected`)
    /// and `pairUrl` to render a QR / connection indicator. SDK ships zero QR
    /// or indicator chrome (SPEC §3; host-rendered chrome is the Phase 05.1
    /// precedent). Internal state mutation flows through `RelayWSClient` (the
    /// only writer) via the `__setState` / `__setPairUrl` seams on `CompanionAPI`.
    ///
    /// The relay WS connection is NOT auto-started here — autostart is wired
    /// in `start(config:)` gated on `config.enableCompanion == true` (Plan
    /// 06.2-07 Task 2). Pre-autostart, the property exists and reads return
    /// the default `.unpaired` state.
    public let companion = CompanionAPI()
}

public final class ReportAPI: ObservableObject, @unchecked Sendable {
    /// Triggers reporter overlay; returns when user submits or cancels.
    /// Wired in plan 04-06 to TXReporterPresenter.openAndAwait() via the
    /// runtime-injected resolver below — this keeps TraceItX.swift independent
    /// of the TraceItXReporterUI module (which depends on TraceItX).
    public func open() async throws -> ReportResult {
        if let resolver = ReportAPI.__resolver {
            return try await resolver()
        }
        throw NotImplementedError.openInPlan04_06
    }

    /// Set by TraceItXReporterUI at module-load (or by tests) to provide the
    /// async/await reporter implementation. Avoids a hard dependency from
    /// TraceItX → TraceItXReporterUI (which would create a dependency cycle).
    public nonisolated(unsafe) static var __resolver: (() async throws -> ReportResult)?

    // MARK: - Phase 05.1 — report.isPresenting observation surface
    //
    // Hosts can observe whether the reporter is currently on screen via two
    // surfaces (D-02):
    //   1. Combine `@Published var isPresenting` — SwiftUI / Combine consumers
    //      use `@ObservedObject private var report = TraceItX.shared.report`
    //      and read `report.isPresenting`, or subscribe to `report.$isPresenting`.
    //   2. `Notification.Name.traceItXReporterPresentingChange` — non-Combine
    //      consumers subscribe via NotificationCenter; userInfo carries
    //      `["isPresenting": Bool]` for the new value.
    //
    // Single-writer invariant: the only writer is `TXReporterPresenter` (in
    // the TraceItXReporterUI module), via the `__setPresenting` slot below.
    // The slot indirection mirrors `__resolver` and prevents a TraceItX →
    // TraceItXReporterUI dependency cycle (per RESEARCH Pattern 1 / Pitfall 1).

    /// Read-only public surface; flipped by TXReporterPresenter via
    /// `__performSetPresenting(_:)`. The didSet guards on oldValue != newValue
    /// so identical-value writes do not duplicate-post the notification.
    @Published public private(set) var isPresenting: Bool = false {
        didSet {
            guard oldValue != isPresenting else { return }
            NotificationCenter.default.post(
                name: .traceItXReporterPresentingChange,
                object: self,
                userInfo: ["isPresenting": isPresenting]
            )
        }
    }

    /// Lambda slot populated by TXReporterPresenter.installResolver() (mirrors
    /// the existing `__resolver` indirection). Avoids the TraceItX →
    /// TraceItXReporterUI dependency cycle. Single-writer-from-presenter
    /// invariant — hosts must NEVER assign to this directly.
    public nonisolated(unsafe) static var __setPresenting: (@Sendable (Bool) -> Void)?

    /// Public-but-internal helper that performs the actual private(set) write
    /// on the singleton's `report.isPresenting`. The presenter's
    /// `__setPresenting` lambda hops to MainActor and calls this. Lives on
    /// ReportAPI (rather than the presenter) because `isPresenting` is
    /// `private(set)` — only ReportAPI can write to it.
    public static func __performSetPresenting(_ value: Bool) {
        TraceItX.shared.report.isPresenting = value
    }
}

public extension Notification.Name {
    /// Posted on every flip of `TraceItX.shared.report.isPresenting`.
    /// userInfo: `["isPresenting": Bool]`. Subscribe via NotificationCenter
    /// for non-Combine consumers (UIKit-only hosts, Objective-C bridges).
    static let traceItXReporterPresentingChange =
        Notification.Name("com.scriptx.traceitx.reporterPresentingChange")
}

enum NotImplementedError: Error {
    case openInPlan04_06
}
