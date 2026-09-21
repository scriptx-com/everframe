// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Public singleton entry point for the TraceItX Android SDK.
//
// File-ownership timeline:
//   • 05-01 — skeleton (lock state placeholders, captureGate, report stub)
//   • 05-02 — start() / kill() / setUser / markSensitive bodies + captureGate flip
//             + resolver-indirection slots for Plans 03/04/05/06/07
//   • 05-03 — markSensitive(view) body wired to SensitiveRectRegistry
//   • 05-06 — atomic Wave-N integration of 05-03/04/05 subsystems via standalone
//             module APIs. SINGLE Wave-N writer to TraceItX.kt.
//
// Design contract (mirrors iOS Plan 04 — synchronous start, heavy work deferred):
//   • start() returns in <5ms; heavy I/O runs on a coroutine dispatcher (Dispatchers.IO)
//   • State mutations are guarded by a single ReentrantLock — fast, lock-free reads
//     aren't worth the actor-isolation cost given start() is called once per launch
//   • Every public API wraps body in `txGuardVoid("apiName") { ... }` per DEFE-02 —
//     a TraceItX bug never crashes the host (T-05-02-T disposition: accept; T-05-02-E
//     mitigation: stateLock+@Volatile captureGate)
//
// NOTE: `R.id.tx_sensitive` is declared by Plan 05-03 in
// `:traceitx-core/src/main/res/values/ids.xml` (single-writer invariant — Plan 03
// is the sole writer of that resource file). Plan 02's `markSensitive` is a no-op
// stub until Plan 05-03 replaces the body with `SensitiveRectRegistry.markView(view)`.

package com.traceitx

import android.content.Context
import android.view.View
import androidx.annotation.VisibleForTesting
import com.traceitx.capture.BreadcrumbAdapters
import com.traceitx.capture.BreadcrumbRingBuffer
import com.traceitx.capture.BreadcrumbTapNavAdapters
import com.traceitx.capture.LogCapture
import com.traceitx.capture.NavigationBreadcrumbAdapter
import com.traceitx.capture.NetworkBodyCaptureState
import com.traceitx.capture.replay.ReplaySession
import com.traceitx.capture.video.FrozenReportCapture
import com.traceitx.capture.video.OwnedVideoClip
import com.traceitx.capture.sharedBreadcrumbBuffer
import com.traceitx.capture.sharedLogBuffer
import com.traceitx.capture.sharedNetworkBodyBuffer
import com.traceitx.capture.sharedNetworkBuffer
import com.traceitx.capture.sharedResourceBuffer
import com.traceitx.config.ConfigValidator
import com.traceitx.config.IngestEndpoint
import com.traceitx.config.ReplayConfig
import com.traceitx.config.ReportResult
import com.traceitx.config.isIdentityEnabled
import com.traceitx.config.TXUser
import com.traceitx.config.TraceItXConfig
import com.traceitx.protocol.generated.BreadcrumbKind
import com.traceitx.protocol.generated.Level
import com.traceitx.envelope.txGuardSuspend
import com.traceitx.envelope.txGuardVoid
import com.traceitx.identity.IdentityTokenHolder
import com.traceitx.identity.IdentityTokenSource
import com.traceitx.identity.decodeIdentityClaims
import com.traceitx.outbox.CrashSidecar
import com.traceitx.outbox.JSONLOutbox
import com.traceitx.shared.SharedData
import com.traceitx.transport.ReportSubmitter
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

object TraceItX {

    /**
     * Semver of the Android SDK; embedded into every envelope's `sdk.version`.
     * Sourced from `BuildConfig.SDK_VERSION`, which is generated from the
     * `traceitxVersion` Gradle property (see `gradle.properties` /
     * `traceitx-core/build.gradle.kts`). Single source of truth — bump the
     * property to bump the constant; no source edits needed at release time.
     *
     * Not `const val` because `BuildConfig.SDK_VERSION` is a Java static
     * final from a different file, which Kotlin doesn't allow in `const`
     * initializers. The bytecode is still a static-field read; no perf cost.
     */
    @JvmField
    val SDK_VERSION: String = BuildConfig.SDK_VERSION

    // ---------------- State (ReentrantLock-protected) ----------------

    private val stateLock = ReentrantLock()
    private var _config: TraceItXConfig? = null
    private var _user: TXUser? = null

    /**
     * Holds the verified-identity token (recognition spec 2026-08-06),
     * in-memory only. Its own type ([com.traceitx.identity.IdentityTokenHolder])
     * rather than a raw string here, because it also owns the decode/expiry/
     * generation logic — see that file's header. [captureUserSnapshot] below
     * reads its SYNCHRONOUS `cachedSubject(nowMs:)`, never the `suspend
     * get(nowMs:)`, because a capture boundary must not block on a provider.
     *
     * Native identity Task 7 (Kotlin twin of iOS Task 3) wired this field and
     * the capture-time read below. Native identity Task 8 (Kotlin twin of iOS
     * Task 4) adds the public [setIdentityToken] API and wires `start()`/
     * `kill()` to clear it (mirroring `_user`'s clear) — see both call sites
     * below.
     *
     * `internal`, not `private` — `TraceItXIdentityTokenTest` (in this
     * module's `src/test` source set) needs to reach it directly to prove
     * `start()`/`kill()` actually clear it (its `start clears the identity
     * token` / `kill clears the identity token` cases), the same seam shape
     * as [_replaySession] above and [IdentityTokenHolder]'s own Swift twin
     * (`internal let _identityHolder` on iOS, for the identical
     * `@testable import` reason). `start()` and `kill()` both clear it
     * (`_identityHolder.set(null)`) in the SAME `stateLock` critical section
     * that clears `_user` — a token surviving a project switch is the
     * identical cross-tenant hazard `_startEpoch` exists to prevent, now
     * applied to a bearer credential instead of a self-declared label.
     */
    internal val _identityHolder = IdentityTokenHolder()

    /**
     * Re-review gap (post round-4 F16, commit 4a2411cc): monotonically
     * increasing generation counter, bumped under [stateLock] by BOTH
     * [start] and [kill]. `start()`'s heavy-init coroutine captures the
     * epoch current at entry (inside the same lock critical section that
     * flips `captureGate`/`_config`) and, in the `start.replay` block,
     * re-checks under `stateLock` — immediately before installing a
     * [com.traceitx.capture.replay.ReplaySession] — that the epoch is
     * STILL current. `kill()` bumps this synchronously, before anything
     * else in its own critical section, so a `start()` tail still
     * in-flight (e.g. still constructing its `ReplaySession`, or parked in
     * [__startTailDelayHookForTesting]) discards its would-be install
     * instead of arming a session built from a config `kill()` already
     * tore down. Mirrors iOS `TraceItX._startEpoch` (commit 826e5f76).
     *
     * Plain `var` guarded by the existing `stateLock` (not
     * `AtomicInteger`) — every read/write site is already inside a
     * `stateLock.withLock` block, matching how the rest of this object's
     * state (`_config`, `_user`, ...) is protected.
     */
    private var _startEpoch: Int = 0

    /**
     * Lock-free mirror of [_startEpoch] — see [currentStartEpochVolatile] for
     * why it exists and when it may be read. Written ONLY from inside a
     * [stateLock] critical section, immediately after the field it mirrors,
     * so the two can never disagree for a reader that takes the lock.
     */
    private val _startEpochMirror = java.util.concurrent.atomic.AtomicInteger(0)

    /**
     * Monotonic revocation counter, bumped ONLY by [kill] under [stateLock].
     *
     * Separate from [_startEpoch] because three situations look identical to
     * that counter and want different answers: `start(B)` alone (the crash
     * still belongs to A and must reach A), `kill()` alone (nothing may ship),
     * and `kill()` then `start(B)` (the gate is open again, but the revocation
     * happened after the capture). Only a counter `start()` never touches can
     * express the third.
     *
     * Deliberately NOT `CompanionAuthEpoch`, which has the right shape but is
     * also bumped when a companion session ends (`companion/RelayWSClient.kt`)
     * — reusing it would discard crashes on an unrelated event.
     */
    private var _killGeneration: Long = 0
    private val _killGenerationMirror = java.util.concurrent.atomic.AtomicLong(0)

    /**
     * Application context retained across `start()`. Task 12 (RN
     * `requestOutboxDrain`) needs a `Context` to construct `JSONLOutbox` /
     * `CrashSidecar` from a call site that has none of its own (the RN
     * bridge has no Activity/Context handle by the time a non-fatal JS
     * error is reported). `@Volatile` mirrors `captureGate`'s bare-read
     * contract — set once (application context, not Activity) inside
     * `start()`'s `stateLock` critical section, read lock-free thereafter.
     */
    @Volatile
    private var appContext: Context? = null

    /** Shared drain facade. Independent reporter/crash facades share its canonical-root coordinator.
     * Kill retains this reference until its generation has been invalidated and retired.
     */
    @Volatile
    private var sharedOutbox: JSONLOutbox? = null

    @Volatile private var pendingOutboxRevocation: JSONLOutbox? = null
    @Volatile private var unresolvedOutboxRevocationContext: Context? = null
    private val outboxRevocationLock = Any()

    /** Store construction and revocation never wait for storage under stateLock. */
    private fun sharedOutboxFor(ctx: Context): JSONLOutbox {
        while (true) {
            finishOutboxRevocation()
            sharedOutbox?.let { return it }
            val candidate = JSONLOutbox(ctx.applicationContext)
            val installed = stateLock.withLock {
                sharedOutbox ?: candidate.takeIf { it.store.hasCurrentLease() }?.also { sharedOutbox = it }
            }
            // A kill may retire the candidate between construction and installation. Rebuild
            // outside stateLock instead of caching that permanently stale facade after restart.
            if (installed != null) return installed
        }
    }

    /** A Context facade must join an unresolved kill before it can expose the old root. */
    internal fun registerOutboxForPendingRevocation(outbox: JSONLOutbox) = stateLock.withLock {
        if (unresolvedOutboxRevocationContext != null) {
            outbox.store.invalidateSync()
            pendingOutboxRevocation = outbox
            sharedOutbox = outbox
            unresolvedOutboxRevocationContext = null
        }
    }

    private fun finishOutboxRevocation() = synchronized(outboxRevocationLock) {
        try {
            // Constructor failure leaves the unresolved Context retained for the next attempt.
            // The constructor registers/invalidate its facade before it can escape to any caller.
            val pending = pendingOutboxRevocation ?: unresolvedOutboxRevocationContext?.let {
                JSONLOutbox(it)
                pendingOutboxRevocation
            } ?: return@synchronized
            pending.store.revokeSync()
            stateLock.withLock {
                if (pendingOutboxRevocation === pending && !pending.store.isRevocationPending()) {
                    pendingOutboxRevocation = null
                    if (sharedOutbox === pending) sharedOutbox = null
                }
            }
        } catch (_: Exception) {
            // Bounded, secret-free diagnostic. Pending remains poisoned and a later start retries.
            android.util.Log.w("TraceItX", "Outbox revocation incomplete; durable revocation may be unavailable")
        }
    }

    /**
     * Max chars for `extra` — anything longer is truncated. A deliberate
     * ceiling sized against its siblings (a single breadcrumb message is
     * 2048 chars) and generous enough that hosts should not need to trim;
     * matches the cross-SDK ceiling (raised from 2000 to 16384 chars / 16
     * KiB — the 2000 figure had no storage or ingest justification).
     */
    const val EXTRA_MAX_CHARS: Int = 16384

    /**
     * Sticky host-supplied free-form metadata. Single opaque string —
     * callers JSON.stringify nested data themselves. Consumed and cleared
     * on next report.open().
     */
    private var _pendingExtra: String? = null
    /** Sticky React-fiber walk JSON. Consumed and cleared on next report.open(). */
    private var _pendingReactTreeJson: String? = null

    /**
     * false = capture disabled (kill switch active OR pre-start). The capture
     * pipeline (Plans 03/04/05) reads this gate before each capture cycle.
     * Mirrors iOS `nonisolated(unsafe) static var captureGate`.
     */
    @Volatile
    @JvmStatic
    var captureGate: Boolean = false
        internal set

    /** Read-only snapshot of the current config (null before start()). */
    val currentConfig: TraceItXConfig?
        get() = stateLock.withLock { _config }

    /** Read-only snapshot of the current user. */
    val currentUser: TXUser?
        get() = stateLock.withLock { _user }

    /**
     * Snapshot the self-declared user TOGETHER with the session it belongs to,
     * in ONE [stateLock] critical section.
     *
     * External review, finding 1 (Serious) — see `TXCapturedUser.kt`'s file
     * header for the full defect. In short: the submit paths snapshot the user
     * at the Send tap, but read the CONFIG (which carries the SDK key, i.e. the
     * destination project) later, asynchronously. A `start(projectB)` landing
     * in between uploaded project A's user under B's key. Capturing the user
     * and [_startEpoch] atomically here, and re-checking the epoch at
     * envelope-assembly time ([resolveCapturedUser]), makes a captured user
     * valid ONLY for the session it was captured in.
     *
     * The two fields must be read under one acquisition: two separate reads
     * could straddle a `start()` and produce a snapshot claiming A's user
     * belongs to B's session — a pairing worse than either read alone.
     *
     * Native identity Task 7 — the identity subject joins this same critical
     * section as a third field, for the identical reason: the report being
     * captured now must be bound to whichever identity was active AT THIS
     * INSTANT, not whichever is active when the (asynchronous, possibly
     * minutes-later) submit finally runs. [IdentityTokenHolder.cachedSubject]
     * is synchronous — it reads the holder's already-resolved cache and never
     * suspends on a provider — so this function keeps its <5ms, non-blocking
     * contract. A cold cache (no token yet fetched) resolves `null`, stamping
     * the report anonymous; that is the fail-closed direction, not a bug.
     */
    @JvmStatic
    fun captureUserSnapshot(): TXCapturedUser =
        stateLock.withLock {
            // Independent review, round 4 (Serious 3) — the stamp itself
            // must respect the SAME `identity.enabled` gate the live submit
            // boundary already consults (`resolveIdentityHeader`'s
            // `isIdentityEnabled` check), not just withhold the header
            // later while still persisting the raw subject onto a queued
            // entry. Without this, an entry captured while identity is OFF
            // for the project could attach a header on a LATER drain if the
            // project's identity setting flips on and the subjects happen
            // to match — same inconsistency shape as the round-4 epoch fix.
            // `currentReplayConfig()` is a plain synchronous read here
            // (unlike iOS, `_replaySession` is stateLock-guarded, not
            // MainActor-isolated — see that field's own doc comment), so no
            // separate synchronous mirror is needed the way iOS's
            // `_identityEnabledFlag` is.
            val identitySubject = if (isIdentityEnabled(currentReplayConfig())) {
                _identityHolder.cachedSubject(System.currentTimeMillis())
            } else {
                null
            }
            TXCapturedUser(
                user = _user,
                startEpoch = _startEpoch,
                identitySubject = identitySubject,
            )
        }

    /**
     * The counterpart read: [TXCapturedUser.user] iff its session is STILL the
     * installed one, `null` otherwise (degrade to anonymous — never attribute
     * to the wrong person or the wrong project).
     *
     * Backs [TXCapturedUser.resolve]; kept here because [_startEpoch] and its
     * lock live here. `internal` — callers resolve through the snapshot.
     */
    internal fun resolveCapturedUser(captured: TXCapturedUser): TXUser? =
        stateLock.withLock { if (captured.startEpoch == _startEpoch) captured.user else null }

