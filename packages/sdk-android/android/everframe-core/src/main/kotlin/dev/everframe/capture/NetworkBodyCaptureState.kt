// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Server-authoritative network-body capture gate (network-body-capture spec).
// Composes three independent signals into a single `isActive` bit. Kotlin
// port of packages/sdk-ios/Sources/Everframe/Capture/NetworkBodyCaptureGate.swift
// (Task 8):
//
//   1. Server block: `NetworkBodiesConfigWire.captureBodies == true`. A null
//      block (feature off / malformed config degraded to null upstream) is
//      fail-closed — capture stays OFF.
//   2. Local gate (`locallyDisabled`, computed by `locallyDisabled()` below):
//      the OR of two client-side preconditions, per spec §3 —
//      `capture.network != true` (metadata capture itself was never opted
//      into; NOT structural, see that function's doc comment) and
//      `CaptureConfig.networkBodies == false` (host opt-out veto). Either
//      one disables bodies; the server ON block always wins the OTHER
//      direction — a host cannot force capture ON when the server says OFF
//      (client veto only, never client override).
//   3. Sampling: `samplingRate` is drawn against `random()` AT MOST ONCE per
//      process — the first `applyConfig` call where the server block says
//      ON performs the draw and its result is sticky for the process
//      lifetime. This mirrors CONFIG-04 (the replay lifecycle's sampling
//      gate): a session that samples in/out does not flip mid-session on a
//      later config refresh, even if the server changes `samplingRate` or a
//      different `random()` would have drawn the other way.
//
// ReentrantLock-guarded state (mirrors BreadcrumbRingBuffer / NetworkBodyRingBuffer
// discipline) so `isActive` / `bodyByteCap` / `bodyContentTypes` / `mintReqId()`
// stay synchronous and thread-safe. Process-wide singleton `object`, matching
// iOS's `NetworkBodyCaptureGate.shared`.
//
// Producer (spec 2026-08-12-android-network-body-tee-design.md) —
// `capture/NetworkBodyTee.kt` is the producer for the RESPONSE direction: it
// calls `mintReqId()` and reads `isActive`/`bodyByteCap`/`bodyContentTypes`
// (via `NetworkBodyFinalizer`) to build and append an entry. The REQUEST
// direction remains unimplemented (spec §14) — nothing calls `mintReqId()`
// for a request, and no request-side entry is ever produced.
package dev.everframe.capture

import androidx.annotation.VisibleForTesting
import dev.everframe.config.BreadcrumbsConfigWire
import dev.everframe.config.NetworkBodiesConfigWire
import dev.everframe.config.EverframeConfig
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

object NetworkBodyCaptureState {

    /** Byte-cap default (spec default) — applied when the server block omits
     *  `bodyByteCap` or hasn't been supplied yet. */
    const val defaultBodyByteCap: Int = 8192

    /** Content-type allowlist default (spec default) — applied when the
     *  server block omits `bodyContentTypes` or hasn't been supplied yet. */
    val defaultBodyContentTypes: List<String> = listOf("application/json", "text/*")

    private val lock = ReentrantLock()

    /** null = never drawn yet; drawn lazily on the first `applyConfig` call
     *  where `wire?.captureBodies == true`, then sticky for the process. */
    private var sampleDraw: Boolean? = null
    private var active = false
    private var _bodyByteCap = defaultBodyByteCap
    private var _bodyContentTypes = defaultBodyContentTypes
    private val reqIdCounter = AtomicInteger(0)

    /**
     * Round-7 review Finding F34: monotonically increasing per-process
     * generation, bumped whenever [applyConfig] CHANGES the effective
     * [active] bit (either direction — the "at minimum" transition-to-
     * inactive case the finding calls out is a subset of this) and,
     * unconditionally, by [reset] (which `kill()` calls). A caller that
     * captures `(active, generation)` together at decision time — BEFORE
     * building a body entry, which can take real wall-clock time
     * (redaction, bounded reads) — can later hand the captured generation
     * to [NetworkBodyRingBuffer.append]'s `guard` parameter, which
     * re-validates [isActiveForGeneration] INSIDE this object's own [lock],
     * atomically with the insert. This is what makes a remote
     * `captureBodies: false` landing mid-flight authoritative at the actual
     * sink boundary, not just at the start of body processing — see
     * [dev.everframe.okhttp.EverframeInterceptor]'s call site for the full fix.
     */
    private var generation = 0

