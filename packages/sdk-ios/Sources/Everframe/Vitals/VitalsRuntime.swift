// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Process-wide box for the live controller — port of VitalsRuntime.kt. Read
// that file's header for the four rules: (1) kill() revokes queued
// declarations OLDER than its generation, a superseding start() keeps them;
// (2) a controller is delegated to only while its published kill generation
// is still current; (3) a SHUTDOWN refusal (nil) re-selects or requeues,
// only an INTEGRATION refusal (inert handle) is final; (4) every path that
// ends a registration without handing it to a controller calls
// PlayerIntegration.detach() so declaration-time resources are released.
//
// Locking: `lock` guards field swaps and install()'s predicate ONLY; it is
// never held across customer code (attach/detach/shutdown). Two different
// Everframe locks are reached from inside it, and the difference matters
// (round-1, O5): the `isCurrent`/`ifCurrent` PREDICATES read
// `currentStartEpoch`, which takes `_startEpochMirrorLock` — a documented
// leaf that acquires nothing else — while `killGeneration()` is the one that
// takes Everframe.stateLock. So the nesting to respect is runtime lock →
// stateLock; start() and kill() call shutdown() OUTSIDE stateLock, and
// trackPlayer takes neither.
import Foundation
import EverframeProtocol

final class VitalsRuntime: @unchecked Sendable {
    static let shared = VitalsRuntime()

    /// `killGen` is `killGeneration()` as it read when this registration was queued. It is
    /// what lets a kill() drop the declarations made for the session it is ending without
    /// also dropping one made a microsecond later, while killed, for the NEXT one.
    private final class Pending {
        let integration: PlayerIntegration
        let name: String?
        let deferred: DeferredPlayerHandle
        let killGen: UInt64
        init(integration: PlayerIntegration, name: String?, deferred: DeferredPlayerHandle, killGen: UInt64) {
            self.integration = integration; self.name = name; self.deferred = deferred; self.killGen = killGen
        }
    }

    private let lock = NSLock()
    private var controller: VitalsController?
    /// The kill generation `controller` was PUBLISHED under, written beside it in install()'s
    /// critical section (round-5, #4): kill() bumps Everframe's counter synchronously inside its
    /// own stateLock section but leaves the old controller published until its long tail. A
    /// trackPlayer() in that window must queue, not delegate to a controller the kill has doomed.
    private var controllerKillGen: UInt64 = 0
    /// `Everframe._startEpoch` the published controller was BUILT FOR, written beside it in
    /// install()'s critical section (codex round-1, Critical 1). It is what lets an envelope
    /// ask for "the vitals of the session THIS report was captured under" instead of "the
    /// vitals of whatever session is installed now": a report assembled across a superseding
    /// `start()` would otherwise be stamped with the NEXT project's session id and timeline.
    /// `nil` = installed without a session (tests only); a production install always binds one.
    private var controllerStartEpoch: Int?
    private var subscription: VitalsSubscription?
    private var pending: [Pending] = []
    private var killGeneration: () -> UInt64 = { Everframe.currentKillGeneration() }

    private func withLock<T>(_ body: () -> T) -> T { lock.lock(); defer { lock.unlock() }; return body() }