    /**
     * The user, the config and the revocation counter in ONE [stateLock]
     * critical section — see [TXCapturedSession]. The crash path's entry read;
     * other callers keep using [captureUserSnapshot].
     *
     * Merge note (native-identity x captured-session): this must compute
     * `identitySubject` the SAME way [captureUserSnapshot] above does —
     * gated on the identity-enabled flag and read from
     * `_identityHolder.cachedSubject(nowMs:)` — and in this SAME `stateLock`
     * critical section, not a later, separate read. Reading it apart from
     * `user`/`startEpoch` would reopen the exact non-atomicity
     * [TXCapturedUser] exists to remove: a `setIdentityToken`/`start()`/
     * `kill()` landing between two separate reads could pair one instant's
     * user with a different instant's identity subject.
     */
    @JvmStatic
    fun captureSessionSnapshot(): TXCapturedSession =
        stateLock.withLock {
            // Same gate + read as `captureUserSnapshot()` above, and for the
            // identical reason — see that function's own comment.
            val identitySubject = if (isIdentityEnabled(currentReplayConfig())) {
                _identityHolder.cachedSubject(System.currentTimeMillis())
            } else {
                null
            }
            TXCapturedSession(
                user = TXCapturedUser(user = _user, startEpoch = _startEpoch, identitySubject = identitySubject),
                config = _config,
                killGeneration = _killGeneration,
                captureConsent = captureGate,
            )
        }

    /** Snapshot lock order: capture coordinator -> state/authorization lock, then release
     * state before reading ancillary rings. Ring guards use only the volatile start epoch.
     * Start/kill reserve their epoch under this same coordinator. */
    private val reportCaptureCoordinator = Any()

    /** Shared late-start authorization lock. Callbacks enqueue prepared calls only;
     * never reach the outbox/store, perform disk/codec work, or await HTTP here.
     * Durable adapters must acquire their store coordinator before this lock. */
    internal fun <T> withReportAuthorizationLock(block: () -> T): T = stateLock.withLock(block)

    /** A captured report's monotonic kill permit, unaffected by later starts. */
    internal fun killGenerationChanged(since: Long): Boolean =
        stateLock.withLock { _killGeneration != since }

    /**
     * The current revocation generation, monotonically bumped by [kill] (and
     * never by [start]).
     *
     * Codex round-4, #2 — `VitalsRuntime` TAGS every queued registration with
     * this value, so a delayed `kill()` tail can revoke exactly the
     * declarations made for the session it is ending, whatever else has
     * happened in between: an entry queued before the bump is revoked by
     * whichever of {that kill tail, the next install} reaches the queue
     * first, and an entry queued after it survives to the next `start()`.
     * Replaces `VitalsRuntime`'s own counter, which could only be bumped when
     * the kill tail actually ran and therefore mis-classified whatever was
     * queued in between.
     *
     * The read takes `stateLock` while the caller holds `VitalsRuntime`'s
     * monitor — the one nesting direction that already exists there (see
     * `VitalsRuntime.install`'s predicate); nothing takes them the other way
     * round.
     */
    internal fun killGenerationChangedVolatile(since: Long): Boolean = _killGenerationMirror.get() != since

    internal fun currentKillGeneration(): Long = stateLock.withLock { _killGeneration }

    /**
     * Has ANY `start()` or `kill()` run since [sinceStartEpoch] was captured?
     *
     * Follow-ups item 9, second round. Distinct from [killGenerationChanged]:
     * that one asks "was this revoked" and stops the report; this one asks
     * "is the session still the one this report belongs to" and only causes
     * the caller to drop the sections it can no longer vouch for — the LIVE
     * process-global log and network buffers. See [TXCapturedSession.isSuperseded].
     *
     * Same `stateLock` read as [resolveCapturedUser]'s epoch comparison, for
     * the same reason: the epoch must not be read while `start()` is midway
     * through installing a new session.
     */
    internal fun startEpochChanged(sinceStartEpoch: Int): Boolean =
        stateLock.withLock { _startEpoch != sinceStartEpoch }

    /**
     * Synchronous, `stateLock`-protected read of [_startEpoch]. Final
     * whole-branch review, Important 2 — lets a live-submit call site prove,
     * WITHOUT an `await`, that no superseding `start()`/`kill()` has run
     * since a [TXCapturedUser] was captured, the same guard
     * [resolveCapturedUser] already applies for the self-declared user.
     * Mirrors iOS `TraceItX.currentStartEpoch`.
     */
    internal fun currentStartEpoch(): Int = stateLock.withLock { _startEpoch }

    /**
     * Codex round-3, Important 7 — a LOCK-FREE mirror of [_startEpoch],
     * written under [stateLock] at every one of that field's write sites and
     * read without any lock at all.
     *
     * It exists for exactly one caller shape: a predicate evaluated from
     * inside another subsystem's lock, on a thread that must never block on
     * SDK teardown. `VitalsTransport.isKilled` is that predicate — it runs
     * under `VitalsCollector`'s lock, on a player's own thread or on the
     * vitals sampler thread, at every send boundary. Routing it through
     * [currentStartEpoch] meant a flush could park behind a `start()`/`kill()`
     * critical section (which itself runs customer teardown before and after
     * it), turning the collector's documented enqueue-only, never-blocking
     * send contract into a lock-order hazard: the crash handler's 100 ms
     * `tryLock` stamp then times out against a collector lock held by a
     * blocked flush, and a crash report ships with no vitals at all.
     *
     * Monotonic, so a lock-free read can only ever be STALE-LOW by the width
     * of one `stateLock` critical section, which makes it fail-closed for
     * this use: a transport whose epoch no longer matches is silenced, and a
     * read that has not yet observed the newest bump lets at most one more
     * chunk out under the key it was actually collected for. Use
     * [currentStartEpoch] wherever the epoch must be read ATOMICALLY WITH
     * other [stateLock] state ([resolveCapturedUser], [captureSessionSnapshot],
     * the `start.replay` install) — this is not a replacement for it.
     */
    internal fun currentStartEpochVolatile(): Int = _startEpochMirror.get()

    /**
     * Codex round-6, #1 — take the previous session's [ReplaySession] for
     * teardown, but ONLY while [epoch] is still the newest start.
     *
     * `start()` reserves its epoch, then reaches this point after a stretch
     * of work it does not control. `start(B)` descheduled here long enough
     * for `start(C)` to run to completion — install included — used to
     * remove and tear down **C's** session on its way past, because the
     * critical section that cleared `_replaySession` checked nothing. C then
     * lost replay for the rest of its life, and with it the coordinator that
     * publishes every subsequent vitals configuration update; B's own
     * publication re-check (further down `start()`) refused far too late to
     * undo that.
     *
     * This is the same predicate `stillNewest` expresses, taken INSIDE the
     * critical section that mutates the field rather than beside it: a
     * `start(C)` that publishes after a separate check answered true is
     * ordered behind this whole section, so B either takes a session that is
     * genuinely its own to tear down, or takes nothing at all.
     *
     * `@VisibleForTesting` because the window it closes sits between two
     * points inside `start()`'s synchronous body with no seam between them —
     * a test drives the decision here instead.
     */
    @androidx.annotation.VisibleForTesting
    internal fun takeSupersededReplay(epoch: Int): ReplaySession? = stateLock.withLock {
        if (_startEpoch != epoch) return@withLock null
        val previous = _replaySession
        _replaySession = null
        previous
    }

    /**
     * Test-only seam for Important 7: runs [block] while holding [stateLock],
     * so a test can prove that a collector send path completes while the
     * start/kill critical section is occupied. Never called in production.
     */
    internal fun <T> __withStateLockForTesting(block: () -> T): T = stateLock.withLock { block() }

    /** Coroutine scope for detached heavy init work. Cancelled on kill(). */
    internal val sdkScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /**
     * Register before kill can snapshot children; run work only after releasing stateLock.
     * Stored-route drains survive ordinary restart, so their authority is the captured kill
     * generation. Identity warming additionally requires its originating start to remain current.
     */
    private fun launchCapturedWork(captured: TXCapturedSession, requireCurrentStart: Boolean = false,
        block: suspend CoroutineScope.() -> Unit) {
        val job = stateLock.withLock {
            if (_killGeneration != captured.killGeneration ||
                (requireCurrentStart && _startEpoch != captured.user.startEpoch)) null
            else sdkScope.launch(start = CoroutineStart.LAZY, block = block)
        }
        job?.start()
    }

    // ---------------- Start-tail race test seam (re-review gap, mirrors iOS
    // __startTailDelayHookForTesting, commit 826e5f76) ----------------

    /**
     * Test-only seam. When set, `start()`'s heavy-init tail invokes this hook
     * inside the `start.replay` block — right after building the candidate
     * `ReplaySession` and before the `stateLock`-guarded [_startEpoch]
     * recheck that decides whether to install it. This lets a test hold the
     * tail open long enough to interleave a `kill()` call deterministically:
     * production heavy-init work (breadcrumb/log/tap-nav install, an empty
     * outbox drain) is not guaranteed to take long enough to hit the real
     * race window reliably otherwise. `null` in production — the tail
     * proceeds straight through with no added delay.
     *
     * Deliberately a BLOCKING `() -> Unit`, not `suspend () -> Unit`: the
     * `start.replay` block has no suspension point between epoch capture and
     * install (that's exactly why the guard has to be a generation check —
     * see [_startEpoch]'s doc comment — a `kill()`'s `sdkScope`
     * `cancelChildren()` cannot cooperatively cancel this coroutine here). A
     * `suspend` hook parked on e.g. a `CompletableDeferred.await()` would be
     * a genuine suspension point and WOULD respond to that same
     * `cancelChildren()` call, silently changing what the test exercises. A
     * test implementation should block the real `Dispatchers.IO` thread
     * (e.g. `CountDownLatch.await()`) to faithfully model "no suspension
     * point here" — mirrors `ReplaySessionSupersessionTest`'s fetcher-latch
     * pattern for the same reason.
     */
    @VisibleForTesting
    internal var __startTailDelayHookForTesting: (() -> Unit)? = null

    /** Null in production; preserves every captured start input in facade orchestration tests. */
    internal var __replaySessionFactoryForTesting: ((Context, TraceItXConfig, Int, Boolean, () -> String?) -> ReplaySession)? = null

    /** Deterministic test seam after immutable drain capture and before coroutine dispatch. */
    internal var __beforeDrainLaunchForTesting: (() -> Unit)? = null

    /** Test-only reset for the start-tail delay hook. Production code does not call this. */
    @VisibleForTesting
    internal fun __resetStartTailDelayHookForTesting() {
        __startTailDelayHookForTesting = null
        __replaySessionFactoryForTesting = null
        __beforeDrainLaunchForTesting = null
    }

    /**
     * Test-only seam: set [_config] directly, WITHOUT running [start]'s
     * async heavy-init tail (log capture install, breadcrumb adapters,
     * outbox drain, replay-session install...) or requiring a real
     * `Context`. Mirrors how iOS `start(config:)` sets its own `_config`
     * synchronously before any async work — Android's [start] does the same
     * under [stateLock], but always requires a `Context` and always kicks
     * off that async tail, so specs that only need [currentConfig] populated
     * (e.g. `ReplaySession.refreshConfigNow()`'s network-body-capture-gate
     * `locallyDisabled` computation, round-5 review Finding F22) use this
     * instead of paying for/coordinating around the tail. Production code
     * never calls this.
     *
     * **It cannot simulate a session change.** It writes [_config] and nothing
     * else — it bumps neither [_startEpoch] nor [_killGeneration]. A spec that
     * reached for it to drive the epoch rule ([resolveCapturedUser]) or the
     * revocation rule ([killGenerationChanged]) would assert nothing: every
     * snapshot taken around it keeps matching. Exercising either rule requires
     * a real [start] / [kill].
     */
    @VisibleForTesting
    internal fun __setConfigForTesting(config: TraceItXConfig?) {
        stateLock.withLock { _config = config }
    }

    // ---------------- Public API (every body wrapped in txGuardVoid) ----------------

