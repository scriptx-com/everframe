// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Process-wide box for the live controller. `start()` installs a fresh one
// (shutting the previous one down — a superseding start() is a session
// boundary). `kill()` DOES shut it down (spec §2 amended — see
// `shutdown()`'s own doc comment): unlike web, Android's registry lives
// inside the controller, not the customer-visible handle, so kill() zeroizes
// it and a new start() rebuilds an empty one.
//
// `trackPlayer` is honoured even before a controller is installed: a call
// arriving before `start()` (or after `kill()`, before the next `start()`)
// is queued and drained, in order, into the freshly installed controller —
// see [DeferredPlayerHandle].
//
// ## Which queued registrations survive a boundary (Codex round-3, Critical 1)
//
// Two different boundaries call [shutdown], and they must treat the queue
// differently:
//
//  - `kill()` ends the session AND revokes what was declared for it. It
//    passes `dropPending = true`: every entry queued under an OLDER KILL
//    GENERATION is dropped (its deferred handle marked detached). Anything
//    queued AFTER that generation moved is a fresh declaration made while
//    killed and survives, exactly like one made before the very first
//    `start()`.
//
//    Codex round-4, #2 — that generation is Everframe's own `_killGeneration`
//    (read through [killGeneration]), not a counter this object bumps when
//    the kill tail happens to arrive. `kill()` bumps it synchronously inside
//    its `stateLock` critical section and only reaches the vitals teardown
//    much later, after unbounded customer teardown; a local counter bumped at
//    THAT point classified everything queued in between as pre-kill and
//    revoked declarations made for the next session. With the tag read from
//    the source of truth, the partition is exact no matter when — or whether
//    — the kill tail gets here: an entry queued before the bump is revoked by
//    whichever of {the kill tail, the next `install`} reaches the queue
//    first, and an entry queued after it survives.
//
//    Codex round-5, #1 — the partition is re-evaluated PER ENTRY as the drain
//    walks the snapshot, not only when the snapshot is taken. A drain runs
//    customer `attach()` between entries, so a whole kill + start can complete
//    inside it; an entry already lifted out of `pending` is unreachable to
//    both the kill tail and the next install, so the drain itself has to
//    notice and revoke it.
//  - a superseding `start()` unpublishes the previous controller but does
//    NOT revoke pending declarations: it passes `dropPending = false`. A
//    `trackPlayer()` made before the first `start()` — or after a `kill()`,
//    while awaiting a restart — is waiting for A SESSION, not for the
//    session that happens to be tearing down, and that is the documented
//    contract ([dev.everframe.Everframe.trackPlayer]'s KDoc). Round 2 made
//    `start()` share `kill()`'s queue-clearing shutdown, which silently
//    detached every pre-start registration the instant `start()` ran — the
//    documented pre-start path never attached at all.
//
// ## Which controller a `trackPlayer` may be handed to (Codex round-5, #4)
//
// "A controller is installed" is NOT the same as "a controller is alive".
// `kill()` bumps the revocation generation inside its `stateLock` critical
// section and unpublishes the controller only at the end of its tail, after
// unbounded customer teardown. `controller` is therefore published together
// with `controllerKillGen`, and `trackPlayer` delegates only while that tag
// still equals `killGeneration()`; otherwise it queues, tagged with the
// current generation, and the next `start()` honours it — the same contract a
// registration made before the very first `start()` gets.
//
// Codex round-8, #3 — and "a controller accepted it" is not the same as "a
// controller answered". `VitalsController.trackPlayer` answers null when it
// has been shut down, which says "not me", not "never". Both callers here —
// this file's `trackPlayer` and [install]'s drain — re-select the controller
// that is current NOW and try again, or queue for the next `install()`;
// neither ever hands the caller, or the deferred handle, the inert delegate a
// superseded controller used to return. Only an INTEGRATION refusal is final.
//
// A queued entry also carries a cancellation callback on its deferred handle
// (round-5, #5): `detach()` before the drain reaches it REMOVES the entry from
// `pending` rather than only marking the handle, so an app that registers and
// detaches without ever starting does not retain every integration (and, for
// media3, every ExoPlayer) it has declared.
//
// Codex round-8, #1 — dropping the entry is only half of it. Every path that
// ends a registration WITHOUT handing it to a controller — the cancellation
// callback above, both revocation paths (`shutdown(dropPending = true)` and
// `install`'s two partitions) — also calls `PlayerIntegration.detach()`, so
// the integration releases what it took at DECLARATION time. media3 subscribes
// a release observer to the customer's ExoPlayer inside `trackPlayer()`,
// before any drain; marking the handle told it nothing, and every revoked
// declaration left one more listener on a long-lived player. See
// [PlayerIntegration.detach]'s contract.
//
// Codex round-9, #1 — and there is a FOURTH such path: an entry the drain
// SKIPS because its handle was detached after the snapshot was taken. The
// cancellation callback deliberately stands down when it cannot find the
// entry in `pending` (whoever lifted it out owns the teardown), so the drain
// is the owner and has to release it. See [install]'s `detachedEarly` branch.
//
// ## Locking (final review, I2)
//
// This object's monitor guards FIELD SWAPS ONLY — `controller`,
// `controllerKillGen`, `subscription`, `pending` — plus `install()`'s predicate (Codex
// round-1, Critical 2: publication and "is this start still the current
// one?" have to be ONE critical section, or a `kill()` landing between the
// check and the publication resurrects a dead session's controller). That
// predicate takes `Everframe.stateLock`, so the lock order is
// runtime-monitor -> stateLock; nothing takes them the other way round
// (`kill()` and `start()` both call `shutdown()` OUTSIDE `stateLock`).
// The monitor is never held across a call into customer code. `install()`, `trackPlayer()` and `shutdown()` all follow the same
// shape: take the monitor, swap fields, snapshot what needs draining, drop
// the monitor, THEN call `VitalsController.trackPlayer()` (which invokes the
// integration's `attach()`) and `VitalsController.shutdown()` (which invokes
// every integration's `detach()`).
//
// Holding the monitor across those calls was a real deadlock: a customer
// `attach()` that calls `Everframe.trackPlayer(...)` re-entrantly is fine on
// the SAME thread (the monitor is reentrant), but an `attach()` that blocks
// on a player lock another thread holds while THAT thread calls
// `trackPlayer()` is a textbook lock-order inversion — and `attach()` is
// customer code, so the SDK cannot make assumptions about what it touches.
package dev.everframe.vitals