    /// Publish `c` (shutting the previous one down), then drain the queue in declaration order
    /// against whatever controller is CURRENT at each step.
    func install(_ c: VitalsController, startEpoch: Int? = nil, isCurrent: () -> Bool) {
        var refused = false
        var revoked: [Pending] = []
        let (old, drained): (VitalsController?, [Pending]) = withLock {
            let now = killGeneration()          // read BEFORE the predicate (round-6, #2)
            guard isCurrent() else { refused = true; return (nil, []) }
            let previous = controller
            subscription?.cancel()
            controller = c
            subscription = VitalsServerConfigBox.shared.subscribe { cfg in c.applyServerConfig(cfg) }
            controllerKillGen = now
            controllerStartEpoch = startEpoch
            revoked = pending.filter { $0.killGen < now }
            let snapshot = pending.filter { $0.killGen >= now }
            pending.removeAll()
            return (previous, snapshot)
        }
        if refused { c.shutdown(); return }
        // Outside the lock: shutdown() runs every integration's customer detach(), and
        // trackPlayer() runs customer attach().
        old?.shutdown()
        revoked.forEach(releasePending)

        // Round-4 #3 / round-5 #1 / round-8 #3: each step re-reads, under ONE critical section,
        // both the controller that is current NOW and the kill generation, because the drain
        // runs customer attach() between entries and a whole kill + start can complete inside
        // it. A shutdown refusal does NOT advance `i` — the entry is out of `pending`, so
        // committing the controller's inert delegate would lose it outright.
        //
        // It terminates: each iteration either attaches, requeues the remainder, revokes the
        // entry, or observes a controller NEWER than the one that refused (`refusedTarget`).
        var i = 0
        var refusedTarget: VitalsController?
        // Entries the drain must release rather than hand on: revoked by a kill generation that
        // moved, or cancelled while they were out of `pending`. Released after the loop, outside
        // the lock, because `releasePending` runs a customer `detach()`.
        var releasedLate: [Pending] = []
        while i < drained.count {
            let p = drained[i]
            // Round-9, #1: a cancellation that lands mid-drain finds nothing in `pending`
            // (this call lifted every entry out of it) and stands down, so the drain owns the
            // teardown and has to RELEASE THE INTEGRATION, not merely skip the entry.
            if p.deferred.detachedEarly { releasePending(p); i += 1; refusedTarget = nil; continue }
            var revoke = false, requeued = false
            let target: VitalsController? = withLock {
                if p.killGen < killGeneration() { revoke = true; return nil }
                if let live = controller, live !== refusedTarget { return live }
                // No controller at all, or only the one that just refused this entry for
                // shutdown: the remainder — this entry included — goes back to the FRONT of the
                // queue so declaration order survives, and the next install drains it.
                //
                // Codex round-5, W5-I3 — but only what is still LIVE goes back. This call lifted
                // every entry out of `pending`, so a `detach()` landing on any of them mid-drain
                // found nothing to remove and stood down, leaving the drain to own the teardown
                // (the same rule the `detachedEarly` check at the top of the loop obeys).
                // Requeueing the remainder wholesale resurrected such an entry with its
                // cancellation callback already consumed: nothing would release its integration
                // or its declaration-time resources until some LATER install or revocation, long
                // after `detach()` returned. The check is inside THIS critical section, so it is
                // one step with the requeue — a cancellation racing it either is seen here (and
                // its own callback then finds nothing in `pending`, so exactly one path
                // releases), or lands after the entry is back in `pending` and removes it itself.
                //
                // Reading `detachedEarly` takes the handle's lock while this one is held. That is
                // the only direction that exists: `onCancel` is invoked with the handle lock
                // RELEASED, so the handle lock never leads back to this one.
                var live: [Pending] = []
                for e in drained[i...] {
                    if e.deferred.detachedEarly { releasedLate.append(e) } else { live.append(e) }
                }
                pending.insert(contentsOf: live, at: 0)
                requeued = true
                return nil
            }
            if revoke { releasedLate.append(p); i += 1; refusedTarget = nil; continue }
            guard !requeued, let live = target else { break }
            guard let handle = live.trackPlayer(p.integration, name: p.name) else { refusedTarget = live; continue }
            p.deferred.attachDelegate(handle)
            i += 1; refusedTarget = nil
        }
        // Outside the lock — marking a deferred handle detached can call into a delegate's detach().
        releasedLate.forEach(releasePending)
    }

    /// Round-8, #1 — a revoked or cancelled registration releases its INTEGRATION, not only its
    /// handle: media3 subscribes a release observer to the customer's player at declaration
    /// time. Called OUTSIDE `lock`, and `dispatch`-wrapped because a customer detach() may throw.
    private func releasePending(_ p: Pending) {
        p.deferred.detach()
        dispatch("PlayerIntegration.detach") { p.integration.detach() }
    }