    /**
     * Synchronous start. Returns in <5ms on real devices (RESEARCH carry-forward
     * from Phase 04 Pitfall 5). Heavy work (log capture install, outbox drain,
     * trigger install) runs on `sdkScope` (Dispatchers.IO).
     *
     * Throws [com.traceitx.config.TraceItXConfigError] on bad config — surfaces
     * synchronously past the txGuardVoid because validation failures are a
     * caller contract violation, not an SDK bug. Implementation: ConfigValidator
     * throws BEFORE the txGuard{} body runs (validate is called at the top so
     * the exception escapes). DEFE-02 still applies to the heavy-init coroutine.
     */
    /**
     * @param currentActivity The Activity already on screen when `start()`
     * runs, for hosts that start the SDK AFTER their first Activity exists
     * (React Native starts from JS; some native hosts start from
     * `Activity.onCreate`). Without it the live Activity's Window is never
     * wrapped and tap breadcrumbs are silently absent for the whole session —
     * `onActivityCreated` has already fired. Held only via WeakReference
     * across the heavy-init hop; safe to omit when starting from
     * `Application.onCreate` (the canonical integration), where no Activity
     * exists yet.
     */
    @JvmStatic
    @JvmOverloads
    fun start(context: Context, config: TraceItXConfig, currentActivity: android.app.Activity? = null) {
        // Validation runs OUTSIDE txGuard — bad config is a host contract violation,
        // we want the exception to surface to the caller's host app for early-fail
        // visibility (mirrors iOS `try ConfigValidator.validate(config)` at line 84).
        ConfigValidator.validate(config)

        // Initialize SharedData with the host app context (assets reader).
        SharedData.init(context)

        // Crash admission is part of start()'s synchronous contract. RN calls
        // captureException from a child effect immediately after its provider's
        // configure() returns, so waiting for BreadcrumbAdapters.install() in
        // detached heavy init can silently reject that first capture while the
        // reporter's separately held context is still null. Context setup is a
        // volatile application-context assignment only; lifecycle observers and
        // the uncaught-exception handler remain in the detached install below.
        com.traceitx.crash.CrashReporter.configure(context.applicationContext)

        // State mutation guarded by stateLock; gate flip is the kill switch contract.
        // Re-review gap: bump _startEpoch in the SAME critical section and
        // capture the resulting value — this is the epoch the heavy-init
        // coroutine below will re-check (under stateLock) immediately before
        // installing its ReplaySession. See _startEpoch's doc comment.
        //
        // Round-5 review Finding F23 — `start(A) -> start(B)` is NOT a safe
        // app/session boundary by itself: the rest of this block
        // synchronously overwrites `_config`/re-opens `captureGate`/changes
        // the submit key, but WITHOUT the four lines below, A's
        // `NetworkBodyCaptureState` (including its STICKY sampling draw —
        // see that object's file header), A's buffered request/response
        // bytes, and A's refresh-owning `ReplaySession` all stayed live —
        // the body ring buffer was never cleared at ALL, and the old
        // `ReplaySession` kept running until the async `start.replay` block
        // eventually got around to tearing it down. A request captured in
        // that window kept capturing under A's server authorization, and a
        // report opened under B could upload A's buffered bodies (and their
        // correlated crumbs) to B's app/key.
        //
        // Unlike iOS, `_replaySession` here is plain `stateLock`-guarded
        // state, not actor-isolated — so, unlike the iOS fix (which is
        // necessarily bounded by MainActor scheduling latency), this really
        // can be made atomic with the `_config`/`captureGate` swap: by the
        // time `captureGate` observably flips true for B, A's session is
        // torn down, its sticky sampling draw is gone, and every byte A had
        // buffered is gone. A superseding `start()` is, from the
        // body-capture subsystem's point of view, exactly as much of a
        // session boundary as an explicit `kill()`.
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
        // while `captureGate` is closed, and the gate is closed before the
        // first `start()`, so a clear here can only ever discard a PREVIOUS
        // session's content. Identical to the argument `_user`'s
        // unconditional clear makes below — the only thing an earlier clear
        // can cost is attribution, never misattribution. It applies to a
        // same-config re-`start()` too (there is no config-equality early
        // return, by design), on the same one-sentence rule: `start()` begins
        // a session with nothing carried over.
        //
        // `clear()` covers the frozen reporter snapshot as well as the live
        // entries (`BreadcrumbRingBuffer.clear()` nulls `frozen`), so these
        // calls zeroize exactly what `kill()`'s do — there is no extra
        // snapshot step for `start()` to also make.
        //
        // The old paragraph's `reqId` correlation nit goes away with it:
        // metadata crumbs and bodies are now both emptied at the boundary, so
        // no session-A crumb survives to be re-correlated against a
        // freshly-minted session-B `reqId`.
        //
        // NOT airtight against a concurrent capture, and not claimed to be.
        // These clears sit inside the `stateLock` block, which makes them
        // atomic with respect to the `_config`/`captureGate` swap — no
        // `stateLock` reader can observe B's key alongside A's still-full
        // rings — but the capture path does NOT take `stateLock`
        // (`BreadcrumbRingBuffer.add` / `NetworkRingBuffer.push` consult the
        // `@Volatile captureGate`, which stays open across this whole block
        // since it is still A's), so an A capture completing in here can
        // still append one entry after the clear. That window is exactly the
        // one `sharedNetworkBodyBuffer` has always had at this spot, it is
        // bounded by a few statements, and it is a different order of problem
        // from the unbounded carry-over above. iOS's twin paragraph records
        // the same limitation.

        // Session Vitals (Codex round-1, Critical 1; round-2, Critical 1) — a
        // superseding `start()` is a session boundary for vitals exactly as it
        // is for the body-capture gate cleared inside the block below. Without
        // these two lines, `start(B)` re-opened `captureGate` synchronously
        // while project A's controller stayed live until B's heavy-init tail
        // got around to installing: `trackPlayer` calls in that window
        // attached B's players to A's controller and were described into A's
        // session, A's sampler kept recording, and A's scheduled transport
        // retries uploaded post-boundary telemetry under A's key. B's
        // controller could also consume A's uncleared server-vitals signal and
        // open its gate off the dead app's dashboard config before B's own
        // fetch returned.
        //
        // BEFORE the `stateLock` block, not after it (Codex round-2, Critical
        // 1). Running them afterwards left a window — everything the block
        // itself does — in which B's `_config` (B's SDK KEY) and a re-opened
        // `captureGate` were already published while A's controller was still
        // the process-wide live one: a report built by ANY other thread in
        // that window read A's session id and A's recent vitals ring through
        // `VitalsRuntime.currentStamp()` and uploaded them under B's key. That
        // is the same cross-tenant disclosure the `_user`/`_identityHolder`
        // clears inside the block exist to prevent, and the ordering is the
        // whole fix: unpublish A's runtime FIRST, then publish B's identity.
        //
        // Still OUTSIDE `stateLock`: `shutdown()` runs every integration's
        // customer `detach()`, and clearing a `StateFlow` runs its collectors
        // synchronously on this thread — neither may happen under `stateLock`
        // (same reasoning as the companion/branding clears in `kill()`).
        //
        // Round 2 additionally ran the teardown BEFORE the epoch bump, so that
        // A's epoch-bound transport was still live for A's final chunk +
        // summary. Round 3 reverses that half — see the paragraph below.
        //
        // Codex round-3, Critical 2 — the teardown and the publication below
        // are ONE generation-guarded transition. This start's generation is
        // RESERVED first (the `_startEpoch` bump moved up here from the
        // bottom of the `stateLock` block below), the runtime teardown is
        // made conditional on it, and the publication re-checks it. Without
        // that, `start(B)` blocking inside an old integration's `detach()` —
        // customer code, unbounded by construction — let a concurrent
        // `start(C)` run to completion, install C's controller and publish
        // C's key, and then B woke up, published B's `_config` over it and
        // re-opened the gate: reports stamped C's vitals under B's SDK key.
        // The same gap let a concurrent `kill()` complete and B re-open
        // `captureGate` after it. Reserving the generation first makes both
        // interleavings observable — B's own re-check refuses to publish, and
        // `VitalsRuntime.shutdown`'s predicate (evaluated inside the runtime
        // monitor) refuses to unpublish a controller that is no longer B's to
        // unpublish.
        //
        // The cost, accepted: `_startEpoch` now moves BEFORE the vitals
        // teardown, so project A's epoch-bound transport is already silenced
        // when A's controller ships its final summary. Round 2 ordered these
        // the other way to let that last chunk out under A's key. A dropped
        // final summary is a bounded loss of telemetry; publishing B's key
        // over C's live session is a cross-tenant disclosure, and the ordering
        // can only serve one of them.
        val epoch = synchronized(reportCaptureCoordinator) { stateLock.withLock {
            _startEpoch += 1
            // Important 7 — the lock-free mirror, written in the same critical
            // section as the field it mirrors. See currentStartEpochVolatile().
            _startEpochMirror.set(_startEpoch)
            _startEpoch
        } }
        // "Is this start() invocation still the newest one?" Every step below
        // that publishes or unpublishes process-global state is gated on it.
        val stillNewest = { stateLock.withLock { _startEpoch == epoch } }

        // Codex round-3, Critical 3 — the previous session's `ReplaySession`
        // is invalidated BEFORE the vitals signal is cleared, not after. Its
        // `teardown()` bumps that session's generation synchronously, and
        // `refreshConfigNow()` re-checks the generation immediately before
        // each process-global apply — including, since this round, the vitals
        // one. Clearing the signal first left the reverse order: a refresh
        // that had already passed its check could resume and re-publish
        // project A's `vitalsEnabled`/`vitalsSampleRate` AFTER the clear, and
        // project B's controller then opened its gate off the dead app's
        // dashboard config. If B's own fetch failed, that stale enablement
        // persisted for the whole session.
        //
        // Outside `stateLock`: `teardown()` takes the session's own lock and
        // cancels its jobs, and nothing here needs to be atomic with the
        // config swap — an EARLIER teardown is always the safe direction (the
        // gates it feeds fail closed).
        //
        // Codex round-6, #1 — but only if this start is STILL the newest one,
        // and that predicate is evaluated INSIDE the same critical section
        // that clears the field. See [takeSupersededReplay].
        val supersededReplay = takeSupersededReplay(epoch)
        supersededReplay?.teardown()

        // `dropPending = false` (Critical 1): a superseding `start()` is a
        // session boundary for the LIVE controller, but a `trackPlayer()`
        // still queued is waiting for a session, and this call is about to
        // provide one. Only `kill()` revokes the queue.
        com.traceitx.vitals.VitalsRuntime.shutdown(dropPending = false, ifCurrent = stillNewest)
        // Codex round-4, #4 — compare-and-clear, not check-then-clear. B's
        // `stillNewest()` could pass, B be descheduled, C complete and publish
        // C's vitals gate, and B then write `null` over it: C's collector
        // disabled for the whole session if C's own config fetch never
        // refreshed again. The predicate now runs inside the signal's gate,
        // atomically with the write it guards.
        com.traceitx.vitals.VitalsServerConfigSignal.publish(null, stillNewest)

        var displacedReplay: ReplaySession? = null
        val published = stateLock.withLock {
            // Critical 2: the publication re-check. A start that lost the race
            // while running customer teardown above publishes NOTHING — no
            // config, no gate, no cleared rings — and returns below without
            // launching its heavy-init tail, so it also creates nothing that
            // would need shutting down.
            if (_startEpoch != epoch) return@withLock false
            displacedReplay = _replaySession
            _replaySession = null
            NetworkBodyCaptureState.reset()
            sharedNetworkBodyBuffer.clear()
            // Follow-ups item 10 — the two `clear()` calls `kill()` has always
            // made (below, after its own gate flip) and `start()` never did.
            // Guarded by `EnvelopeUserTest`'s "a report in the next project
            // ships none of the previous project's breadcrumbs" and "the next
            // project starts with none of the previous project's network rows".
            sharedBreadcrumbBuffer.rotate(epoch.toLong())
            sharedLogBuffer.rotate(epoch.toLong())
            sharedNetworkBuffer.rotate(epoch)

            _config = config
            // External review, finding 2 (Serious) — clear the self-declared
            // user (`setUser`, spec 2026-08-12) in the SAME `stateLock`
            // critical section that installs the new configuration, so no
            // observer can ever see B's SDK key paired with A's user. `kill()`
            // has always done this; `start()` did not, and it is the more
            // dangerous half: `_config` carries the SDK KEY, i.e. the project
            // every subsequent report is uploaded to. `start(projectA) ->
            // setUser(X) -> start(projectB)` therefore uploaded A's
            // id/email/display name under B's key, creating a falsely
            // attributed person in a DIFFERENT customer's project. React
            // Native makes it especially reachable: unmounting the provider
            // leaves this singleton's user intact, so a remount + reconfigure
            // inherits the previous one.
            //
            // UNCONDITIONAL, including a same-key re-`start()`. The rule an
            // integrator has to hold is one sentence — "start() begins a
            // session with no user; call setUser after start" — and that beats
            // a config-equality predicate whose behaviour nobody can evaluate
            // in their head. It costs nothing correct either: `setUser` is
            // already a no-op while `captureGate` is closed, so setting the
            // user AFTER start is already the only ordering that works.
            //
            // Sits with the F23 session-boundary resets above, not apart from
            // them: a superseding `start()` is a session boundary, and a
            // host-declared person is at least as sensitive as the buffered
            // bytes those lines drop.
            _user = null
            // Native identity Task 8 (Kotlin twin of iOS Task 4) —
            // `_identityHolder.set(null)` clears the verified-identity token
            // in the SAME `stateLock` critical section as `_user = null`
            // immediately above, for the identical reason: a token surviving
            // `start(projectA) -> start(projectB)` would let project B's
            // reports present project A's user's server-verified identity —
            // worse than the self-declared `_user` leak the line above
            // already closes, since a verified credential is the one thing a
            // receiving server trusts without question. `IdentityTokenHolder
            // .set` takes its OWN lock, never `stateLock`, so calling it from
            // inside this critical section cannot deadlock or invert lock
            // ordering.
            _identityHolder.set(null)
            appContext = context.applicationContext
            captureGate = true
            true
        }
        // Superseded while tearing the previous session down — see the
        // re-check above. Nothing was published and nothing was built.
        displacedReplay?.teardown()
        if (!published) return
        com.traceitx.companion.CompanionBadgeServerConfigSignal.publish(null) { currentStartEpochVolatile() == epoch }
        com.traceitx.config.BrandingServerConfigSignal.publish(null) { currentStartEpochVolatile() == epoch }
        com.traceitx.config.BrandingInlineTheme.publish(config.theme) { currentStartEpochVolatile() == epoch }

        // External review, finding NN3 — register the companion badge's
        // Activity tracker HERE, at the earliest core entry point, instead of
        // only at `startCompanion()` time. `CompanionActivityTracker` is an
        // `Application.ActivityLifecycleCallbacks`: it only ever LEARNS the
        // current Activity from a FUTURE `onActivityResumed` callback, so a
        // host that calls `start()` well after its first Activity is already
        // on screen (the common React Native shape — JS runs long after
        // `MainActivity.onCreate`) left the tracker with `current = null`
        // until the next pause/resume cycle if registration waited for
        // `startCompanion()`. Registering here means the tracker is already
        // listening by the time ANY Activity resumes, so
        // `CompanionBadge.__activityProvider` (fed only when still null — see
        // `installIfNeeded`'s own doc comment) is seeded long before a
        // companion client ever attaches.
        //
        // ORDERING ASSUMPTION this relies on: `configure()`/`start()` runs
        // before `startCompanion()` in every host's lifecycle (true today —
        // the RN bridge's `configure()` calls `TraceItX.start()` and
        // `startCompanion()` is a separate, always-later JS call; a
        // plain-native host calling `TraceItX.startCompanion()` directly
        // must likewise have already called `TraceItX.start()`, since
        // `startCompanion()` itself no-ops without `appContext`). `install
        // IfNeeded` is idempotent (its own `AtomicBoolean` latch) and only
        // ever populates `__activityProvider` when it is STILL null, so
        // calling it again from `startCompanionInternal` below (kept as a
        // fallback for the theoretical case a context reaches this facade
        // some other way, without going through `start()`) is harmless, and
        // an RN host's own `reactContext.currentActivity` provider —
        // installed later, from `TraceItXModule.startCompanion()` — is never
        // clobbered by either call site.
        com.traceitx.companion.CompanionActivityTracker.installIfNeeded(context)
        com.traceitx.trigger.ShakeToReportTrigger.install(
            context = context,
            localEnabled = config.shakeToReportEnabled,
            currentActivity = currentActivity,
            isCurrent = { currentStartEpochVolatile() == epoch },
        )

        // WeakReference: the heavy-init coroutine must not extend the
        // Activity's lifetime if it is destroyed between start() and install.
        val currentActivityRef = currentActivity?.let { java.lang.ref.WeakReference(it) }
        val drainSession = captureSessionSnapshot()
        val drainEndpoint = IngestEndpoint.url
        __beforeDrainLaunchForTesting?.invoke()

        // Heavy init detached — host main thread continues immediately. Per
        // DEFE-02, heavy-init body itself must be guarded so a crash there doesn't
        // propagate to the IO dispatcher's uncaught-exception handler.
        launchCapturedWork(drainSession) {
            // Task 11 — install the lifecycle-observer + uncaught-exception
            // breadcrumb adapters. Console/network dual-writes are passive
            // (fire from LogCapture.kt / TraceItXInterceptor.kt's existing
            // push sites) and need no install call here.
            txGuardVoid("start.breadcrumbAdapters") {
                BreadcrumbAdapters.install(context)
            }
            // Plan 5 hygiene (carry-over from 05-06): install the log-capture tap
            // paths (Timber tree + System.out/err tee) when the host opts in via
            // config.capture.logs. Mirrors iOS TraceItX.swift:167-168
            // (`if config.capture.logs { LogCapture.install() }`). install() is
            // idempotent across repeated start() calls. This is also what makes
            // the Task-11 console breadcrumb dual-write (ConsoleBreadcrumbAdapter,
            // wired at the LogCapture.kt tee/tree push sites) live end-to-end —
            // without this call the whole log pipeline was orphaned. Serialize
            // the epoch check with the stream transition, outside stateLock;
            // disabled replacements also revoke the preceding capture.
            txGuardVoid("start.logCapture") {
                LogCapture.configure(config.capture.logs, epoch.toLong()) { currentStartEpochVolatile() == epoch }
            }
            // Task 12 — install the tap + navigation breadcrumb adapters
            // (Application.ActivityLifecycleCallbacks + Window.Callback
            // wrapper). Activity-level only — see BreadcrumbTapNavAdapters.kt
            // header for the fragment-level deferred-gap decision.
            txGuardVoid("start.breadcrumbTapNavAdapters") {
                BreadcrumbTapNavAdapters.install(context, currentActivityRef?.get())
            }
            // Plan 05-06 (Wave-4 single-writer): drain outbox once at start, then
            // invoke the resolver-indirection installers. Drain runs FIRST so any
            // queued reports from prior sessions ship before new ones can fail-and-
            // re-queue (PIPE-02 ordering carry-forward from iOS).
            //
            // Task 10: hydrate the crash sidecar (synchronously written by a
            // previous session's uncaught-exception handler, since JSONLOutbox's
            // suspend+Mutex API is unusable on a dying thread) into the SAME
            // JSONLOutbox instance BEFORE draining — two separate JSONLOutbox
            // instances would mean two Mutexes guarding one on-disk file.
            txGuardSuspend("start.drainOutbox") {
                // Shared instance (Task 12 review fix): requestOutboxDrain()
                // must drain through the SAME JSONLOutbox — its Mutex is
                // per-instance, so a second instance over the same file
                // would provide no mutual exclusion.
                val outbox = sharedOutboxFor(context)
                CrashSidecar(context.applicationContext).hydrateInto(outbox)
                // Native identity Task 8b — the real singleton holder + the
                // live ReplayConfig, not drainOutbox's old inert defaults.
                //
                // ACCEPTED LIMITATION (fix round 1, Important finding 1) —
                // this call can NEVER attach an identity header, by
                // construction, on EVERY invocation, not just a cold cache:
                // `_identityHolder` was cleared under `stateLock` in this same
                // `start()` call's synchronous section (so `.get(nowMs:)`
                // always resolves null), and `currentReplayConfig()` resolves
                // OFF because the ReplaySession that would have fetched a
                // real one is installed LATER in this same coroutine, in the
                // `start.replay` block below — this statement runs first.
                // That pairing degrades to exactly `resolveIdentityHeader`'s
                // documented fail-closed default, so it is safe, never a
                // leak — but it does mean this call site can never be the
                // retry path that recovers "Alice queues offline, Bob signs
                // in, the retry fires": that report ships unattributed on
                // THIS drain and is then deleted on 200, forever anonymous.
                // Same accepted tradeoff web's `enqueuedSubjects` map takes
                // for an entry queued in a previous page-load session
                // (`sdk-react/src/transport/submit.ts`'s module doc) — losing
                // attribution is the safe direction, not a defect.
                //
                // `requestOutboxDrain()` (below) is the OTHER production call
                // site, and it does NOT share this limitation: it runs
                // whenever the RN bridge explicitly requests a flush after a
                // non-fatal error, arbitrarily long after `start()` returns —
                // by which point the ReplaySession has had a real chance to
                // fetch and the host has had a real chance to call
                // `setIdentityToken`. See `CrashDeliveryTest.kt`'s
                // `a non-fatal crash relaunch-drains through
                // requestOutboxDrain once identity and config have genuinely
                // settled` for a demonstration.
                //
                // ACCEPTED LIMITATION (independent review, round 8, Serious
                // 2) — the gap above is wider than just this drain's OWN
                // reports. `drainOutbox(...)` above runs SEQUENTIALLY, entry
                // by entry, and each attempt can spend a full network
                // timeout before falling back to retryable-queue — so with a
                // deep queue and a bad network, this single suspend call can
                // legitimately take a long time. `captureUserSnapshot()`'s
                // identity gate is not live until a `ReplaySession` is
                // constructed AND its first fetch resolves, both strictly
                // AFTER this call returns (see `start.replay` below). So it
                // is not only this drain's queued reports that ship
                // anonymous during that window: ANY capture anywhere in the
                // app — a crash, an in-app reporter submit, a companion
                // submit — that lands before this call returns is ALSO
                // permanently anonymous, even if the host already called
                // `setIdentityToken` moments after `start()`. Capture-time
                // binding means there is no "catching up" a report captured
                // null once the window closes.
                //
                // Investigated, not assumed: moving the `ReplaySession`
                // construction/`enableIfConfigured()` block below (`start
                // .replay`) to run before or concurrently with this drain
                // would shrink the window, and was the first fix attempted
                // here. It was reverted. That block, its `stateLock`-guarded
                // epoch re-check, and the `__startTailDelayHookForTesting`
                // hook fired INSIDE it are the exact mechanism
                // `StartEpochGuardTest.kt` (re-review gap, post round-4 F16)
                // pins: the hook parks the coroutine right after the
                // candidate `ReplaySession` is built and before the epoch
                // recheck, specifically so a test can interleave `kill()`
                // into that exact gap deterministically. Reordering or
                // parallelizing `start.replay` relative to this drain moves
                // that gap, which would require re-deriving (not just
                // relocating) that test's synchronization mechanism —
                // exactly the "rearranged wholesale" risk this branch has
                // been told repeatedly not to take for an attribution-only
                // issue. Lost attribution is the failure this design already
                // nominates as acceptable (same posture as the launch-drain
                // limitation immediately above, and the reporter-open warm
                // race documented in `TXReporterPresenter.kt`); a
                // kill()/start() race silently re-arming the network-body
                // capture gate off a dead app's config is not. Documented in
                // `the user-recognition contract`, not silently left as
                // a gap.
                // Independent review, round 8, Serious 1 — `epoch` here is
                // the SAME value captured atomically with `_config = config`
                // above, in ONE `stateLock.withLock` block, before this
                // coroutine was even launched. Passing it through as
                // `epochAtInitiation` closes the hole a live-sampled
                // baseline inside `drainOutbox` itself could not: see that
                // parameter's doc comment in ReportSubmitter.kt for the
                // full mechanism.
                ReportSubmitter(config, outbox).drainOutbox(
                    identityHolder = _identityHolder,
                    currentReplayConfig = { currentReplayConfig() },
                    epochAtInitiation = epoch,
                    currentEpoch = { currentStartEpoch() },
                    drainSession = drainSession,
                    endpointAtInitiation = drainEndpoint,
                )
            }
            txGuardVoid("start.heavyInit") {
                __reporterTriggersInstaller?.invoke(context, config)

                // Session Vitals (spec 2026-09-05 §2) — build the controller;
                // the server signal (written by ReplaySession's config apply)
                // drives its start gate. Built here, off the main thread.
                val device = com.traceitx.capture.DeviceMetadata.collect(context)
                val dims = com.traceitx.vitals.vitalsDimsFrom(device, SDK_VERSION)
                val vitalsHandler = com.traceitx.vitals.VitalsThread.handler
                // Codex round-2, Important 14 — the CLIENT stays per-start
                // (reusing one process-wide client is a separate change), but
                // the transport is now built per COLLECTOR by the controller
                // and closed when that collector stops, so its delayed retry
                // runnables and in-flight calls are cancelled at the boundary
                // instead of merely no-op'ing whenever they get around to
                // firing.
                val vitalsClient = com.traceitx.transport.ReportSubmitter.buildIsolatedClient()
                val vitalsSink = {
                    com.traceitx.vitals.VitalsTransport(
                        client = vitalsClient,
                        endpoint = "${IngestEndpoint.url}/api/ingest/vitals",
                        apiKey = config.sdkKey,
                        // Critical 1: bound to the START EPOCH, not only to the
                        // reusable boolean gate. `captureGate` is re-opened by
                        // the next `start()`, so a retry scheduled by THIS
                        // session's transport and fired after that boundary saw
                        // an open gate and shipped project A's payload under
                        // project A's key, into a session the dashboard had
                        // already moved past. The epoch is monotonic and never
                        // restored, so a superseding `start()` (and any
                        // `kill()`) silences this transport permanently. Read
                        // fresh at every send boundary, including the retry,
                        // exactly like the gate.
                        // Round-3, Important 7: the LOCK-FREE epoch read. This
                        // predicate is evaluated under `VitalsCollector`'s own
                        // lock at every send boundary, on a player thread or the
                        // sampler thread; taking `stateLock` from there let a
                        // flush park behind start/kill teardown and broke the
                        // collector's never-blocking send contract (and with it
                        // the crash handler's 100 ms stamp `tryLock`).
                        isKilled = { !captureGate || currentStartEpochVolatile() != epoch },
                        scheduleRetry = { delay, r -> vitalsHandler.postDelayed(r, delay) },
                        cancelRetry = { r -> vitalsHandler.removeCallbacks(r) },
                    )
                }
                val vitalsController = com.traceitx.vitals.VitalsController(
                    com.traceitx.vitals.VitalsController.Deps(
                        localConfig = config.vitals,
                        dims = dims,
                        transport = vitalsSink,
                        scheduler = com.traceitx.vitals.HandlerVitalsScheduler(vitalsHandler),
                        samplerFactory = { onSample, onTick -> com.traceitx.vitals.ResourceSampler(handler = vitalsHandler, onSample = onSample, onTick = onTick) },
                        lifecycle = { fg, bg -> com.traceitx.vitals.VitalsLifecycleObserver(fg, bg) },
                    ),
                )
                // Epoch guard — mirrors the `start.replay` block below: only
                // install when no kill() (or superseding start()) landed
                // while this tail was building the controller above. See
                // that block's own comment for the full race-window
                // explanation; the mechanism (re-check `_startEpoch` under
                // `stateLock` immediately before installing) is identical.
                // Critical 2 — the epoch predicate is evaluated INSIDE
                // `install()`'s publication critical section, not before it.
                // Re-checking here and then calling `install()` left a window
                // in which a `kill()` landing between the two published a
                // controller onto a runtime that had already been torn down,
                // and then drained/attached players into it after `kill()`
                // had returned. `install()` refuses and shuts the candidate
                // down (outside its own monitor) when the predicate is false.
                //
                // Lock order: runtime-monitor -> `stateLock`. Safe because no
                // path takes `stateLock` and then the runtime monitor —
                // `kill()` and `start()` both call `VitalsRuntime.shutdown()`
                // outside `stateLock`, and `TraceItX.trackPlayer` takes
                // neither.
                com.traceitx.vitals.VitalsRuntime.install(vitalsController) {
                    stateLock.withLock { _startEpoch == epoch }
                }
            }
            // Session-replay (VTREE-03 / REPLAY-05): arm the coordinator LAZILY.
            // enableIfConfigured() does NOT walk or allocate a Choreographer tick
            // unless the remote config says ON + the sampling gate passes — so
            // replay is default-OFF / zero-overhead when disabled.
            //
            // Re-review gap (start()/kill() race, mirrors iOS commit 826e5f76):
            // this block used to install unconditionally. It now re-checks
            // `_startEpoch` under `stateLock` immediately before installing,
            // so a `kill()` that landed while this coroutine was still
            // building (or parked in the test-only
            // `__startTailDelayHookForTesting` hook — a blocking call, not a
            // suspension point; see that field's doc comment for why)
            // discards the install instead of arming a session built from a
            // config `kill()` already tore down.
            txGuardVoid("start.replay") {
                // MAI meter Plan 2b-ii. The client veto is applied by BUILDING
                // NOTHING: `enabled = false` returns a supplier that computes
                // nothing and stores nothing. The closure reads
                // SharedPreferences per config fetch — cheap, and off the main
                // thread, since the provider fetches on its IO dispatcher.
                val installIdProvider = com.traceitx.config.InstallIdentifier.makeSupplier(
                    context = context.applicationContext,
                    enabled = config.installIdentifierEnabled,
                )

                // Build the candidate session OUTSIDE the lock (construction
                // does no I/O — the network fetch only starts once
                // enableIfConfigured() is called below).
                val newSession = __replaySessionFactoryForTesting?.invoke(
                    context.applicationContext, config, epoch, captureGate, installIdProvider,
                ) ?: ReplaySession(
                    baseUrl = IngestEndpoint.url,
                    apiKey = config.sdkKey,
                    locallyDisabled = false,
                    context = context.applicationContext,
                    originatingStartEpoch = epoch,
                    captureConsent = captureGate,
                    installIdProvider = installIdProvider,
                )

                // Test-only seam — see __startTailDelayHookForTesting's doc
                // comment. No-op (null) in production.
                __startTailDelayHookForTesting?.invoke()

                // Publication is epoch-atomic; teardown of a rejected candidate stays outside the lock.
                var displaced: ReplaySession? = null
                val stillCurrent = stateLock.withLock {
                    if (_startEpoch == epoch) {
                        displaced = _replaySession
                        _replaySession = newSession
                        true
                    } else {
                        false
                    }
                }
                displaced?.teardown()
                if (stillCurrent) {
                    newSession.enableIfConfigured()
                } else {
                    // kill() (or a later start()) already moved the epoch —
                    // discard the just-built session without installing it
                    // or ever starting its refresh loop.
                    newSession.teardown()
                }
            }
        }
    }