import dev.everframe.envelope.txGuardVoid
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

internal object VitalsRuntime {
    /**
     * [killGen] is [killGeneration] as it read when this registration was
     * queued — see the file header. It is what lets a `kill()` drop the
     * declarations made for the session it is ending without also dropping
     * one made a microsecond later, while killed, for the NEXT one.
     */
    private class Pending(
        val integration: PlayerIntegration,
        val name: String?,
        val deferred: DeferredPlayerHandle,
        val killGen: Long,
    )

    /**
     * Stand-in returned by [trackPlayer] before a controller exists. `id` is
     * `""` (never `"p0"` or any other placeholder — matches web's `''`) until
     * [attachDelegate] runs. `track()` before that is dropped (there is
     * nothing to attach to yet); `detach()` before that marks
     * [detachedEarly] so the drain skips it instead of attaching a player the
     * caller already gave up on.
     *
     * Final review, I4: [detach] and [attachDelegate] are both `@Synchronized`
     * on this handle, so the "was it detached?" read and the delegate write
     * cannot interleave. Without that, a `detach()` racing the drain could
     * read `delegate == null`, then have the drain publish a real delegate
     * before `detachedEarly` was written — leaving a registered, attached
     * player nobody holds a live handle to, detached by nothing. The
     * `detachedEarly` check inside [attachDelegate] is what closes the
     * window: a handle detached first hands the freshly built delegate
     * straight back its own `detach()` and stores nothing.
     */
    internal class DeferredPlayerHandle : PlayerHandle {
        @Volatile var delegate: PlayerHandle? = null
            private set
        @Volatile var detachedEarly: Boolean = false
            private set