    /// Attach a player integration. Delegates immediately when a controller is installed AND
    /// still belongs to the current kill generation; otherwise the registration is queued and
    /// honoured the moment install() runs next.
    func trackPlayer(_ integration: PlayerIntegration, name: String?) -> PlayerHandle {
        // Round-8, #3 — a nil here is a SHUTDOWN refusal, and it is transient: this controller
        // is no longer the one, but another is or will be. It must fall through to the queueing
        // path below, never to the caller. An INTEGRATION refusal is a (non-nil) inert handle.
        var refusedTarget: VitalsController?
        // Round-4, #2 — the kill generation this DECLARATION was made in, read ONCE and in the
        // same critical section as the first controller selection, then preserved through every
        // refusal and retry below. Re-reading it was the defect: a customer `attach()` blocking
        // inside `live.trackPlayer` gives a kill() all the time it needs to bump the generation
        // and take that controller down, after which the retry saw the POST-kill generation and
        // either queued the entry for the next session or handed it straight to a controller
        // already installed for one. A player declared against a killed session then started
        // collecting in the next session without the customer declaring it there.
        //
        // A generation that has MOVED is therefore terminal (`killed` below): the registration is
        // disposed of and an inert — already-detached — handle is returned. One that has NOT
        // moved keeps retrying, which is what a superseding `start()` needs.
        let (declaredIn, first): (UInt64, VitalsController?) = withLock { (killGeneration(), liveControllerLocked()) }
        if let live = first {
            if let h = live.trackPlayer(integration, name: name) { return h }
            refusedTarget = live
        }
        let deferred = DeferredPlayerHandle()
        while true {
            // Decide and append under ONE critical section: install() publishes `controller`
            // and snapshots `pending` under the same lock but drains outside it, so exactly one
            // of {this block queues, install's drain sees it} ever registers the player.
            var killed = false
            let late: VitalsController? = withLock {
                guard declaredIn == killGeneration() else { killed = true; return nil }
                if let live = liveControllerLocked(), live !== refusedTarget { return live }
                let entry = Pending(integration: integration, name: name, deferred: deferred, killGen: declaredIn)
                pending.append(entry)
                // Round-5 #5 / round-8 #1 — a detach() before the drain reaches this entry
                // REMOVES it and releases the integration. Only the caller that actually lifted
                // the entry out of `pending` does so; if it finds nothing, a drain or a
                // revocation already owns the teardown. The handle is still local to this frame,
                // so nothing can fire the callback before it is wired.
                deferred.onCancel = { [weak self] in
                    guard let self else { return }
                    let removed: Bool = self.withLock {
                        let before = self.pending.count
                        self.pending.removeAll { $0 === entry }
                        return self.pending.count != before
                    }
                    if removed { dispatch("PlayerIntegration.detach") { integration.detach() } }
                }
                return nil
            }
            if killed {
                // The session this player was declared for has been killed while its attach was
                // in flight. Mark the handle so a delegate can never be attached to it, and
                // release the integration: a controller's SHUTDOWN refusal is an attachment
                // ROLLBACK (it puts the declaration-time resources back for the retry that is
                // no longer coming), so this is the disposal rule (4) owes it.
                deferred.detach()
                dispatch("PlayerIntegration.detach") { integration.detach() }
                return deferred
            }
            guard let late, !deferred.detachedEarly else { return deferred }
            if let h = late.trackPlayer(integration, name: name) { deferred.attachDelegate(h); return deferred }
            refusedTarget = late
        }
    }

    /// The controller a registration may be handed to RIGHT NOW: published, and published at
    /// the generation still in force. Called with `lock` HELD (it takes Everframe.stateLock
    /// through `killGeneration` — the runtime lock → stateLock nesting this file performs).
    private func liveControllerLocked() -> VitalsController? {
        guard let c = controller, controllerKillGen == killGeneration() else { return nil }
        return c
    }

    func current() -> VitalsController? { withLock { controller } }
    /// UNBOUND: whatever session is installed right now. Test/diagnostic only — an envelope
    /// must ask for its OWN session through `stamp(forStartEpoch:)`, or a report assembled
    /// across a `start()` ships the next project's vitals (codex round-1, Critical 1).
    func currentStamp() -> VitalsStamp? { current()?.currentStamp() }