    /**
     * DEFE-03 emergency kill switch. Idempotent — calling twice is safe.
     * Flips captureGate to false; capture-path callers MUST early-return on
     * `!captureGate` before any side-effect.
     */
    @JvmStatic
    fun kill() {
        // Companion capture is bound to an EPOCH, not just to this boolean.
        // `kill()` lowers the gate and `start()` raises it again, so a capture
        // suspended across both never observes `false` and would carry on
        // streaming under the pre-kill request. Bumping the epoch cannot be
        // undone by a later start().
        com.traceitx.companion.CompanionAuthEpoch.invalidate()

        txGuardVoid("kill") {
            // Codex round-4, #2 — the epoch THIS kill established. Everything
            // below runs with `stateLock` released and takes an unbounded
            // amount of time (customer `detach()` code, a bounded drain wait,
            // log-tee restoration), so a concurrent `start()` can publish its
            // configuration, install its controller and queue registrations
            // for it in the meantime. The vitals teardown at the tail used to
            // be unconditional and killed that NEW session: the `start()` had
            // already returned successfully, but vitals were dead for its
            // whole lifetime. Captured here, checked at each of those tail
            // steps.
            var revokedReplay: ReplaySession? = null
            var revokedJobs = emptyList<Job>()
            var revokedIdentityJobs = emptyList<Job>()
            val killEpoch = synchronized(reportCaptureCoordinator) { stateLock.withLock {
                // Re-review gap: bump the start epoch FIRST, synchronously,
                // before anything else in this critical section — this is
                // what closes the race window for a start() heavy-init
                // coroutine still building/parked mid-tail (e.g. inside
                // __startTailDelayHookForTesting, or between there and the
                // `start.replay` block's own stateLock-guarded epoch
                // recheck): once this bump lands, that tail's later recheck
                // sees a stale epoch and discards its would-be ReplaySession
                // install instead of arming one built from the config we're
                // about to tear down below. Mirrors iOS kill() (commit
                // 826e5f76).
                _startEpoch += 1
                // Important 7: the lock-free mirror is written in the SAME
                // critical section as the field it mirrors, at every write
                // site, so the transport's non-blocking kill predicate can
                // never read a value `stateLock` readers disagree with.
                _startEpochMirror.set(_startEpoch)
                // Monotonic and never lowered — this is what makes a
                // revocation survive a later start() that re-opens captureGate.
                _killGeneration += 1
                _killGenerationMirror.set(_killGeneration)
                captureGate = false
                _config = null
                _user = null
                // Native identity Task 8 (Kotlin twin of iOS Task 4) — clear
                // the verified-identity token in the SAME `stateLock`
                // critical section as `_user = null` immediately above, same
                // GDPR/kill-switch posture as the ring-buffer zeroization
                // below ("nothing captured before the kill can ship
                // afterward") applied to a server-verified credential rather
                // than a self-declared label. `IdentityTokenHolder.set`
                // takes its OWN lock, never `stateLock`, so this cannot
                // deadlock or invert lock ordering.
                revokedIdentityJobs = _identityHolder.clearAndCaptureOutstandingWork()
                revokedReplay = _replaySession
                _replaySession = null
                revokedJobs = sdkScope.coroutineContext[Job]?.children?.toList().orEmpty()
                sharedBreadcrumbBuffer.rotate(_startEpoch.toLong())
                sharedLogBuffer.rotate(_startEpoch.toLong())
                sharedNetworkBodyBuffer.clear()
                sharedNetworkBuffer.rotate(_startEpoch)
                // Report Resource Window (spec 2026-09-05) round-1 review,
                // Important 2 — the same class of evidence as the four
                // buffers above: nothing captured before a kill may ship
                // afterward. Cleared here, AFTER `captureGate = false` in
                // this same critical section, which is the ordering
                // `ResourceRingBuffer.push`'s two-phase gate check relies on
                // to keep a tick already queued on the main looper from
                // re-populating the ring behind this clear.
                sharedResourceBuffer.clear()
                NetworkBodyCaptureState.reset()
                __replayConfigOverrideForTesting = null
                val revokedOutbox = sharedOutbox
                revokedOutbox?.store?.invalidateSync()
                if (revokedOutbox != null) {
                    sharedOutbox = revokedOutbox
                    pendingOutboxRevocation = revokedOutbox
                } else {
                    // Retain the unresolved root without invoking Context/filesystem code here.
                    unresolvedOutboxRevocationContext = appContext
                }
                _startEpoch
            } }
            // Detached owners only. Durable IO, callbacks and cancellation stay outside stateLock.
            revokedReplay?.teardown()
            revokedJobs.forEach { it.cancel() }
            revokedIdentityJobs.forEach { it.cancel() }
            finishOutboxRevocation()
            val stillThisKill = { currentStartEpochVolatile() == killEpoch }
            __reporterTriggersTeardown?.invoke()
            LogCapture.configure(enabled = false, isCurrent = stillThisKill)
            com.traceitx.companion.CompanionBadgeServerConfigSignal.publish(null, stillThisKill)
            com.traceitx.config.BrandingServerConfigSignal.publish(null, stillThisKill)
            com.traceitx.config.BrandingInlineTheme.publish(null, stillThisKill)
            com.traceitx.vitals.VitalsRuntime.shutdown(dropPending = true, ifCurrent = stillThisKill)
            com.traceitx.vitals.VitalsServerConfigSignal.publish(null, stillThisKill)
            com.traceitx.trigger.ShakeToReportTrigger.teardown(stillThisKill)
        }
    }