        /**
         * Codex round-5, #5 — how a pre-start [detach] REMOVES its own queue
         * entry. Marking [detachedEarly] only made the drain skip the entry;
         * the `Pending` itself stayed in the process-wide list until some
         * later install or kill happened to partition it, so an app that
         * registers and detaches without ever calling `start()` retained
         * every integration it had ever declared — and, for media3, the
         * ExoPlayer behind each one. Set by [trackPlayer] when (and only
         * when) the entry is queued; cleared once a real delegate arrives.
         *
         * Lock order: this callback TAKES the runtime monitor, so it is
         * invoked with this handle's own monitor RELEASED — the handle
         * monitor is never held while the runtime monitor is taken.
         */
        @Volatile var onCancel: (() -> Unit)? = null

        override val id: String get() = delegate?.id ?: ""
        override fun track(name: String, data: Any?) { delegate?.track(name, data) }

        /**
         * Codex round-1, Important 1: the DECISION is made under this
         * handle's monitor, the delegate call is made outside it. Holding
         * the monitor across `d.detach()` — customer teardown that may block
         * on a player thread which is itself re-entering this handle — was a
         * deadlock with no upside; the monitor only exists to order the
         * `detachedEarly` write against the `delegate` write.
         */
        override fun detach() {
            var cancel: (() -> Unit)? = null
            val d = synchronized(this) {
                val cur = delegate
                if (cur == null) {
                    detachedEarly = true
                    // Round-5, #5: taken here, invoked below — it reaches for
                    // the runtime monitor, which this one must never nest in.
                    cancel = onCancel
                    onCancel = null
                }
                cur
            }
            cancel?.invoke()
            d?.detach()
        }

        /** Publish the real handle the drain (or a late [trackPlayer] re-check) built. */
        fun attachDelegate(h: PlayerHandle) {
            val rejected = synchronized(this) {
                if (detachedEarly) {
                    true
                } else {
                    delegate = h
                    // The entry is out of `pending` by now; drop the closure
                    // so it stops retaining the integration.
                    onCancel = null
                    false
                }
            }
            if (rejected) h.detach()
        }
    }

    @Volatile private var controller: VitalsController? = null

    /**
     * Codex round-5, #4 — the kill generation [controller] was PUBLISHED
     * under, written beside it in [install]'s critical section.
     *
     * `kill()` bumps `Everframe._killGeneration` synchronously inside its
     * `stateLock` critical section but leaves the old controller published
     * until its long tail — unbounded customer teardown — finally reaches
     * [shutdown]. A `trackPlayer()` arriving in that window delegated to the
     * doomed controller, which the kill tail then detached, and the next
     * `start()` never saw the registration at all: the player was declared
     * for the next session and silently vanished with the old one.
     *
     * [trackPlayer] therefore delegates only to a controller published at the
     * CURRENT generation, and queues otherwise. Only ever read/written under
     * this object's monitor.
     *
     * Codex round-6, #2 — the value published here is read BEFORE [install]'s
     * `isCurrent()` predicate, not after it. Both reach for
     * `Everframe.stateLock` separately, so a `kill()` bumping between them
     * stamped the doomed controller with the generation that revoked it,
     * which defeats this field entirely. Reading first can only ever stamp a
     * controller with a generation that is too OLD, and too old queues.
     */
    private var controllerKillGen: Long = 0
    private var subscription: Job? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val pending = ArrayList<Pending>()

    /**
     * Codex round-3, Critical 1, re-based by round-4 #2 onto Everframe's own
     * revocation counter. Read under this object's monitor — both when an
     * entry is queued and when the queue is partitioned — so the tag and the
     * partition are decided against one consistent value. Injectable ONLY as
     * a test seam ([__setKillGenerationForTesting]); production always reads
     * `Everframe._killGeneration`, which `kill()` bumps synchronously in its
     * `stateLock` critical section.
     *
     * Reading it takes `Everframe.stateLock` while this monitor is held — the
     * one nesting this file already performs (see [install]'s predicate).
     */
    private val DEFAULT_KILL_GENERATION: () -> Long = { dev.everframe.Everframe.currentKillGeneration() }
    @Volatile private var killGeneration: () -> Long = DEFAULT_KILL_GENERATION