    /**
     * Combined client-side "locally disabled" precondition (spec §3,
     * `2026-08-01-network-body-capture-native-design.md`):
     *
     *     captureBodies = serverConfig.captureBodies
     *                   && capture.network == true
     *                   && capture.networkBodies != false
     *                   && sampledIn
     *
     * This function computes the right-hand OR of the two client
     * preconditions above (negated) — the single place both are combined so
     * they cannot drift apart across call sites.
     *
     * Round-5 review Finding F22: `capture.network == true` is NOT a
     * structural precondition, despite the spec's original §3.1 assumption.
     * `addEverframeInterceptor()` attaches [dev.everframe.okhttp.EverframeInterceptor]
     * unconditionally — it never reads `capture.network` — so a host that
     * wires network capture without ever setting `capture.network = true`
     * still gets metadata capture, and (pre-fix) still got BODY capture
     * whenever the server block was ON, defeating the intended opt-in. This
     * gate must therefore evaluate the flag explicitly rather than assume
     * metadata-capture attachment implies it.
     *
     * `config == null` (pre-`start()`, or a torn-down session) fails closed:
     * there is no confirmed client opt-in yet, so bodies stay off.
     */
    fun locallyDisabled(config: EverframeConfig?): Boolean {
        if (config == null) return true
        return !config.capture.network || config.capture.networkBodies == false
    }

    /**
     * Round-6 review Finding F28: a body is meaningless without its
     * correlating SHIPPED network breadcrumb — [dev.everframe.envelope.EnvelopeBuilder]
     * drops any `payload.networkBodies[]` entry whose `ref` has no matching
     * network crumb `data.reqId` (spec §7/§11.8's every-ref-matches-one-crumb
     * invariant). Before this fix `networkBodiesConfig.captureBodies` was
     * independently toggleable from `breadcrumbsConfig` — an operator could
     * turn bodies ON while breadcrumbs were OFF (or `kinds` omitted
     * `network`), and every captured body was then silently dropped at
     * encode time with no diagnostic anywhere. This function lets the
     * CAPTURE GATE itself (not just the encode-time filter) stay off in that
     * case, which also saves the memory/CPU of capturing bodies that can
     * never ship.
     *
     * `cfg == null` mirrors [BreadcrumbRingBuffer.applyConfig]`(null)`'s own
     * default — enabled, all 7 kinds including `network` — so an
     * UNCONFIGURED breadcrumbs block must NOT disable bodies; only an
     * explicit disabled-breadcrumbs or network-excluding block does.
     */
    fun breadcrumbsExcludeNetwork(cfg: BreadcrumbsConfigWire?): Boolean {
        if (cfg == null) return false
        return !cfg.enabled || "network" !in cfg.kinds
    }

    /**
     * Fail-closed composition of server config + client veto + one-shot
     * sampling. `wire == null` (feature off / decode-degraded upstream)
     * always yields `isActive == false`, independent of veto/sampling.
     * The sampling draw happens at most once per process — see file header.
     *
     * Round-6 review Finding F26: [guard], when non-null, is evaluated
     * INSIDE this function's own [lock] — the very first thing done after
     * acquiring it, before any mutation — rather than by the caller
     * checking-then-calling. A caller like `ReplaySession.refreshConfigNow`
     * that checks "is my generation still valid?" and THEN calls this
     * function leaves a window, between that check and this mutation, in
     * which a concurrent `teardown()` can invalidate the generation WHILE
     * this call is blocked acquiring [lock] (e.g. externally held by
     * another thread, per [__holdLockForTesting]) — the check already
     * passed before the block, so the stale call sails through once
     * unblocked. Folding the check into the SAME critical section as the
     * mutation closes that window entirely: either the guard is evaluated
     * (and possibly aborts the mutation) atomically WITH the mutation, or
     * it never runs at all — there is no gap in between the two. `null`
     * (the default) skips the check entirely, so existing callers that
     * don't care about generation validity are unaffected.
     */
    fun applyConfig(
        wire: NetworkBodiesConfigWire?,
        samplingRate: Double,
        locallyDisabled: Boolean,
        random: () -> Double = { Math.random() },
        guard: (() -> Boolean)? = null,
    ) = lock.withLock {
        if (guard != null && !guard()) return@withLock

        val serverOn = wire?.captureBodies == true
        if (serverOn && sampleDraw == null) {
            sampleDraw = random() < samplingRate
        }

        _bodyByteCap = wire?.bodyByteCap ?: defaultBodyByteCap
        _bodyContentTypes = wire?.bodyContentTypes ?: defaultBodyContentTypes

        val newActive = serverOn && !locallyDisabled && sampleDraw == true
        // F34 — bump on ANY change to the effective active bit, not just OFF
        // transitions; a superset of the finding's "at minimum" bar and
        // simpler to reason about (every observably different `active`
        // value gets its own generation).
        if (newActive != active) generation++
        active = newActive
    }

    val isActive: Boolean
        get() = lock.withLock { active }