    /**
     * Independent review, round 15 — the GDPR/kill-switch zeroization
     * [kill] already applies to these four evidence buffers, extracted here
     * so `setIdentityToken`'s account-switch path
     * ([discardCapturedEvidenceForIdentityChange] below) can apply the
     * IDENTICAL zeroization to a LIVE session, without tearing the session
     * down and rebuilding it the way [kill] does. Also closes a
     * pre-existing gap discovered while wiring this: `sharedLogBuffer` (the
     * log lines `LogCapture` accumulates) was the ONE evidence buffer
     * [kill] itself never zeroized — every other buffer already had this
     * posture; this one was simply missed until now.
     *
     * Deliberately does NOT touch: replay (round 17/codex round 16 removed
     * the one caller that used to zeroize it on sign-out specifically,
     * after that call produced two further Serious findings — see
     * [discardCapturedEvidenceForIdentityChange]'s own doc comment below
     * for the full account) or
     * [com.traceitx.capture.NetworkBodyCaptureState]'s sampling/config state
     * (an identity change must not re-roll the one-shot sampling draw for
     * whoever is now signed in — that draw is a process-lifetime decision,
     * unrelated to who the current user is).
     */
    private fun clearCapturedEvidenceBuffers() {
        sharedBreadcrumbBuffer.clear()
        sharedNetworkBodyBuffer.clear()
        sharedNetworkBuffer.clear()
        sharedLogBuffer.clear()
        // Report Resource Window (spec 2026-09-05) round-1 review, Important
        // 2 — the identical finding iOS already fixed, carried into Android
        // here. This buffer is the same class of evidence as the four
        // above: nothing captured before a kill/sign-out may ship
        // afterward, and an account switch must not let a new identity
        // submit the previous one's resource samples. Age-based eviction
        // already bounds the exposure to `windowSec` (<=120s), but the
        // invariant this function exists to enforce is unconditional, not
        // "eventually self-corrects."
        sharedResourceBuffer.clear()
    }

    /**
     * Independent review, round 15, Critical — an account switch
     * ([setIdentityToken] resolving a DIFFERENT verified subject than the
     * one this holder previously represented) used to retain every piece of
     * capture evidence from the PREVIOUS identity — replay, breadcrumbs,
     * logs, network bodies — and let the NEW, now-verified identity submit
     * it.
     *
     * Zeroizes ONLY the four evidence buffers, via [clearCapturedEvidenceBuffers]
     * above — lock-guarded per buffer, thread-agnostic, callable from
     * whatever thread `setIdentityToken` happens to run on (an ordinary auth
     * callback is very often a background thread).
     *
     * Round 16 (codex round 14) re-review — narrowed this mechanism to run
     * ONLY from [setIdentityToken]'s `null` (sign-out) branch, having
     * previously also been reached by inferring an identity CHANGE from
     * Token/Provider; that inference produced three further Criticals and
     * was removed — see [setIdentityToken]'s own doc comment.
     *
     * Round 17 (codex round 16) re-review — this used to ALSO zeroize the
     * replay buffer via `ReplaySession.forceDiscardForIdentityChange()`
     * (`lifecycle.forceDiscard()` immediately followed by an attempt to
     * resume buffering), called from inside `stateLock.withLock { }` above.
     * Two further Serious findings, both consequences of that one call:
     * (1) `ReplaySession`/its Choreographer tick are main-thread-confined;
     * `setIdentityToken` carries no such guarantee — an ordinary background
     * auth callback reached `Choreographer.getInstance()` off-main, and the
     * failure surfaced only AFTER the lifecycle had already been mutated,
     * leaving replay stuck mid-transition with a dead tick until the SDK
     * session restarted; (2) even on the main thread, `forceDiscard()`
     * unconditionally flipped a FROZEN lifecycle (an open reporter) back to
     * buffering and restarted the tick WHILE reporter chrome was on screen —
     * capturing reporter UI into the next report, and leaving the open
     * reporter's own pending submit/cancel to no-op against a lifecycle that
     * was no longer frozen. Removed outright, not patched again — a correct
     * fix needs the same transition barrier and open-reporter handling
     * already deferred for the account-switch residual below, not a third
     * reactive patch to this one call site. [com.traceitx.capture.replay
     * .ReplayLifecycle.forceDiscard] itself is untouched (still exercised by
     * its own tests) — only `ReplaySession`'s identity-triggered wrapper
     * around it was removed, since nothing else called it.
     *
     * ACCEPTED LIMITATION, honestly stated (see `the ingest API/docs
     * /user-recognition.md`): sign-out no longer discards buffered REPLAY
     * frames either — only breadcrumbs/logs/network metadata/bodies are
     * zeroized. In practice this rarely matters: the credential is cleared
     * immediately, so nothing is attributed to anyone until a NEW identity
     * is installed, at which point the already-accepted account-switch
     * residual (this same file's [setIdentityToken] doc comment) governs
     * regardless of whether sign-out ever ran in between.
     */
    private fun discardCapturedEvidenceForIdentityChange() {
        clearCapturedEvidenceBuffers()
    }

    /**
     * Hydrate any crash sidecar + drain the outbox now (Task 12 — RN
     * non-fatal path). `ErrorUtils`-caught JS errors don't kill the
     * process, so unlike a native crash there's a live runtime to ship the
     * envelope immediately rather than waiting for the next `start()`.
     * Reuses the exact hydrate-then-drain sequence `start()` runs at launch
     * (same rationale: a prior session's synchronously-persisted crash
     * sidecar file must be folded into the SAME `JSONLOutbox` instance
     * before draining, never two separate instances guarding one on-disk
     * file). No-op before `start()` / after `kill()` (no context or config
     * to drain with).
     */
    @JvmStatic
    fun requestOutboxDrain() {
        val ctx = appContext ?: return
        // Independent review, round 8, Serious 1 — captured atomically with
        // `config` (via `captureSessionSnapshot()` below) and threaded
        // through UNCHANGED, rather than read fresh at this later point.
        // `sdkScope.launch { }` below is unstructured with respect to this
        // call and can sit unscheduled for an arbitrary time; a
        // `start(projectB)` landing anywhere between this line and the
        // coroutine's body actually executing must not be able to present
        // project B's live token on a request still authorized with
        // project A's SDK key.
        //
        // Independent review, round 9, P1 — this used to read `_config`
        // and `currentStartEpoch()` as two SEPARATE statements at this
        // point. That reopened the same hazard one level up: a
        // `start(projectB)` landing BETWEEN those two reads paired A's
        // config with B's epoch, and both of `drainOutbox`'s guards
        // "passed" on that mismatched pair.
        //
        // Merge note (native-identity x captured-session): this used to call
        // the now-removed `captureConfigSnapshot()`/`TXCapturedConfig` — its
        // own SEPARATE `stateLock` acquisition. `captureSessionSnapshot()`
        // subsumes that job (config alongside `user`/`startEpoch`/the
        // revocation counter, from the SAME acquisition) and, per the
        // comment this replaces, is also `stateLock`-guarded rather than a
        // bare `_config` read — `_config` is a plain `var`, not `@Volatile`
        // like [appContext]/[sharedOutbox], so an unguarded read here would
        // have no happens-before edge with `kill()`'s `_config = null` or
        // `start()`'s `_config = config` under the JMM.
        val captured = captureSessionSnapshot()
        val cfg = captured.config ?: return
        val epochAtInitiation = captured.user.startEpoch
        val drainEndpoint = IngestEndpoint.url
        __beforeDrainLaunchForTesting?.invoke()
        launchCapturedWork(captured) {
            txGuardSuspend("requestOutboxDrain") {
                val outbox = sharedOutboxFor(ctx)
                CrashSidecar(ctx).hydrateInto(outbox)
                // Native identity Task 8b — this is the RN non-fatal path's
                // immediate drain (mirrors iOS CrashReporter.swift's `Task {
                // await submitter.drainOutbox(...) }`): the entry a
                // just-crashed-but-still-alive JS error wrote already carries
                // its captured identitySubject (CrashReporter.kt), so this is
                // what actually resolves it into a header.
                ReportSubmitter(cfg, outbox).drainOutbox(
                    identityHolder = _identityHolder,
                    currentReplayConfig = { currentReplayConfig() },
                    epochAtInitiation = epochAtInitiation,
                    currentEpoch = { currentStartEpoch() },
                    drainSession = captured,
                    endpointAtInitiation = drainEndpoint,
                )
            }
        }
    }

    /** Report a caught Throwable. Returns after a best-effort durable capture, before delivery. */
    @JvmStatic
    fun captureException(throwable: Throwable) = captureException(throwable, null)

    /** Report a caught Throwable with owned structured error details. */
    @JvmStatic
    fun captureException(throwable: Throwable, options: CaptureExceptionOptions?) {
        txGuardVoid("captureException") {
            if (!captureGate) return@txGuardVoid
            if (com.traceitx.crash.CrashReporter.captureHandledThrowable(throwable, options)) requestOutboxDrain()
        }
    }

    // ---------------- Sticky attachments (consumed by next report.open()) ----------------

    /**
     * Set host-supplied free-form metadata for the next report. Truncated at
     * [EXTRA_MAX_CHARS] (16384) on write. Each call REPLACES the previous
     * value (not merge — `extra` is a single string, not a bag). Auto-cleared
     * after the next `report.open()` resolves; explicit [clearExtra] is also
     * available.
     */
    @JvmStatic
    fun setExtra(value: String) {
        txGuardVoid("setExtra") {
            stateLock.withLock {
                _pendingExtra = value.take(EXTRA_MAX_CHARS)
            }
        }
    }

    /** Wipe the pending `extra` value without opening a report. */
    @JvmStatic
    fun clearExtra() {
        txGuardVoid("clearExtra") {
            stateLock.withLock { _pendingExtra = null }
        }
    }

    /**
     * Extra-resolver ask-and-wait seam (spec 2026-09-17 setExtra-resolver —
     * RN parity with the resolver form of `setExtra` @traceitx/sdk-core and
     * @traceitx/web already have). `null` for every pure-native host, and
     * for an RN host that has never registered a resolver via JS
     * `setExtra(() => ...)` — [consumePendingAttachments] then costs
     * nothing extra beyond the null check below. The RN bridge module
     * (`TraceItXModule`) installs a non-null implementation once, at
     * construction; that implementation itself no-ops immediately (no
     * event, no wait) unless a resolver is CURRENTLY registered — see its
     * own doc comment for why this stays a per-call decision rather than a
     * push made at registration time.
     *
     * `suspend` so a real suspend-based bounded wait (`withTimeoutOrNull`)
     * never blocks the calling thread — critical because RN's
     * `openReporter()` runs `TraceItX.report.open()` (and therefore this
     * hook) via `withContext(Dispatchers.Main)`, and native shake
     * (`ShakeToReport.kt`) funnels through the exact same `report.open()`
     * entry point.
     *
     * MUST fail open, always: [consumePendingAttachments] wraps every
     * invocation in `runCatching`, so a hook that throws never blocks a
     * report. A hook that never resumes is a contract violation on the RN
     * side (its own `withTimeoutOrNull(250)` bound — mirroring
     * `awaitJsReactTreeAttach`'s identical shape — is what makes "fail
     * open, always" hold in practice); this seam itself adds no additional
     * backstop, exactly matching how `awaitJsReactTreeAttach`'s caller
     * trusts its own 250ms bound today.
     */
    @Volatile
    var __pendingExtraResolveHook: (suspend () -> Unit)? = null

    /**
     * Serialises the ask-and-wait + drain sequence when a hook is installed
     * (review finding F5). Without this, two reports racing
     * [consumePendingAttachments] concurrently (e.g. the in-app modal
     * reporter and the phone-companion capture path, both funnelling
     * through this seam) can each suspend in the hook at once — JS then
     * answers BOTH out of band via the single-slot `_pendingExtra` plus a
     * separate correlation-id ack, with no guarantee the ack order matches
     * the `setExtra()` write order relative to which caller's drain runs
     * next. Concretely: A and B both ask; JS answers A (`setExtra(X)`) then
     * B (`setExtra(Y)`, overwriting X) before either resumes; whichever
     * drains first gets Y, not X, and the other gets nil. Serialising means
     * at most one ask-and-wait (and its matching drain) is ever in flight,
     * so `_pendingExtra` unambiguously belongs to the sole outstanding
     * request when it is read. Only engaged when a hook is installed — a
     * pure-native host (`__pendingExtraResolveHook == null`) never touches
     * this mutex, so it costs nothing beyond this feature's existing
     * null-check contract.
     */
    private val extraResolveSerializer = Mutex()