    /**
     * Install a freshly built controller as the process-wide live one,
     * shutting down any previous one first, then drain every registration
     * queued by [trackPlayer] calls that arrived before this controller
     * existed — in the order they were made, skipping any whose handle was
     * already [DeferredPlayerHandle.detach]ed.
     *
     * `controller` is published BEFORE the drain runs (and before the
     * monitor is dropped), which is what lets a `trackPlayer` racing this
     * install see the new controller and delegate to it directly rather than
     * queueing into a `pending` list nothing will drain again — see that
     * function's re-check.
     */
    fun install(c: VitalsController, isCurrent: () -> Boolean = { true }) {
        var refused = false
        var revoked: List<Pending> = emptyList()
        val (old, drained) = synchronized(this) {
            // Codex round-6, #2 — the generation is read BEFORE the predicate,
            // not after it. `isCurrent()` and `killGeneration()` each take
            // `Everframe.stateLock` on their own, so a `kill()` can bump
            // between them; reading second stamped the controller with the
            // NEW generation, and post-kill `trackPlayer()` calls then
            // delegated to a controller the kill was already about to detach
            // everything from instead of queueing — those registrations died
            // with the delayed teardown and the next `start()` never saw them.
            //
            // Reading first is the fail-safe direction: a bump inside the
            // window leaves the controller stamped with the OLD generation,
            // so `trackPlayer` sees a mismatch and queues. A registration
            // waiting for the next session is always recoverable; one
            // attached to a doomed controller is not.
            //
            // Codex round-4, #2: whatever a `kill()` revoked but whose tail
            // has not reached the queue yet is revoked HERE instead — the
            // partition is by kill generation, so it does not matter which of
            // the two arrives first. Anything queued at the current
            // generation is a live declaration for this session.
            val now = killGeneration()
            if (!isCurrent()) {
                refused = true
                null to emptyList<Pending>()
            } else {
                val previous = controller
                subscription?.cancel()
                controller = c
                subscription = scope.launch { VitalsServerConfigSignal.flow.collect { cfg -> c.applyServerConfig(cfg) } }
                // Codex round-5, #4 — published together with the controller,
                // in the same critical section, so `trackPlayer` can tell a
                // live controller from one a kill has already doomed.
                controllerKillGen = now
                revoked = pending.filter { it.killGen < now }
                val snapshot = pending.filter { it.killGen >= now }
                pending.clear()
                previous to snapshot
            }
        }
        if (refused) {
            // Outside the monitor — `shutdown()` runs customer `detach()`.
            c.shutdown()
            return
        }
        // Outside the monitor: `shutdown()` detaches every registered player
        // (customer `detach()`), and `trackPlayer()` runs customer `attach()`.
        old?.shutdown()
        for (p in revoked) releasePending(p)
        // Codex round-4, #3 — the drain attaches to whatever controller is
        // CURRENT at each step, re-read atomically under the monitor, not to
        // the `c` this call published. `install(B)` snapshots the queue and
        // then runs customer `attach()` code for every entry; an `install(C)`
        // landing in that window shuts B down, and the rest of B's drain then
        // registered onto a dead controller (inert handles) while C — the
        // live session — never saw those players at all. `target` may
        // legitimately BE C: C is current, so C is where they belong.
        //
        // Codex round-5, #1 — the SAME monitor section re-reads the kill
        // generation, because an entry that was live when the queue was
        // snapshotted may have been revoked since. The drain runs customer
        // `attach()` between entries, so a `kill()` (bumping the generation
        // inside its `stateLock` critical section) and a `start(B)` can both
        // complete inside that window: this entry is no longer in `pending`,
        // so neither the kill tail nor B's own install can revoke it, and the
        // pre-kill integration was attached to B — project A's player source
        // and error data collected under project B. Revoked entries are
        // detached AFTER the loop, outside the monitor.
        //
        // Codex round-8, #3 — and a SHUTDOWN refusal does not advance `i`.
        // `VitalsController.trackPlayer` answers null when it was shut down
        // between this loop's monitor section and the call — B superseded by C
        // is exactly that window — and the entry is then still unplaced: no
        // kill revoked it, and it is already out of `pending`, so committing
        // the inert delegate the controller used to return lost it outright.
        // The loop simply re-enters its monitor section and tries again.
        //
        // It terminates: each iteration either attaches, requeues the
        // remainder, revokes the entry, or observes a controller NEWER than
        // the one that refused. That last part is what [refusedTarget]
        // guarantees rather than assumes — `install`/`shutdown` publish the
        // replacement inside their critical section and call
        // `VitalsController.shutdown()` outside it, so a controller that
        // refuses has already been replaced by the time the monitor is
        // retaken; if it somehow has not, the remainder requeues instead of
        // spinning. Only an app installing controllers forever can keep this
        // going, and that is churn, not a hang.
        var i = 0
        var refusedTarget: VitalsController? = null
        val revokedLate = ArrayList<Pending>()
        while (i < drained.size) {
            val p = drained[i]
            // Codex round-9, #1 — a cancellation that lands MID-DRAIN still
            // has to RELEASE THE INTEGRATION, not merely be skipped.
            // `install()` lifted every queued entry into `drained`, so a
            // customer `detach()` on a later entry's deferred handle — fired,
            // typically, from inside an earlier entry's `attach()` — finds
            // nothing in `pending` and stands down: round-8, #1's rule is that
            // only the caller who actually LIFTED the entry out of the queue
            // owns its teardown, and by then that is this loop. Advancing past
            // the entry without [releasePending] left media3's
            // declaration-time release observer on the customer's ExoPlayer
            // for the life of the process — one more per cancelled
            // declaration, on a player that may outlive many sessions.
            //
            // Called OUTSIDE this object's monitor, like every other call into
            // customer code in this loop body, and idempotent against the
            // handle's own `detach()`: the deferred handle has no delegate and
            // already dropped its `onCancel`, so `releasePending` reduces to
            // the `integration.detach()` nobody else ran.
            if (p.deferred.detachedEarly) { releasePending(p); i++; refusedTarget = null; continue }
            var revoke = false
            var requeued = false
            val target = synchronized(this) {
                if (p.killGen < killGeneration()) {
                    revoke = true
                    null
                } else {
                    controller?.takeIf { it !== refusedTarget } ?: run {
                        // No controller at all (a `kill()`/superseding `start()`
                        // took it), or only the one that just refused this
                        // entry for shutdown: the remainder — this entry
                        // included — goes back to the FRONT of the queue so
                        // declaration order survives, and the next install
                        // drains it.
                        pending.addAll(0, drained.subList(i, drained.size))
                        requeued = true
                        null
                    }
                }
            }
            if (revoke) { revokedLate.add(p); i++; refusedTarget = null; continue }
            if (requeued || target == null) break
            val handle = target.trackPlayer(p.integration, p.name)
            if (handle == null) { refusedTarget = target; continue }
            p.deferred.attachDelegate(handle)
            i++
            refusedTarget = null
        }
        // Outside the monitor — marking a deferred handle detached can call
        // into a delegate's `detach()`.
        for (p in revokedLate) releasePending(p)
    }