    /// The stamp for the session a report was CAPTURED under, or nil when that session is no
    /// longer the installed one. The controller and the epoch it was published for are read in
    /// ONE critical section, so a `start()` landing beside this read can only ever make the
    /// answer nil — never pair the caller's epoch with another session's controller. The
    /// collector's own (100 ms bounded) read runs outside the lock: a controller selected here
    /// and shut down a moment later stamps nothing, which is the same "no vitals" degradation.
    func stamp(forStartEpoch epoch: Int?) -> VitalsStamp? {
        let c: VitalsController? = withLock { controllerStartEpoch == epoch ? controller : nil }
        return c?.currentStamp()
    }

    /// `dropPending: true` = the kill() form (revokes entries older than the current kill
    /// generation); `false` = the superseding-start() form (queue untouched). `ifCurrent` is
    /// evaluated INSIDE the lock (round-3, Critical 2).
    func shutdown(dropPending: Bool, ifCurrent: () -> Bool) {
        var dropped: [Pending] = []
        let old: VitalsController?? = withLock {
            guard ifCurrent() else { return nil }
            subscription?.cancel(); subscription = nil
            let previous = controller
            controller = nil
            controllerStartEpoch = nil
            if dropPending {
                let now = killGeneration()
                dropped = pending.filter { $0.killGen < now }
                pending.removeAll { $0.killGen < now }
            }
            return .some(previous)
        }
        guard let old else { return }
        old?.shutdown()
        dropped.forEach(releasePending)
    }

    func resetForTesting() {
        shutdown(dropPending: true, ifCurrent: { true })
        withLock { pending.removeAll(); controllerKillGen = 0; controllerStartEpoch = nil; killGeneration = { Everframe.currentKillGeneration() } }
    }
    /// Round-5, #5 — the queue is process-wide and private, so the leak it fixes is only
    /// observable through its size.
    var pendingCountForTesting: Int { withLock { pending.count } }
    /// Round-4, #2 — drive the revocation generation directly, so a test can express "this
    /// entry was declared before the kill" without standing up a whole start()/kill() cycle.
    func __setKillGenerationForTesting(_ source: (() -> UInt64)?) {
        withLock { killGeneration = source ?? { Everframe.currentKillGeneration() } }
    }
}

/// Stand-in handle returned before a controller exists. `id` is "" until the drain attaches a
/// delegate. The decision ("was it detached?") is made under this handle's lock; the delegate
/// call is made outside it (round-1, Important 1).
final class DeferredPlayerHandle: PlayerHandle, @unchecked Sendable {
    private let lock = NSLock()
    private var _delegate: PlayerHandle?
    private var _detachedEarly = false
    /// Lock order: this callback TAKES the runtime lock, so it is invoked with this handle's
    /// own lock RELEASED — the handle lock is never held while the runtime lock is taken.
    var onCancel: (() -> Void)? {
        get { lock.lock(); defer { lock.unlock() }; return _onCancel }
        set { lock.lock(); _onCancel = newValue; lock.unlock() }
    }
    private var _onCancel: (() -> Void)?

    var delegate: PlayerHandle? { lock.lock(); defer { lock.unlock() }; return _delegate }
    var detachedEarly: Bool { lock.lock(); defer { lock.unlock() }; return _detachedEarly }
    var id: String { delegate?.id ?? "" }

    func track(_ name: String, data: Any?) { delegate?.track(name, data: data) }

    func detach() {
        var cancel: (() -> Void)?
        lock.lock()
        let d = _delegate
        if d == nil { _detachedEarly = true; cancel = _onCancel; _onCancel = nil }
        lock.unlock()
        cancel?()
        d?.detach()
    }

    /// Publish the real handle the drain (or a late trackPlayer re-check) built. A handle
    /// detached first hands the freshly built delegate straight back its own detach().
    func attachDelegate(_ h: PlayerHandle) {
        lock.lock()
        let rejected = _detachedEarly
        if !rejected { _delegate = h; _onCancel = nil }
        lock.unlock()
        if rejected { h.detach() }
    }
}