    /**
     * Append a breadcrumb to the rolling chain (spec §3). No-op if
     * captureGate is closed (pre-start / killed) — mirrors `setUser`. Fails
     * soft: never throws, regardless of `data`'s contents.
     *
     * Coercions: an unrecognized `kind` string falls back to
     * [BreadcrumbKind.Custom]; an unrecognized `level` string is DROPPED
     * (not defaulted — a bad level surfaces as "no level" rather than a
     * misleading default). `data` entries that can't round-trip through JSON
     * (custom host objects, etc.) are dropped individually rather than
     * failing the whole call — see [BreadcrumbRingBuffer.coerceHostData].
     */
    @JvmStatic
    fun addBreadcrumb(message: String, kind: String? = null, level: String? = null, data: Map<String, Any?>? = null) {
        txGuardVoid("addBreadcrumb") {
            if (!captureGate) return@txGuardVoid
            val resolvedKind = kind?.let { k -> BreadcrumbKind.entries.firstOrNull { it.value == k } }
                ?: BreadcrumbKind.Custom
            val resolvedLevel = level?.let { l -> Level.entries.firstOrNull { it.value == l } }
            val resolvedData = data?.let { BreadcrumbRingBuffer.coerceHostData(it) }
            sharedBreadcrumbBuffer.add(
                kind = resolvedKind, message = message, level = resolvedLevel, data = resolvedData,
            )
        }
    }

    /**
     * Record a screen appearance — the framework-agnostic navigation marker
     * (spec 2026-07-14). Feeds the SAME global from→to chain as the
     * Activity-level auto-capture, so mixed apps read as one coherent trail:
     * `MainActivity → Home → Detail`. Call from wherever "this screen is now
     * visible" is known: a Fragment's `onResume`, a Jetpack NavController
     * `OnDestinationChangedListener`, or use the `TXScreen()` composable.
     *
     * [name] should be a route identifier, never user content (PII). Blank
     * names are dropped. No-op if captureGate is closed (pre-start / killed)
     * or the `navigation` breadcrumb kind is disabled. `from`/`to` win over
     * [data] keys on collision.
     */
    @JvmStatic
    fun recordScreen(name: String, data: Map<String, Any?>? = null) {
        txGuardVoid("recordScreen") {
            if (!captureGate) return@txGuardVoid
            if (name.isBlank()) return@txGuardVoid
            NavigationBreadcrumbAdapter.recordTransition(name, data)
        }
    }

    /**
     * Session Vitals (spec 2026-09-05): attach a player integration. Returns
     * a handle even when vitals are off, not yet started, or killed — the
     * registration is honoured the moment a controller is installed (queued
     * in the meantime; see [com.traceitx.vitals.VitalsRuntime]'s own doc
     * comment). Use the `com.traceitx:media3` artifact's
     * `TraceItX.trackPlayer(exoPlayer)` for ExoPlayer; implement
     * [com.traceitx.vitals.PlayerIntegration] for others.
     */
    @JvmStatic
    @JvmOverloads
    fun trackPlayer(integration: com.traceitx.vitals.PlayerIntegration, name: String? = null): com.traceitx.vitals.PlayerHandle =
        com.traceitx.vitals.VitalsRuntime.trackPlayer(integration, name)

    /** Session Vitals: a customer-fed log line on the session timeline, ≤ 2 KB serialised (truncated, never dropped). */
    @JvmStatic
    @JvmOverloads
    fun trackVitals(name: String, data: Any? = null, player: com.traceitx.vitals.PlayerHandle? = null) {
        // Codex round-3, Important 11 — the player-scoped path routes through
        // the HANDLE, which is the only thing that knows whether its
        // registration is still live. Reading `player.id` and stamping it onto
        // the process-wide current controller (what this used to do) kept
        // recording for a detached player — its id stays nonblank forever —
        // and, after a session rotation, fed the NEW session entries for a
        // player it never saw attach. A still-pending handle's id is "" and
        // its `track()` is already a no-op; a detached one's now is too.
        if (player != null) {
            player.track(name, data)
            return
        }
        com.traceitx.vitals.VitalsRuntime.current()?.trackVitals(name, data, null)
    }

    /**
     * Attach a JSON-encoded ReactTree (matching @traceitx/protocol shape).
     *
     * NO LONGER SHIPPED. UI-tree capture and tap-to-identify are gone (spec
     * 2026-08-29): `EnvelopeBuilder` hardcodes `reactTree = null`, the
     * in-process reporter presenter drains this slot into `_`, and the
     * companion submission composer has no tree field at all. Whatever is
     * attached here is consumed once and discarded — it never reaches
     * `payload.reactTree` or any other part of the report.
     *
     * Retained (with [detachReactTree] and [consumePendingAttachments])
     * purely so the consume-once drain keeps its contract for the pairing
     * flow, and so a pure-native host that still calls this keeps compiling.
     * Auto-cleared on the next `report.open()`.
     */
    @Deprecated(
        "The attached tree is no longer shipped in any report — it is drained " +
            "and discarded. Remove the call.",
    )
    @JvmStatic
    fun attachReactTree(treeJson: String) {
        txGuardVoid("attachReactTree") {
            stateLock.withLock { _pendingReactTreeJson = treeJson }
        }
    }

    /** Detach without opening a report. */
    @JvmStatic
    fun detachReactTree() {
        txGuardVoid("detachReactTree") {
            stateLock.withLock { _pendingReactTreeJson = null }
        }
    }

    /**
     * Drain pending attachments — returns a snapshot and clears state in a
     * single critical section so two concurrent reports can't both consume.
     * Public because it crosses the :traceitx-core → :traceitx-reporter-ui
     * Gradle module boundary (Kotlin `internal` is per-module). Mirrors
     * iOS's `__consumePendingAttachments` which is public for the same
     * SwiftPM-product reason. Treated as an SPI seam, not part of the
     * stable public API — host apps should never call it directly.
     */
    @JvmStatic
    suspend fun consumePendingAttachments(): Pair<String?, String?> {
        val hook = __pendingExtraResolveHook
            ?: return drainPendingAttachmentsLocked()
        // Serialise the whole ask-and-wait + drain sequence (finding F5's
        // fix — see `extraResolveSerializer`'s own doc comment for why).
        // Only reached when a hook is installed; a pure-native host returns
        // above and never touches the mutex.
        return extraResolveSerializer.withLock {
            try {
                hook()
            } catch (e: CancellationException) {
                // Finding F6: re-throw so a cancelled report's coroutine
                // actually cancels instead of proceeding to drain — a
                // swallowed cancellation would otherwise consume
                // `_pendingExtra` for a report that's being abandoned, and
                // the NEXT (legitimate) report would then see nothing.
                throw e
            } catch (_: Throwable) {
                // Fail-open guarantee: any other throw from the hook must
                // never stop a report from shipping.
            }
            drainPendingAttachmentsLocked()
        }
    }

    /**
     * Snapshot pending `extra`/reactTree and clear state in a single
     * critical section so two concurrent reports can't both consume the
     * same value. Split out of [consumePendingAttachments] so the no-hook
     * fast path and the serialized hook path share one implementation.
     */
    private fun drainPendingAttachmentsLocked(): Pair<String?, String?> =
        stateLock.withLock {
            val extra = _pendingExtra
            val tree = _pendingReactTreeJson
            _pendingExtra = null
            _pendingReactTreeJson = null
            extra to tree
        }

    /**
     * Set or clear the active user. No-op if captureGate is closed — i.e.
     * BEFORE `start()` as well as after `kill()`. The rule is one sentence on
     * every platform: *`start()` begins a session with no user; call `setUser`
     * after `start`* (iOS `TraceItX.swift` gates identically since external
     * review finding 2; web's is a no-op before `init`). See
     * `the user-recognition contract` §"Call it AFTER the SDK is started".
     */
    @JvmStatic
    fun setUser(user: TXUser?) {
        txGuardVoid("setUser") {
            if (!captureGate) return@txGuardVoid
            stateLock.withLock { _user = user }
        }
    }

    /**
     * Install or clear the verified-identity token source (recognition spec
     * 2026-08-06). Kotlin twin of iOS `TraceItX.swift`'s `setIdentityToken`.
     *
     * Pass [IdentityTokenSource.Token] for a one-shot JWT, or
     * [IdentityTokenSource.Provider] to be re-invoked as the cached token
     * nears expiry — the provider form is what spares a host from writing its
     * own refresh timer. `null` signs out and drops the cached token
     * immediately, even mid-lifetime.
     *
     * **Unlike [setUser], this IS a credential**: `setUser` stores an
     * unverifiable label the app itself asserts, with nothing checking that
     * the caller is telling the truth. `setIdentityToken` hands the SDK a
     * signed JWT whose signature `the server identity-token verifier` verifies
     * server-side, so reports captured under it carry a PROVEN identity
     * rather than a self-declared one. Call this when the host backend can
     * mint a short-lived identity token for the signed-in user; call
     * [setUser] when it cannot and the app is just supplying a label.
     *
     * Unlike [setUser], there is deliberately no `captureGate` check here —
     * the holder itself is safe to populate before `start()` (it only
     * decodes/caches in-memory, and does nothing network-visible until a
     * report is actually captured and submitted), and `start()`/`kill()`
     * both clear it unconditionally regardless of when it was set, exactly
     * like `_user`. A token set pre-`start()` cannot reach the wire before a
     * real session installs it either way: the submit-side gate
     * ([com.traceitx.identity.resolveIdentityHeader]) additionally requires
     * `isIdentityEnabled` on the live [com.traceitx.config.ReplayConfig]
     * ([currentReplayConfig]), and the pre-fetch default explicitly disables
     * identity ([com.traceitx.config.ReplayConfig.OFF] — a config value that
     * exists and is readable pre-`start()`, it just says "identity off").
     */
    @JvmStatic
    fun setIdentityToken(source: IdentityTokenSource?) {
        txGuardVoid("setIdentityToken") {
            // Independent review, round 15, Critical, then round 16 (codex
            // round 14) re-review — round 15 tried to discard captured
            // evidence on any CONFIRMED identity change (Token/Provider
            // comparing the new subject against the previous one), not just
            // sign-out. The re-review found that attempt itself produced
            // three further Criticals, all consequences of trying to infer
            // "did the identity actually change" reactively instead of
            // through a real transition barrier: (1) an already-open
            // reporter keeps the PREVIOUS user's screenshot/UI-tree
            // regardless of what the ring buffers do, so a Send tapped
            // after the switch could still attribute stale captured state
            // to the NEW, now-verified identity; (2) the provider-form
            // comparison was a ONE-SHOT check tied to the FIRST warm
            // attempt — if that attempt failed/timed out, no later warm
            // (e.g. reporter-open's own [__warmIdentityToken]) ever
            // retried the comparison, so a transient failure PERMANENTLY
            // lost it; (3) even the synchronous Token path called
            // `_identityHolder.set(source)` (publishing the new identity)
            // BEFORE the evidence wipe completed, so a concurrent capture
            // could observe the NEW subject alongside the OLD evidence in
            // the gap between the two.
            //
            // Ruling: narrow this to the part that is unambiguous and free
            // of all three findings. Sign-out (`null`) is kept — see below
            // for why it alone is exempt. The inferred Token/Provider
            // comparison is REMOVED entirely, not patched again — findings
            // (1) and (2) are not artifacts of which trigger form is used
            // (an open reporter's baked-in state and a warm's own retry
            // path are unrelated to whether the comparison was synchronous
            // or async), and a synchronous-only fix for (3) alone would
            // still leave (1) and (2) live. A correct account-switch
            // transition is a cross-cutting design problem (reporter UI,
            // replay lifecycle, holder, concurrency) that needs an actual
            // transition barrier this branch does not have — not something
            // to keep reactively patching at the end of this branch. See
            // the accepted-limitation documentation below and in
            // `the user-recognition contract` for what remains exposed.
            //
            // Why sign-out alone stays sound: `null` always resolves to
            // ANONYMOUS, never to a DIFFERENT verified identity — so even
            // in the identical race window (evidence published as
            // gone/anonymous before the wipe finishes, or an open reporter
            // still holding stale captured state), the worst outcome is a
            // report that ships with less evidence than expected, or no
            // header at all. Nothing is ever attributed to the WRONG
            // verified person, which is the one outcome this whole feature
            // exists to prevent. That asymmetry is exactly what findings
            // (1)-(3) do not have for Token/Provider: there, the race's
            // worst case is Alice's evidence reaching the wire under Bob's
            // proven identity.
            _identityHolder.set(source)
            // Final whole-branch review, Critical 1 — the PROVIDER form used
            // to cache NOTHING on install: only `IdentityTokenSource.Token`
            // self-caches inside `set()` above. `captureUserSnapshot()` reads
            // the SYNCHRONOUS `cachedSubject(nowMs:)`, and
            // `resolveIdentityHeader` short-circuits on a `null` captured
            // subject BEFORE it ever calls `holder.get(nowMs:)` — so a cold
            // cache was never warmed, and [IdentityTokenHolder.currentSubject]
            // (documented as exactly this warm-up path) had ZERO production
            // callers. The documented, RECOMMENDED integration
            // ("Use the provider form") therefore stamped every capture
            // anonymous, forever, with no error anywhere.
            if (source == null) {
                // ACCEPTED LIMITATION (round 16) — everything BUT sign-out:
                // an account switch that installs a NEW, different verified
                // identity (calling setIdentityToken again with a Token/
                // Provider for a different person, without an intervening
                // null) does NOT discard previously captured evidence. A
                // report submitted after such a switch can carry the
                // PREVIOUS user's breadcrumbs, logs, and network data under
                // the NEW user's verified identity. This predates this
                // branch — setUser has always permitted the identical
                // raw-buffer mixing for a self-declared, unverified label —
                // what this branch adds is the aggravation that the
                // mixed-in identity is now cryptographically VERIFIED
                // rather than a string the app merely asserted. Documented
                // in the user-recognition contract; not silently left
                // as a gap.
                //
                // Round 17 (codex round 16) — sign-out's own discard is now
                // narrower too: it zeroizes breadcrumbs/logs/network
                // metadata/bodies only, no longer the replay buffer (see
                // [discardCapturedEvidenceForIdentityChange]'s own doc
                // comment for why). Stated plainly, not implied: sign-out is
                // NOT a complete evidence boundary on its own — it clears
                // the credential and most evidence, but a buffered replay
                // frame can survive it. In practice this rarely matters,
                // since nothing is attributed to anyone until a NEW identity
                // is installed, at which point the account-switch residual
                // above governs regardless.
                discardCapturedEvidenceForIdentityChange()
            } else {
                __warmIdentityToken()
            }
        }
    }