    /**
     * Codex round-8, #1 — a revoked or cancelled registration releases its
     * INTEGRATION, not only its handle.
     *
     * A `Pending` that never reached a controller has no delegate, so
     * `deferred.detach()` marks the handle and stops. Nothing then told the
     * integration the declaration was over — and media3's integration
     * subscribes a release observer to the customer's ExoPlayer at
     * `trackPlayer()` time, before any drain. Every revoked declaration on a
     * long-lived player therefore left one more listener behind, retaining
     * the objects behind it. `PlayerIntegration.detach()` is documented to
     * tolerate a never-attached integration and to emit nothing in that case
     * (see its KDoc).
     *
     * Called OUTSIDE this object's monitor, like every other call into
     * customer code, and `txGuardVoid`-wrapped because a customer `detach()`
     * may throw — a revocation loop must not die halfway through.
     */
    private fun releasePending(p: Pending) {
        p.deferred.detach()
        txGuardVoid("PlayerIntegration.detach") { p.integration.detach() }
    }

    /**
     * Attach a player integration. Delegates immediately when a controller is
     * installed AND still belongs to the current kill generation; otherwise
     * the registration is queued and honoured the moment [install] runs next.
     *
     * Codex round-5, #4 — "installed" is not enough. `kill()` bumps the
     * revocation generation inside its `stateLock` critical section and only
     * unpublishes the controller much later, so between the two this call
     * would otherwise hand the player to a controller the kill is about to
     * detach everything from, and the next `start()` would never see it. See
     * [controllerKillGen].
     */
    fun trackPlayer(integration: PlayerIntegration, name: String?): PlayerHandle {
        // Codex round-8, #3 — a `null` here is a SHUTDOWN refusal, and it is
        // transient: this controller is no longer the one, but another is or
        // will be. It must fall through to the queueing path below, never to
        // the caller, or a registration nothing revoked is lost. An
        // INTEGRATION refusal is a (non-null) inert handle and is returned as
        // it always was.
        var refusedTarget: VitalsController? = null
        synchronized(this) { liveControllerLocked() }?.let { live ->
            live.trackPlayer(integration, name)?.let { return it }
            refusedTarget = live
        }

        val deferred = DeferredPlayerHandle()
        // The generation is read under the SAME monitor the append happens
        // under, so a `kill()` cannot bump it between the read and the append
        // and take this registration with it.
        // Decide and append under ONE critical section. [install] publishes
        // `controller` and snapshots `pending` under the same monitor but
        // drains outside it, so a controller that appeared between the read
        // above and this block would never see `entry`. Either this block
        // runs before install's snapshot (entry is in it, and no live
        // controller is visible here) or after it (no entry is queued, and we
        // delegate ourselves) — exactly one of the two paths registers the
        // player.
        //
        // Round-8, #3: the loop retries against whatever controller is
        // current after a shutdown refusal, and queues once the only one on
        // offer is the one that just refused — same shape, and the same
        // termination argument, as [install]'s drain.
        while (true) {
            val late = synchronized(this) {
                val live = liveControllerLocked()?.takeIf { it !== refusedTarget }
                if (live == null) {
                    val entry = Pending(integration, name, deferred, killGeneration())
                    pending.add(entry)
                    // Codex round-5, #5 — a `detach()` before the drain reaches
                    // this entry must REMOVE it, not merely mark the handle. The
                    // handle is still local to this frame, so nothing can invoke
                    // the callback before it is wired.
                    //
                    // Codex round-8, #1 — and it must RELEASE the integration,
                    // which for media3 is holding a release observer on the
                    // customer's player from declaration time. Only the caller
                    // that actually lifted the entry out of `pending` does so: if
                    // `removeAll` finds nothing, the drain (or a revocation) has
                    // already taken this entry and owns its teardown. The detach
                    // is made outside this object's monitor for the usual reason —
                    // it is customer code.
                    deferred.onCancel = {
                        val removed = synchronized(this@VitalsRuntime) { pending.removeAll { it === entry } }
                        if (removed) txGuardVoid("PlayerIntegration.detach") { integration.detach() }
                    }
                }
                live
            }
            if (late == null || deferred.detachedEarly) return deferred
            val handle = late.trackPlayer(integration, name)
            if (handle != null) {
                deferred.attachDelegate(handle)
                return deferred
            }
            refusedTarget = late
        }
    }