    /**
     * F34 — a data class holding `(active, generation)` captured together,
     * under one [lock] acquisition, so a caller has a single consistent
     * token: `active` answers "should I start building a body entry right
     * now", and `generation` is what to hand [NetworkBodyRingBuffer.append]'s
     * `guard` parameter so the buffer can re-validate this exact decision —
     * not a possibly-different later one — atomically with the insert.
     */
    data class ActiveSnapshot(val active: Boolean, val generation: Int)

    fun snapshotActive(): ActiveSnapshot = lock.withLock { ActiveSnapshot(active, generation) }

    /**
     * F34 — true iff the gate is CURRENTLY active AND its generation still
     * matches [expected]. Called by [NetworkBodyRingBuffer.append] from
     * INSIDE the buffer's own lock, immediately before the insert — this is
     * the authoritative check the append boundary relies on: a
     * `captureBodies: false` refresh that runs (and bumps [generation], per
     * [applyConfig] above) between a caller's [snapshotActive] and the
     * eventual `append` call is caught here even though nothing else on the
     * append path re-validates it.
     */
    fun isActiveForGeneration(expected: Int): Boolean = lock.withLock { active && generation == expected }

    val bodyByteCap: Int
        get() = lock.withLock { _bodyByteCap }

    val bodyContentTypes: List<String>
        get() = lock.withLock { _bodyContentTypes }

    /** 1-based monotonic per-process request id, used to correlate a
     *  request's captured body with its metadata entry. */
    fun mintReqId(): Int = reqIdCounter.incrementAndGet()

    /**
     * Production reset — called from [dev.everframe.Everframe.kill] (final-review
     * Finding 3: process-lifetime sampling) AND, synchronously, from the
     * START of [dev.everframe.Everframe.start] (round-5 review Finding F23:
     * `start(A) -> start(B)` is not a safe session boundary — see that
     * function's doc comment). Deactivates the gate and restores boot-time
     * defaults, INCLUDING clearing the one-shot `sampleDraw` — a
     * kill()/start() cycle, or a bare superseding start(), is, from the
     * gate's point of view, a new session that may see a new
     * config/samplingRate on its next `applyConfig`, so the sticky draw must
     * not survive across it (only sticky WITHIN a single session's
     * lifetime, per the file-header contract).
     *
     * `reqIdCounter` is reset to 0 rather than kept monotonic: request ids
     * only need to be unique within the body ring buffer's current live
     * window (which `kill()` also zeroizes via `sharedNetworkBodyBuffer
     * .clear()`), so restarting the counter at session boundaries is safe
     * and keeps ids small/readable across a long process lifetime that
     * kills and restarts many times. Mirrors
     * packages/sdk-ios/Sources/Everframe/Capture/NetworkBodyCaptureGate.swift's
     * `reset()`.
     */
    fun reset() = lock.withLock {
        sampleDraw = null
        active = false
        _bodyByteCap = defaultBodyByteCap
        _bodyContentTypes = defaultBodyContentTypes
        reqIdCounter.set(0)
        // F34 — unconditional bump (unlike applyConfig's change-triggered
        // one): reset()/kill() is itself a session boundary, so any token
        // captured before it must be invalidated even if `active` happened
        // to already be false (e.g. a decision made, then killed, before
        // ever reaching an applyConfig that would have flipped `active`).
        generation++
    }

    /** Test-only alias for [reset] — restores boot-time defaults, including
     *  the one-shot sampling draw (so a fresh test can re-draw). Production
     *  code calls [reset] directly (from `kill()`); this name stays for
     *  existing test call sites and readability at test call sites. */
    fun resetForTesting() = reset()

    /**
     * Test-only (round-6 review Finding F26): run [block] while holding
     * this object's OWN [lock] — lets a test reproduce the reviewer's exact
     * repro (hold `NetworkBodyCaptureState`'s lock, not a different
     * buffer's, while a refresh is blocked trying to acquire it inside
     * [applyConfig]). Mirrors
     * [dev.everframe.capture.BreadcrumbRingBuffer.__holdLockForTesting].
     */
    @VisibleForTesting
    internal fun __holdLockForTesting(block: () -> Unit) {
        lock.lock()
        try { block() } finally { lock.unlock() }
    }

    /**
     * Test-only (round-6 review Finding F26): true once at least one other
     * thread is blocked waiting to acquire [lock] — lets a test poll for "a
     * concurrent `applyConfig` call is genuinely blocked on this object's
     * lock" deterministically instead of a fixed sleep. Mirrors
     * [dev.everframe.capture.BreadcrumbRingBuffer.__hasQueuedThreadsForTesting].
     */
    @VisibleForTesting
    internal fun __hasQueuedThreadsForTesting(): Boolean = lock.hasQueuedThreads()
}