    /**
     * Fire a detached warm of [_identityHolder]'s cache — [IdentityTokenHolder
     * .currentSubject] discarding its result; only the SIDE EFFECT of
     * populating the cache matters to any caller of this function. Public —
     * unlike [_identityHolder] itself — because `:traceitx-reporter-ui`'s
     * `TXReporterPresenter` calls this from a SEPARATE Gradle module, the
     * same cross-module reason [__resolveIdentityToken] is public despite the
     * double-underscore convention.
     *
     * Two call sites (fix round 2, Critical 1 still not fully closed after
     * round 1):
     *   1. [setIdentityToken] above, on every non-null install — covers the
     *      FIRST token lifetime after a host calls this.
     *   2. `TXReporterPresenter.openReporter` (`:traceitx-reporter-ui`), at
     *      reporter-open, alongside [__replayFreeze] — covers a report
     *      captured minutes/hours after install, once the cache from (1) has
     *      long since aged past [IDENTITY_REFRESH_MARGIN_MS]. Without this
     *      second call site, [IdentityTokenHolder.cachedSubject] — the
     *      SYNCHRONOUS read [TraceItX.captureUserSnapshot] uses — reads
     *      `null` the instant the install-time warm's token ages inside the
     *      margin, and NOTHING re-invokes the provider from then on:
     *      `resolveIdentityHeader` short-circuits on a `null` captured
     *      subject before it ever reaches `holder.get`, so
     *      [IdentityTokenHolder.currentSubject] — the only thing that would
     *      re-ask the provider — is never called again. A provider-form host
     *      therefore worked for exactly one token lifetime (at most 10
     *      minutes) per `setIdentityToken` call, then went permanently
     *      anonymous, silently.
     *
     * Reporter-open is real time BEFORE the Send tap and off the capture's
     * own critical path — the same rationale [__replayFreeze] documents for
     * freezing the replay buffer there. It does NOT cover the crash path
     * ([com.traceitx.crash.CrashReporter.captureFacts]): a crash captures
     * synchronously, with no "opening" moment to warm ahead of, and this SDK
     * deliberately carries no periodic re-warm timer (see the identity guard's
     * documented no-timer posture) — so a provider-form host's crash reports
     * remain anonymous once the last warm (install or a prior reporter-open)
     * has aged past the margin. Documented in
     * `the user-recognition contract`, not silently left as a gap.
     *
     * `setIdentityToken` (and therefore this, when called from there) MUST
     * stay synchronous — host code calls it from ordinary, non-suspend call
     * sites — so this fires an unstructured, detached coroutine rather than
     * suspending the caller. `sdkScope` (Dispatchers.IO, its Job cancelled on
     * `kill()`) is safe to use before `start()` too — it is a plain
     * top-level scope, not gated on `captureGate`.
     *
     * Independent review, Serious 3 — gated on [isIdentityEnabled] before
     * EVER invoking the provider. The unconditional version of this function
     * broke the guarantee the whole `identity.enabled` gate exists for ("a
     * project with no signing secret never calls the customer's endpoint"):
     * installing a provider fired the host's auth/network work for every
     * project, including ones that will never present a header, and cached a
     * subject a subsequent capture could persist into the outbox even though
     * identity is off for that project. The check reads
     * [currentReplayConfig] — the SAME live config every submit path already
     * agrees on — INSIDE the launched coroutine, so this function itself
     * stays synchronous; if config hasn't settled yet (pre-`start()`, or
     * before the first fetch completes) that resolves the fail-closed `.OFF`
     * default, so the warm simply skips rather than waiting or invoking
     * anything — no wait, no timer, matching this branch's standing
     * no-timer decision. A later warm (the next [setIdentityToken] call, or
     * the next reporter-open) picks it up once config is live.
     */
    @JvmStatic
    fun __warmIdentityToken() {
        launchCapturedWork(captureSessionSnapshot(), requireCurrentStart = true) {
            txGuardSuspend("warmIdentityToken") {
                if (!isIdentityEnabled(currentReplayConfig())) return@txGuardSuspend null
                _identityHolder.currentSubject(System.currentTimeMillis())
            }
        }
    }