    /**
     * The controller a registration may be handed to RIGHT NOW: published,
     * and published at the generation still in force. Called with this
     * object's monitor HELD (it reads `Everframe.stateLock` through
     * [killGeneration] — the runtime-monitor -> stateLock nesting this file
     * already performs).
     */
    private fun liveControllerLocked(): VitalsController? =
        controller?.takeIf { controllerKillGen == killGeneration() }

    fun current(): VitalsController? = controller
    fun currentStamp(): VitalsStamp? = controller?.currentStamp()

    /**
     * Tears down the live controller — detaches every registered player and
     * clears its registry (the final summary send is silenced because
     * `captureGate` is already closed by the time `kill()` calls this) —
     * and drops it. Called from `Everframe.kill()`, from `Everframe.start()`'s
     * session boundary, and from [resetForTesting].
     *
     * @param dropPending Codex round-3, Critical 1. `true` (the `kill()`
     * form) bumps [boundaryGeneration] and revokes every registration queued
     * in an older generation; `false` (the superseding-`start()` form) leaves
     * the queue completely alone, because those registrations are awaiting a
     * session and `start()` is about to provide one. See the file header.
     *
     * @param ifCurrent Codex round-3, Critical 2. Evaluated INSIDE this
     * object's monitor. `start()` reserves its start generation before it
     * calls this, and passes a predicate that answers "is my generation still
     * the newest?"; a `start(B)` descheduled long enough for `start(C)` to
     * run to completion — install included — would otherwise unpublish and
     * shut down C's freshly installed controller on its way past. Refusing
     * INSIDE the monitor is what makes it exact: a `start(C)` that publishes
     * after the predicate answered true is ordered behind this whole critical
     * section, and B's own post-check then refuses to publish B. Lock order:
     * runtime-monitor -> `Everframe.stateLock`, identical to [install]'s
     * predicate and never taken the other way round.
     */
    fun shutdown(dropPending: Boolean = true, ifCurrent: () -> Boolean = { true }) {
        val (old, dropped) = synchronized(this) {
            if (!ifCurrent()) return
            subscription?.cancel(); subscription = null
            val previous = controller
            controller = null
            val queued: List<Pending>
            if (dropPending) {
                // Partition against the CURRENT kill generation. A
                // registration queued during project A's delayed start used to
                // survive kill() and be attached — and described — under
                // project B on the next start(), crossing the session/project
                // boundary the kill drew. Anything queued at or after the
                // generation this kill established carries the NEW tag and
                // stays queued for the next start(), exactly like one made
                // before the very first start().
                //
                // Codex round-4, #2: read from Everframe rather than bumped
                // here, so a kill tail that arrives late revokes exactly what
                // was declared before its OWN bump — not everything that has
                // been declared since. See the file header.
                val now = killGeneration()
                queued = pending.filter { it.killGen < now }
                pending.removeAll { it.killGen < now }
            } else {
                queued = emptyList()
            }
            previous to queued
        }
        // Outside the monitor for the same reason as install()'s: this call
        // runs every integration's customer `detach()`, and marking a
        // deferred handle detached can call into a delegate's `detach()`.
        old?.shutdown()
        for (p in dropped) releasePending(p)
    }

    internal fun resetForTesting() {
        shutdown()
        synchronized(this) {
            pending.clear()
            controllerKillGen = 0
            killGeneration = DEFAULT_KILL_GENERATION
        }
    }

    /**
     * Codex round-5, #5 — the queue is process-wide and private, so the leak
     * it fixes ("the `Pending` survives a pre-start `detach()`") is only
     * observable through its size.
     */
    internal fun pendingCountForTesting(): Int = synchronized(this) { pending.size }

    /**
     * Codex round-4, #2 — drive the revocation generation directly, so a test
     * can express "this entry was declared before the kill" / "…after it"
     * without standing up a whole `Everframe.start()`/`kill()` cycle. Cleared
     * by [resetForTesting].
     */
    internal fun __setKillGenerationForTesting(source: () -> Long) {
        synchronized(this) { killGeneration = source }
    }
}