    /**
     * Mark a View as sensitive — its bounds are masked in screenshots and
     * native video excludes the entire window while it is present.
     *
     * Implementation tags the View with `R.id.tx_sensitive = true`; both
     * `SensitiveRectRegistry.isSensitive` (screenshot redactor) and
     * `NativeVideoPrivacyGate` (video exclusion) check this tag. Mirrors
     * the Compose-side `Modifier.txSensitive()`
     * semantic-key path.
     *
     * Phase 05.2 (post-2026-05-08) — body wired. Plan 05-03 documented this as
     * the integration point but left the body as a no-op stub; the Payment
     * sample screen's `TraceItX.markSensitive(cardEditText)` call was
     * therefore silently doing nothing for the duration of v1.2 dev. Surfaced
     * by the Phase 05.2 D-11 visual UAT (card-number EditText rendered
     * unredacted in the screenshot preview).
     */
    @JvmStatic
    fun markSensitive(view: View) {
        txGuardVoid("markSensitive") {
            val token = __beginSensitiveRegistration()
            if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) {
                view.setTag(R.id.tx_sensitive, true)
                com.traceitx.capture.video.VideoSensitiveViews.remember(view)
                token.close()
            } else {
                android.os.Handler(android.os.Looper.getMainLooper()).post {
                    txGuardVoid("markSensitive.main") {
                        view.setTag(R.id.tx_sensitive, true)
                        com.traceitx.capture.video.VideoSensitiveViews.remember(view)
                        token.close()
                    }
                }
            }
        }
    }

    /** Blocks video synchronously; close only after main-thread tagging or surface destruction. */
    @JvmStatic
    fun __beginSensitiveRegistration(): AutoCloseable =
        com.traceitx.capture.video.VideoPrivacyRevocation.begin()

    /** One bounded recorder-owned revocation notification slot. Callback must be nonblocking. */
    @JvmStatic
    fun __subscribeVideoPrivacyRevocation(callback: (Long) -> Unit): AutoCloseable =
        com.traceitx.capture.video.VideoPrivacyRevocation.subscribe(callback)

    /** Constant-space generation seam: retained replay claims must compare at every use. */
    @JvmStatic
    fun __videoPrivacyGeneration(): Long = com.traceitx.capture.video.VideoPrivacyRevocation.current

    @JvmStatic
    fun __isVideoPrivacyGenerationValid(generation: Long): Boolean =
        com.traceitx.capture.video.VideoPrivacyRevocation.permits(generation)

    @JvmStatic
    fun __registerVideoPrivacyAdapter(adapter: com.traceitx.capture.video.VideoPrivacyAdapter): AutoCloseable =
        com.traceitx.capture.video.VideoPrivacyGate.registerPlatformAdapter(adapter)

    // ---------------- Resolver indirection (cross-module wiring) ----------------
    //
    // These slots are pre-declared so Plans 06 (reporter-ui) and 07 (tv) write to
    // their own modules without touching TraceItX.kt. Avoids a `:traceitx-core →
    // :reporter-ui` Gradle dep cycle (which would import Compose Material into
    // core, violating Pitfall 14).

    /** Plan 05-06: :traceitx-reporter-ui sets this at module-load. */
    @JvmStatic
    var __reporterTriggersInstaller: ((Context, TraceItXConfig) -> Unit)? = null

    /** Plan 05-06: paired teardown invoked by kill(). */
    @JvmStatic
    var __reporterTriggersTeardown: (() -> Unit)? = null

    // ---------------- Owned native-video replay seams ----------------
    //
    // The live ReplaySession lives in :traceitx-core but the reporter freeze /
    // submit / cancel hooks live in :traceitx-reporter-ui. These `__replay*`
    // seams (same indirection idiom as `__resolver` / `__setPresenting`) let the
    // reporter module drive the buffer without a :core → :reporter-ui dep cycle.

    /** The single live replay coordinator, armed lazily in start(). Null when
     *  replay is OFF or pre-start.
     *
     *  Install and teardown mutate this field under stateLock. Volatile
     *  publication supports lock-free currentReplayConfig reads. Freeze binds
     *  an originating coordinator; later completion/cancellation use only the
     *  explicit handle, even after another start replaces this field.
     */
    @Volatile
    @JvmStatic
    internal var _replaySession: ReplaySession? = null

    /**
     * Foreground-Activity supplier for the replay walk. The reporter module's
     * ReporterResolverInstaller wires this to `{ ActivityRegistry.activeActivity() }`
     * so :traceitx-core can resolve the Activity to walk without importing the
     * reporter module. Null until the reporter module is on the classpath; the
     * replay walk then resolves no Activity and emits no frame (DEFE-02).
     */
    @JvmStatic
    var __activitySupplier: (() -> android.app.Activity?)? = null

    /**
     * Set true by `:traceitx-reporter-ui`'s installer when the built-in
     * attach-PIN dialog is available (spec 2026-08-19). Read at announce time:
     * `AttachPinUi.BUILTIN` only advertises `supportsAttachPin` when something
     * will actually render the code. Same `:core` <- `:reporter-ui` seam shape
     * as [__activitySupplier].
     */
    @JvmStatic
    @Volatile
    var __attachPinUiInstalled: Boolean = false

    /**
     * Set true by the RN bridge / other native hosts when the configured
     * attach-PIN mode is not `builtin` — i.e. something OTHER than
     * `CompanionPinPresenter` owns rendering the challenge (spec 2026-08-19).
     * `CompanionPinPresenter.present` checks this at the top and returns
     * without showing its dialog when set, so a host running its own custom
     * surface never gets two PIN dialogs stacked on screen. The StateFlow
     * itself ([com.traceitx.companion.Companion.attachChallenge]) is
     * unaffected — a custom UI still needs to collect it.
     */
    @JvmStatic
    @Volatile
    var __attachPinUiSuppressed: Boolean = false

    /** Internal DEV host fixture only. Published release returns before reading SDK state. */
    @JvmStatic
    fun __nativeVideoDiagnostics(): String? {
        if (!BuildConfig.DEBUG) return null
        return withReportAuthorizationLock { _replaySession?.nativeVideoDiagnostics()?.toString() }
    }

    /** Bind the reporter-open owner and immutable ancillary values before the reporter mounts. */
    @JvmStatic
    fun __replayFreeze(): FrozenReportCapture = synchronized(reportCaptureCoordinator) {
        _replaySession?.freezeOwnedCapture() ?: FrozenReportCapture.empty(currentStartEpochVolatile())
    }

    @JvmStatic
    suspend fun __replayComplete(capture: FrozenReportCapture): OwnedVideoClip? = capture.exportVideo()

    @JvmStatic
    fun __replayCancel(capture: FrozenReportCapture) = capture.cancel()


    /**
     * Test-only override of [currentReplayConfig] (final whole-branch
     * review, Important 2). Public — unlike [_replaySession] itself —
     * because `:traceitx-reporter-ui`'s `ReporterDialogSubmitBoundaryTest`
     * needs to force an identity-enabled config from a SEPARATE Gradle
     * module that cannot construct a real, internal-state-carrying
     * [ReplaySession] directly (the same cross-module reason
     * [__resolveIdentityToken] above is public despite the double-underscore
     * convention). `null` (default/production) falls back to the live
     * `_replaySession` exactly as before.
     */
    @JvmStatic
    var __replayConfigOverrideForTesting: ReplayConfig? = null

    /**
     * Native identity Task 8b — the ONE live [com.traceitx.config.ReplayConfig]
     * every submit path (live, drain, crash-then-drain) reads to resolve
     * [com.traceitx.identity.resolveIdentityHeader]'s `config` parameter, so
     * all three agree on whether identity is currently enabled and never
     * drift onto their own private notion of "current." Mirrors iOS
     * `TraceItX.currentReplayConfig()`.
     *
     * Reads the volatile coordinator without stateLock. This path can run
     * concurrently with start()/kill():
     * [__warmIdentityToken] fires from an independently-launched, detached
     * coroutine ([sdkScope]), so a `start()`/`kill()` on another thread can
     * land at any point relative to it. Independent review, round 14
     * (codex round 12), Serious 2 — that used to mean this read had no
     * memory-visibility guarantee against [_replaySession]'s `stateLock`
     * -guarded WRITE, so this could observe a stale value in either
     * direction: stale OFF (skips the only warm, reports stay anonymous
     * forever) or stale ON (invokes the customer's provider for a project
     * where identity is actually disabled — the exact thing the round-6
     * `identity.enabled` gate exists to prevent). [_replaySession] is now
     * `@Volatile` (see its own doc comment), which is what actually makes
     * this lock-free read safe — the field's own annotation, not anything
     * here, is what closes the gap. `.OFF` (identity disabled) — the SAME
     * fail-closed default [com.traceitx.config.ReplayConfigProvider] itself
     * starts at — whenever no session has been installed yet (pre-`start()`,
     * or the brief window inside `start()`'s own heavy-init coroutine before
     * `start.replay` constructs one).
     *
     * Public (fix round 2 residual minor) — was `internal`, which made
     * `:traceitx-reporter-ui`'s `ReporterDialogSubmitBoundaryTest`'s own
     * "identity really is enabled" fixture-sanity check read back
     * [__replayConfigOverrideForTesting] against itself (tautological: it
     * always agrees with whatever the test just set). Widening this to
     * public — a read-only accessor, no new mutable surface — lets that test
     * check the REAL production accessor instead, matching
     * `CompanionSubmissionComposerTest`'s equivalent (same-module) check.
     */
    @JvmStatic
    fun currentReplayConfig(): ReplayConfig =
        __replayConfigOverrideForTesting ?:
        _replaySession?.currentConfig ?: ReplayConfig.OFF

    /**
     * Resolve this submit boundary's `X-TX-Identity-Token` value (or `null` to
     * send anonymously) against the live singleton holder and the live
     * per-app identity config. Public — unlike [_identityHolder] itself —
     * because `:traceitx-reporter-ui`'s `ReporterDialog` composes its submit
     * envelope in a SEPARATE Gradle module and cannot reach `internal` state
     * in `:traceitx-core` directly, the same reason [__replayComplete] /
     * [__replayFreeze] above are public despite the double-underscore
     * "treat as SDK-internal" convention.
     *
     * @param capturedSubject the identity recorded when the report was
     *   captured — `TXCapturedUser.identitySubject`, snapshotted at the Send
     *   tap, NEVER a live re-read of [_identityHolder] here: an identity
     *   change landing while envelope-build/encode/upload prep runs must not
     *   repoint an in-flight report, the same rule [resolveCapturedUser]
     *   already enforces for the self-declared user.
     * @param capturedEpoch `TXCapturedUser.startEpoch`, snapshotted in the
     *   SAME `stateLock` critical section as [capturedSubject] above. Final
     *   whole-branch review, Important 2 — a subject match alone is not
     *   enough: `sub` is the host's own user id, typically unchanged across
     *   a tenant or dev/prod switch, so a `start(projectB)` landing during
     *   submit prep, followed by the host calling `setIdentityToken` again
     *   (plausible immediately after switching projects), could otherwise
     *   let this report present project B's live token while the envelope
     *   itself still belongs to project A. A mismatch here withholds the
     *   header outright — the same guard [resolveCapturedUser] applies for
     *   the self-declared user.
     *
     * Independent review, Serious 1 — the pre-check above alone is a TOCTOU
     * window: [com.traceitx.identity.resolveIdentityHeader] below is
     * `suspend` and its own suspension points ([IdentityTokenHolder.get]'s
     * provider re-ask can take up to `IDENTITY_PROVIDER_TIMEOUT_MS`) give a
     * `start(projectB)` + `setIdentityToken(B)` landing DURING resolution —
     * after the pre-check already passed — a window to land: [_identityHolder]
     * is one persistent object whose CONTENTS `set()` mutates in place, so a
     * token installed mid-resolution is exactly what `holder.get` can
     * return, resolving project B's live bearer credential onto a report
     * whose envelope still belongs to project A, if B's `sub` happens to
     * match (plausible — see [capturedEpoch] above). [currentStartEpoch]
     * increases monotonically and is bumped synchronously and
     * unconditionally by BOTH `start()` and `kill()`, so re-checking it
     * AFTER resolution completes, immediately before the result is ever
     * used, closes this the same way the pre-check closes the window before
     * resolution starts: any `start()`/`kill()` anywhere in the whole
     * window — before OR during resolution — leaves a mismatch here.
     *
     * Returns an [IdentityResolution], not a bare token (independent
     * review, P1): a caller persisting an `OutboxEntry` on transient
     * failure needs to know not just the resolved token but whether the
     * captured epoch is STILL current, so it can gate `identitySubject`
     * with the EXACT SAME decision — an epoch mismatch means the whole
     * captured snapshot is untrustworthy, not just the token, the same
     * conclusion `capturedSession.user.resolve()` already acts on for the
     * self-declared user. Bundling both in one return value (computed from
     * ONE internal decision) is what keeps the two from drifting apart —
     * a caller calling this once and using [IdentityResolution.epochStillCurrent]
     * for both purposes cannot independently get one right and the other
     * wrong.
     */
    @JvmStatic
    suspend fun __resolveIdentityToken(capturedSubject: String?, capturedEpoch: Int): IdentityResolution {
        if (capturedEpoch != currentStartEpoch()) return IdentityResolution(token = null, epochStillCurrent = false)
        val resolved = com.traceitx.identity.resolveIdentityHeader(
            capturedSubject = capturedSubject,
            holder = _identityHolder,
            config = currentReplayConfig(),
            nowMs = System.currentTimeMillis(),
        )
        val epochStillCurrent = capturedEpoch == currentStartEpoch()
        // Independent review, round 15, Serious — re-check enablement on a
        // FRESH config read too, not just the epoch: resolveIdentityHeader's
        // own suspension (the holder's provider re-ask, up to
        // IDENTITY_PROVIDER_TIMEOUT_MS) gives a remote config change that
        // flips identity.enabled OFF — WITHOUT bumping the epoch (only
        // start()/kill() do that) — a window to land during resolution, so
        // resolveIdentityHeader decided against a config snapshot that was
        // already stale by the time it returned. Mirrors
        // ReportSubmitter.drainOutbox's own identical guard exactly
        // (`isIdentityEnabled(currentReplayConfig())`, re-read after the
        // resolve), so the live and drain paths cannot drift. Deliberately
        // kept OUT of `epochStillCurrent` itself — that value also gates
        // whether `identitySubject` is trustworthy enough to PERSIST on a
        // retry (see ReporterDialog.kt's caller), a question purely about
        // project/session identity via the epoch; a live enablement flip
        // with no project switch at all does not make the captured snapshot
        // itself untrustworthy, only today's TOKEN decision below.
        val stillEnabled = isIdentityEnabled(currentReplayConfig())
        val token = if (epochStillCurrent && stillEnabled) resolved else null
        return IdentityResolution(token = token, epochStillCurrent = epochStillCurrent)
    }

    /**
     * Result of [__resolveIdentityToken] (independent review, P1).
     * [epochStillCurrent] is `false` whenever the captured session was
     * superseded — before resolution started OR while it was in flight —
     * meaning the ENTIRE captured snapshot (not just [token]) is no longer
     * trustworthy enough to persist.
     */
    data class IdentityResolution(val token: String?, val epochStillCurrent: Boolean)

    // ---------------- Companion (Plan 06.2-08) ----------------
    //
    // Singleton accessor onto the Companion object so hosts can collect
    // `TraceItX.companion.state` / `TraceItX.companion.pairUrl` without
    // importing `com.traceitx.companion.Companion` directly. Field, not
    // function, to mirror Swift's `TraceItX.companion` static property.
    //
    // Auto-start of `RelayWSClient` is wired by Task 2 — `start()` does
    // NOT spawn the WS here. Phase 06.2 Plan 09 adds the `enableCompanion`
    // config flag and the resolver-indirection hook to install/teardown.

    @JvmStatic
    val companion: com.traceitx.companion.Companion = com.traceitx.companion.Companion

    // ---------------- Companion facade for pure-native hosts (external
    // review, finding N3) ----------------
    //
    // Until this pair of methods, `TraceItXModule.startCompanion()`/
    // `stopCompanion()` (the RN bridge, `:sdk-react-native`) was the ONLY
    // caller that ever built a `RelayWSClient` — a plain Kotlin/Java or
    // Jetpack-Compose host with no RN bridge had no way to start companion
    // at all, so `companionDeviceId`/`companionBadgeEnabled`/
    // `companionBadgePosition` on `TraceItXConfig` were dead config for that
    // host shape: nothing ever read them into a client. This mirrors the RN
    // bridge's own construction (deviceProvider off
    // `CompanionDeviceFacts.current`, companionBadge off the same config
    // fields, `parseCompanionBadgePosition` shared with that bridge) and is
    // idempotent the same way: a second call while a client is already live
    // is a no-op — call [stopCompanion] first to restart.
    //
    // Badge activity source: `CompanionBadge.__activityProvider` needs a
    // live `Activity` to draw over. Core has no OTHER queryable "current
    // Activity" to reuse (`BreadcrumbTapNavAdapters` only wraps
    // `Window.callback` for tap crumbs, it never stores one), so
    // [CompanionActivityTracker] installs a minimal tracker of its own the
    // first time this runs, and only feeds `__activityProvider` when it is
    // still null — an RN host's own `reactContext.currentActivity` provider
    // (installed by `TraceItXModule.startCompanion()`) is authoritative for
    // that host and must never be clobbered by this path running in the same
    // process.

    @Volatile
    private var _companionClient: com.traceitx.companion.RelayWSClient? = null

    /** Test seam — mirrors `TraceItXModule.companionClientForTesting()`. */
    @VisibleForTesting
    internal fun companionClientForTesting(): com.traceitx.companion.RelayWSClient? = _companionClient

    /**
     * External review, finding NN1 — before this pair, [_companionClient]
     * (this facade) and `TraceItXModule.companionClient` (the RN bridge,
     * `:sdk-react-native`) were TWO INDEPENDENT fields, each with its own
     * unsynchronized check-then-set. A hybrid app (a native host that also
     * embeds an RN screen) could therefore construct and START two live
     * `RelayWSClient`s racing over the SAME process-global `Companion`
     * StateFlow object, and a `stopCompanion()` on either side cleared ITS
     * OWN provider seams (`CompanionBadge.__activityProvider`,
     * `CompanionCaptureBridge.__*Provider`) unconditionally, even when the
     * client that was actually live belonged to the OTHER caller. Even
     * within a single caller, the old `_companionClient?.let { return it }`
     * check followed by a separate `_companionClient = client` assignment
     * was two statements, not one — a second `start()` landing between them
     * could still orphan a client.
     *
     * [_companionClient] is now [_companionClient]-here-and-here-only: the
     * single slot BOTH this facade's own [startCompanionInternal]/
     * [stopCompanion] below and `TraceItXModule` (a separate Gradle module —
     * these two seams are public, double-underscore-prefixed SDK-internal
     * API, not Kotlin `internal`, for exactly that cross-module reason, the
     * same idiom as [__attachPinUiSuppressed] / [__reporterTriggersInstaller]
     * above) route every registration through. First caller to register
     * wins; every other caller's own, already-constructed client is
     * stillborn — `stop()` it and discard, never install a provider for it.
     *
     * `@Synchronized` locks on the `TraceItX` singleton object itself,
     * distinct from [stateLock] — companion-client ownership is independent
     * of the config/user/epoch state that lock guards, and this method must
     * never be reached from inside a [stateLock] critical section (it isn't,
     * anywhere in this file) to avoid any risk of lock-ordering inversion.
     */
    @JvmStatic
    @Synchronized
    fun __registerCompanionClient(client: com.traceitx.companion.RelayWSClient): Boolean {
        if (_companionClient != null) return false
        _companionClient = client
        return true
    }

    /**
     * Releases the companion-client slot — but ONLY when [client] IS the one
     * currently stored (identity, not equality). A caller whose own
     * [__registerCompanionClient] call lost the race never actually owned
     * the slot, so its `stop()`/teardown must not be able to clear whatever
     * the WINNING caller installed; this identity check is what makes that
     * safe, and is exactly what lets `TraceItXModule.stopCompanion()` clear
     * its own bridge providers unconditionally right after calling this —
     * if the unregister was a no-op (a different, still-live client is
     * registered), the caller's OWN client was never live in the first
     * place and never installed any providers to clear.
     */
    @JvmStatic
    @Synchronized
    fun __unregisterCompanionClient(client: com.traceitx.companion.RelayWSClient) {
        if (_companionClient === client) {
            _companionClient = null
        }
    }

    /**
     * Starts the companion relay client for a host with no RN bridge.
     * No-ops before [start] has run (there is no `appContext`/[currentConfig]
     * yet to read the SDK key or the companion fields off of) and no-ops
     * while a client from a prior call is still live.
     */
    @JvmStatic
    fun startCompanion() {
        val context = appContext ?: return
        startCompanionInternal(context = context, config = currentConfig)
    }

    /**
     * The actual construction, factored out of [startCompanion] purely so a
     * test can supply a `MockWebServer`-backed [okHttpClient]/[baseUrl] the
     * way `RelayWSClientAnnounceTest` does for the RN-driven path — the
     * public [startCompanion] always uses the real [okhttp3.OkHttpClient]
     * and the build-time-baked `IngestEndpoint.url`. Returns the live
     * client — freshly constructed by THIS call, or the one some OTHER
     * caller (a concurrent call here, or the RN bridge) already registered,
     * per [__registerCompanionClient]'s first-caller-wins contract — or null
     * if none could be started.
     */
    @VisibleForTesting
    internal fun startCompanionInternal(
        context: Context,
        config: TraceItXConfig?,
        okHttpClient: okhttp3.OkHttpClient = okhttp3.OkHttpClient(),
        baseUrl: String = IngestEndpoint.url,
    ): com.traceitx.companion.RelayWSClient? {
        // Fast path — avoids constructing (and immediately discarding) a
        // redundant RelayWSClient on the ordinary repeat-call case. Still
        // race-prone by itself (two threads can both read null here), which
        // is exactly why the construct-then-[__registerCompanionClient]
        // sequence below, not this read, is what actually decides ownership.
        _companionClient?.let { return it }
        val client = com.traceitx.companion.RelayWSClient(
            client = okHttpClient,
            baseUrl = baseUrl,
            sdkKey = config?.sdkKey?.takeIf { it.isNotBlank() },
            deviceLabel = android.os.Build.MODEL?.takeIf { it.isNotBlank() },
            deviceProvider = {
                com.traceitx.companion.CompanionDeviceFacts.current(
                    context,
                    config?.companionDeviceId,
                )
            },
            companionBadge = com.traceitx.companion.CompanionBadgeOptions(
                enabled = config?.companionBadgeEnabled ?: true,
                position = com.traceitx.companion.parseCompanionBadgePosition(
                    config?.companionBadgePosition,
                ),
            ),
        )
        if (!__registerCompanionClient(client)) {
            // Lost the race — some other caller (a concurrent call here, or
            // the RN bridge) already claimed the slot. Discard without ever
            // starting this client or installing a provider for it, and hand
            // back whichever client actually won.
            client.stop()
            return _companionClient
        }
        // NN3 fallback — see start()'s own call for why this is normally
        // already a no-op by the time we get here.
        com.traceitx.companion.CompanionActivityTracker.installIfNeeded(context)
        client.start()
        return client
    }

    /** Idempotent — a no-op when [startCompanion] was never called or was
     *  already stopped. Uses [__unregisterCompanionClient]'s identity check
     *  so this can never clear a client some OTHER caller (the RN bridge)
     *  registered after this facade's own client — which, per
     *  [__registerCompanionClient]'s first-caller-wins contract, would only
     *  ever happen if THIS facade's client had already been stopped some
     *  other way. */
    @JvmStatic
    fun stopCompanion() {
        val client = _companionClient ?: return
        client.stop()
        __unregisterCompanionClient(client)
    }

    /** Test seam — undoes [startCompanionInternal] without requiring a real
     *  socket teardown, for tests that only assert on construction. */
    @VisibleForTesting
    internal fun __resetCompanionClientForTesting() {
        _companionClient = null
    }

    // ---------------- Report API (resolver-backed) ----------------

    object report {
        /**
         * Plan 05.1-02: observable presenting-state. Hosts collect this to
         * disable their trigger UI while the reporter is up.
         *
         * Sole writer is `TXReporterPresenter.openReporter` via the internal
         * `__setPresenting` seam below — keeps the public surface read-only.
         */
        private val _isPresenting = MutableStateFlow(false)

        @JvmStatic
        val isPresenting: StateFlow<Boolean> = _isPresenting.asStateFlow()

        /**
         * Internal seam for `:reporter-ui` `TXReporterPresenter` to flip
         * presenting state at openReporter() entry/exit. Not part of the
         * public API; mirrors the `__resolver` indirection used elsewhere.
         */
        @JvmStatic
        fun __setPresenting(value: Boolean) {
            _isPresenting.value = value
        }

        /**
         * Suspend-form reporter open. Resolver is wired by Plan 05-06 at
         * `:traceitx-reporter-ui` module-load (androidx.startup `Initializer`)
         * to `{ TXReporterPresenter().openReporter(activeActivity) }`.
         * Throws IllegalStateException if `:traceitx-reporter-ui` is not on
         * the classpath.
         */
        suspend fun open(): ReportResult =
            __resolver?.invoke()
                ?: throw IllegalStateException(
                    "Reporter UI module not on classpath. Add com.traceitx:reporter-ui dependency."
                )

        /** Plan 05-06 sets this at module-load via ReporterResolverInstaller (renamed in 05.1-02). */
        @JvmStatic
        var __resolver: (suspend () -> ReportResult)? = null

        /** Java-friendly callback shim — only `report.open()` ships this per CONTEXT D-01. */
        @JvmStatic
        fun openAsync(callback: Callback<ReportResult>) {
            MainScope().launch {
                try {
                    callback.onResult(open())
                } catch (t: Throwable) {
                    callback.onError(t)
                }
            }
        }

        /**
         * Test seam — Plan 05-06 single-writer audit grep expects exactly
         * one occurrence of the test-seam symbol in this file (the function
         * declaration itself).
         */
        @VisibleForTesting
        @JvmStatic
        fun __wireResolverForTesting(resolver: suspend () -> ReportResult) {
            __resolver = resolver
        }
    }

    /** Java-friendly callback type for `report.openAsync`. */
    interface Callback<T> {
        fun onResult(value: T)
        fun onError(error: Throwable)
    }
}
