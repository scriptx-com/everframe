// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// iOS twin of VitalsController.kt (→ sdk-web vitals/index.ts). Owns the start
// gate, the collector/sampler lifecycle and the registry. Read the Kotlin
// file's header for the full account of the three rules this file keeps:
//
//  1. `lock` guards FIELD SWAPS AND REGISTRATION SNAPSHOTS ONLY. Take it, swap
//     fields, snapshot what has to be driven, drop it, THEN drive it.
//  2. A registration's `announceLock` orders its player_attach against its
//     player_detach. NO rotation callback and NO customer code runs under it:
//     every record made while holding it is DEFERRED and fired afterwards;
//     `library`/`version` and the customer `data` map are read/coerced BEFORE it.
//  3. `announcedIn` (collector + session the attach LANDED in) is where every
//     player emission goes — a describe emit, a live callback, a handle's
//     custom entry, the detach marker. The session id travels as
//     `expectedSessionId` so the collector checks it atomically with admission.
import Foundation
import EverframeProtocol

protocol VitalsLifecycleHandle: AnyObject, Sendable {
    func install()
    func uninstall()
}

#if canImport(UIKit)
extension VitalsLifecycleObserver: VitalsLifecycleHandle {}
#endif

final class VitalsController: @unchecked Sendable {
    struct Deps {
        var localConfig: VitalsConfig
        var dims: SessionSummaryDims
        var transport: @Sendable () -> VitalsSink
        var scheduler: VitalsScheduler
        var samplerFactory: @Sendable (_ onSample: @escaping @Sendable (VitalsSample) -> Void, _ onTick: @escaping @Sendable () -> Void) -> ResourceSampler
        var lifecycle: @Sendable (_ onForeground: @escaping @Sendable () -> Void, _ onBackground: @escaping @Sendable () -> Void) -> VitalsLifecycleHandle?
        var now: @Sendable () -> Int64
        var random: @Sendable () -> Double
        var newSessionId: @Sendable () -> String
        var collectorOverrides: @Sendable (VitalsCollector.Deps) -> VitalsCollector.Deps

        init(localConfig: VitalsConfig, dims: SessionSummaryDims, transport: @escaping @Sendable () -> VitalsSink, scheduler: VitalsScheduler,
             samplerFactory: @escaping @Sendable (_ onSample: @escaping @Sendable (VitalsSample) -> Void, _ onTick: @escaping @Sendable () -> Void) -> ResourceSampler,
             lifecycle: @escaping @Sendable (_ onForeground: @escaping @Sendable () -> Void, _ onBackground: @escaping @Sendable () -> Void) -> VitalsLifecycleHandle?,
             now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
             random: @escaping @Sendable () -> Double = { Double.random(in: 0..<1) },
             newSessionId: @escaping @Sendable () -> String = { UUID().uuidString.lowercased() },
             collectorOverrides: @escaping @Sendable (VitalsCollector.Deps) -> VitalsCollector.Deps = { $0 }) {
            self.localConfig = localConfig; self.dims = dims; self.transport = transport; self.scheduler = scheduler
            self.samplerFactory = samplerFactory; self.lifecycle = lifecycle; self.now = now; self.random = random
            self.newSessionId = newSessionId; self.collectorOverrides = collectorOverrides
        }
    }

    static let detachDrainTimeoutMs: Int64 = 250
    private static let unknownPlayerLibrary = "unknown"
    private struct DetachDrainTimeout: Error {}

    private let deps: Deps
    private let lock = NSLock()
    private let registry = PlayerRegistry()
    private var collector: VitalsCollector?
    private var sampler: ResourceSampler?
    private var lifecycle: VitalsLifecycleHandle?
    private var sink: VitalsSink?
    private var draw: Bool?
    /// Sinks a server disable handed to `finish(timeoutMs:)` and that have not yet run out their
    /// grace window (codex round-2, #5). `stopCollectorLocked` clears the `sink` FIELD, so a
    /// `kill()` landing while those final requests are still on the wire found nothing to close
    /// and they kept transmitting for the rest of the 5 s timeout — the transport's kill
    /// predicate only guards NEW attempts, never one already resumed. `shutdown()` closes every
    /// one of these; each entry drops itself once its own grace window has expired.
    private var finishingSinks: [VitalsSink] = []
    private var isShutdown = false
    /// Tags every enable/disable transition so an enable TAIL running outside `lock` can tell it was superseded.
    private var generation = 0

    init(deps: Deps) { self.deps = deps }

    private func withLock<T>(_ body: () -> T) -> T { lock.lock(); defer { lock.unlock() }; return body() }

    var isRunning: Bool { withLock { collector != nil } }

    // MARK: gate

    func applyServerConfig(_ cfg: VitalsServerConfig?) {
        dispatch("VitalsController.applyServerConfig") {
            var after: (() -> Void)?
            withLock {
                guard !isShutdown else { return }
                let wants = cfg.map { $0.vitalsEnabled && deps.localConfig.enabled != false && drawOnce(serverRate: $0.vitalsSampleRate) } ?? false
                if wants && collector == nil { after = startCollectorLocked() }
                else if !wants && collector != nil { after = stopCollectorLocked() }
            }
            after?()
        }
    }

    /// Called under `lock`. One draw per controller, cached — a raised rate never re-rolls.
    private func drawOnce(serverRate: Double) -> Bool {
        if let d = draw { return d }
        let rate = min(max(min(deps.localConfig.sampleRate ?? 1.0, serverRate), 0.0), 1.0)
        let d = deps.random() < rate
        draw = d
        return d
    }

    /// Called under `lock`. Transactional (Android round-2, Important 6): nothing is
    /// published unless every part was built. Returns the tail to run outside `lock`.
    private func startCollectorLocked() -> (() -> Void)? {
        let sk = deps.transport()
        let selfBox = CollectorBox()
        let base = VitalsCollector.Deps(
            dims: deps.dims, now: deps.now,
            send: { payload in
                guard let data = try? VitalsWireCodec.encodeRequest(payload) else { return }
                sk.send(data)
            },
            newSessionId: deps.newSessionId, scheduler: deps.scheduler,
            onRotate: { [weak self] trigger in
                // Round-2, Important 4: reseed the collector this rotation happened IN, never the current field.
                guard let self, let c = selfBox.value else { return }
                self.reseed(c, trigger: trigger)
            })
        let c = VitalsCollector(deps: deps.collectorOverrides(base))
        selfBox.value = c
        let sam = deps.samplerFactory({ sample in c.recordSample(sample) }, { [weak self] in self?.collectStats() })
        let obs = deps.lifecycle({ sam.resume() }, { sam.pause(); c.flushNow() })
        collector = c; sampler = sam; lifecycle = obs; sink = sk
        generation += 1
        let gen = generation
        let existing = registry.live()
        return { [self] in
            for r in existing { announce(c, r) }
            sam.start()
            obs?.install()
            // Round-2, Critical 2: a disable/kill that landed while the two calls above ran
            // already stopped the sampler it captured. Undo what this tail resurrected.
            if withLock({ generation != gen }) {
                obs?.uninstall()
                sam.stop()
            }
        }
    }

    /// The back-reference `onRotate` reseeds through. WEAK on purpose: the collector keeps
    /// `deps` in an immutable `let` that `stop()` never clears, so a strong box would close a
    /// permanent `c -> deps.onRotate -> box -> c` cycle (dragging the sink in through
    /// `deps.send`) and leak one collector per enable. Nothing is lost: while the collector is
    /// live it is retained by the `collector` field and by the enable tail's captured `c`, and
    /// during a rotation it is on the stack of the very call that fires the callback — a
    /// stopped collector reads nil, which is the right answer for a reseed anyway.
    private final class CollectorBox: @unchecked Sendable {
        private let l = NSLock(); private weak var _v: VitalsCollector?
        var value: VitalsCollector? { get { l.lock(); defer { l.unlock() }; return _v } set { l.lock(); _v = newValue; l.unlock() } }
    }

    /// How long a server-disabled sink is given to land the trailing chunk and the final
    /// summary before whatever is still in flight is cancelled (round-1, #9).
    static let sinkFinishTimeoutMs: Int64 = 5_000

    /// Called under `lock`; the returned tail stops everything outside it, each step guarded independently.
    private func stopCollectorLocked() -> () -> Void {
        generation += 1
        let l = lifecycle, s = sampler, c = collector, k = sink
        lifecycle = nil; sampler = nil; collector = nil; sink = nil
        // Round-2, #5 — held until its grace window is over, so a kill() can still cancel it.
        if let k { finishingSinks.append(k) }
        return {
            dispatch("VitalsController.stop.lifecycle") { l?.uninstall() }
            dispatch("VitalsController.stop.sampler") { s?.stop() }
            dispatch("VitalsController.stop.collector") { c?.stop() }
            // AFTER the collector's own stop(), so the final summary still goes out before the
            // sink closes — and GRACEFULLY (round-1, #9): `c.stop()` has just handed this sink
            // the trailing chunk and the final summary as asynchronous URLSession tasks, and
            // `close()` cancels every in-flight task, so with any ordinary connection delay
            // neither request landed. `finish` stops new sends and retries at once but lets what
            // is already on the wire complete, cancelling the remainder after the timeout.
            // `shutdown()` — kill(), a superseding start() — still closes immediately.
            dispatch("VitalsController.stop.sink") { k?.finish(timeoutMs: Self.sinkFinishTimeoutMs) }
            // …and stop holding it once that window has closed. The sink cancels its own
            // remainder at the same deadline; this only keeps the controller from accumulating
            // one dead reference per server disable.
            if let k {
                VitalsQueue.shared.asyncAfter(deadline: .now() + .milliseconds(Int(Self.sinkFinishTimeoutMs))) { [weak self] in
                    guard let self else { return }
                    self.withLock { self.finishingSinks.removeAll { $0 === k } }
                }
            }
        }
    }

    // MARK: players

    /// The customer-facing emit path. `boundAnnouncement` is non-nil for a describe()
    /// context (bound by IDENTITY to the announcement it was made for — round-6, #4)
    /// and nil for attach() and live player callbacks.
    ///
    /// The controller reference is WEAK, not unowned: a customer integration may hold
    /// its context past a superseding `start()`/`kill()`, and a dangling `unowned`
    /// would trap in the host app. A strong one would cycle
    /// controller → registry → registration → integration → ctx for every integration
    /// that never nils its context. Once the controller is gone every emission is
    /// refused, which is what a dead controller means anyway.
    private final class Ctx: PlayerIntegrationContext {
        private weak var controller: VitalsController?
        /// WEAK for the same reason `controller` is (round-1, #6). An integration that keeps its
        /// context — the normal shape, and what `detach()` is explicitly allowed to do — closed
        /// registration → integration → ctx → registration, a cycle the weak controller does not
        /// touch: unregistering and dropping the handle then reclaimed nothing, and the pinned
        /// announcement kept the old collector alive with it. Every legitimate user of the
        /// registration already retains it (the registry while it is live, the handle, the
        /// teardown frame), so a nil here means the registration is genuinely gone and the
        /// emission belongs nowhere. Promoted to a strong local for the duration of `emit()`.
        private weak var reg: PlayerRegistry.Registration?
        private let boundAnnouncement: PlayerRegistry.Registration.Announced?
        init(_ controller: VitalsController, _ reg: PlayerRegistry.Registration, bound: PlayerRegistry.Registration.Announced? = nil) {
            self.controller = controller; self.reg = reg; self.boundAnnouncement = bound
        }

        @discardableResult
        func emit(_ type: String, data: [String: Any?]?, t: Int64?) -> Bool {
            guard VitalsPlayerEventTypes.all.contains(type) else {
                InternalLogger.recordSafeWrapFailure(label: "VitalsController.emit.unknownType", error: UnknownEventType(type: String(type.prefix(VitalsLimits.maxCustomNameLength))))
                return false
            }
            guard let controller, let reg else { return false }
            guard let a = reg.announcedIn else { return false }        // never announced → dropped, not buffered
            let entry = controller.buildPlayerEvent(playerId: reg.id, type: type, data: data, t: t)   // BEFORE any lock (round-5, #3)
            let rec: VitalsCollector.Recorded?
            reg.announceLock.lock()
            // `originatedAt: t` — the caller's OWN transition time, so the collector can refuse an
            // entry that predates the session this announcement points at (round-4, #3).
            //
            // Round-6, W6-M6 — a describe supplies one too, and it must. Wave 5's W5-I5 made
            // `describe()` stamp the instant it READ the state it re-states, which is at or after
            // the new session's start, so the refusal never fires on a reseed; the comment that
            // used to stand here still called it nil. Nothing reaching THIS method — every
            // `PlayerIntegrationContext.emit` caller, integration or customer — passes `t: nil`
            // any more from inside the Everframe SDK. The controller's own `buildPlayerEvent` calls still
            // do (`player_attach`, `stats`, `player_detach` below): those are marker and sampler
            // entries the controller mints itself, not transitions, and they do not come through
            // here. The parameter stays optional because `emit` is public API and a customer
            // integration may have no transition time to give.
            if let bound = boundAnnouncement {
                // A describe context: stale if the registration was re-announced (identity, not collector) or is gone.
                rec = (a === bound && controller.registry.isLive(reg.token)) ? a.collector.recordPlayerEventDeferred(entry, expectedSessionId: a.sessionId, originatedAt: t) : nil
            } else {
                // A live callback: not liveness-gated (teardown's closing spans land after unregister) but ordered
                // against the teardown's COMPLETION (round-7, #2).
                rec = reg.detached ? nil : a.collector.recordPlayerEventDeferred(entry, expectedSessionId: a.sessionId, originatedAt: t)
            }
            reg.announceLock.unlock()
            guard let rec else { return false }
            rec.fireRotate()
            return rec.accepted
        }
        func now() -> Int64 { controller?.deps.now() ?? Int64(Date().timeIntervalSince1970 * 1000) }
    }
    private struct UnknownEventType: Error { let type: String }

    /// Pure: coercion of the customer map happens here, outside every lock.
    ///
    /// The clock is read on EVERY path, not only when `t` is nil. Round-3, #5 gave the AVPlayer
    /// integration its own transition timestamps, so `t` is now usually non-nil — and evaluating
    /// the fallback lazily would make the collector's own `deps.now()`, INSIDE its lock, the first
    /// clock read on the emit path. Keeping it here keeps the read where round-5 #3 put it,
    /// before any lock, which is also the point the controller suite parks a thread at to drive a
    /// drainer that owns the queue and holds nothing.
    fileprivate func buildPlayerEvent(playerId: String, type: String, data: [String: Any?]?, t: Int64?) -> VitalsPlayerEvent {
        let stampedOnArrival = deps.now()
        return VitalsPlayerEvent(t: t ?? stampedOnArrival, type: type, playerId: playerId, data: JsonCoerce.toObject(data))
    }

    /// Never called under `lock` — describe() is customer code. Liveness re-check, the
    /// player_attach record and the pin write are ONE announceLock critical section;
    /// library/version are read (and cut) BEFORE it; describe() runs AFTER it.
    private func announce(_ c: VitalsCollector, _ r: PlayerRegistry.Registration) {
        let library = VitalsText.cut(r.integration.library, toUTF16: VitalsLimits.maxPlayerLibraryLength)
        let version = r.integration.version.map { VitalsText.cut($0, toUTF16: VitalsLimits.maxPlayerLibraryLength) }
        var data: [String: Any?] = ["tag": "video", "library": library.isEmpty ? Self.unknownPlayerLibrary : library]
        if let n = r.name { data["name"] = n }
        if let v = version { data["libraryVersion"] = v }
        let attach = buildPlayerEvent(playerId: r.id, type: VitalsPlayerEventTypes.playerAttach, data: data, t: nil)

        var announced: PlayerRegistry.Registration.Announced?
        r.announceLock.lock()
        guard registry.isLive(r.token) else { r.announceLock.unlock(); return }
        let rec = c.recordPlayerEventDeferred(attach)
        if rec.accepted, let sid = rec.sessionId {
            let a = PlayerRegistry.Registration.Announced(collector: c, sessionId: sid)
            r.announcedIn = a
            announced = a
        }
        r.announceLock.unlock()
        rec.fireRotate()                       // may reseed OTHER players — customer describe(), outside the lock
        guard let bound = announced else { return }
        dispatch("VitalsController.describe") { r.integration.describe(Ctx(self, r, bound: bound)) }
    }

    /// Session rotation: re-announce every live player into the fresh session, skipping the
    /// one whose own player_attach caused it (round-5, #8). A duplicate play/buffer_start from
    /// describe() is harmless — the accumulator's spans are per-player idempotent (round-7, #1).
    private func reseed(_ c: VitalsCollector, trigger: VitalsEntry?) {
        var alreadyAnnouncing: String?
        if case let .player(p)? = trigger, p.type == VitalsPlayerEventTypes.playerAttach { alreadyAnnouncing = p.playerId }
        for r in registry.live() where r.id != alreadyAnnouncing { announce(c, r) }
    }

    /// Sampler tick: one stats entry per live player with a snapshot. The liveness decision,
    /// the announcement resolution and the deferred record are ONE announceLock section
    /// (round-6, #6); the result answers whether the integration may commit its delta.
    ///
    /// Round-6, W6-I1 — the measurements are bound to the announcement they were REQUESTED
    /// for, captured BEFORE `snapshot()` (customer code, so never under a lock) and required
    /// BY IDENTITY at delivery. The collector alone could not express this: a rotation keeps
    /// the same collector, so a snapshot taken in session A and answered after the rotation to
    /// B had finished reseeding passed the old `a.collector === c` check, picked up B's fresh
    /// pin and recorded A's buffer, bitrate and dropped-frame delta in B under a B-era
    /// timestamp. A pin that is no longer the same `Announced` object means the session these
    /// numbers describe has ended: the entry is refused and the integration is answered
    /// `false`, so it keeps its dropped-frame delta for the next tick rather than committing
    /// it against a timeline that never received it.
    private func collectStats() {
        guard let c = withLock({ collector }) else { return }
        for r in registry.live() {
            let requested = r.announcedIn
            dispatch("VitalsController.snapshot") {
                r.integration.snapshot { [weak self] snap in
                    guard let self, let snap else { return false }
                    var data: [String: Any?] = ["bufferAheadMs": snap.bufferAheadMs ?? 0, "droppedFrames": snap.droppedFramesDelta]
                    if let v = snap.bandwidthEstimate { data["bandwidthEstimate"] = v }
                    if let v = snap.bitrate { data["bitrate"] = v }
                    if let v = snap.width { data["width"] = v }
                    if let v = snap.height { data["height"] = v }
                    let entry = self.buildPlayerEvent(playerId: r.id, type: VitalsPlayerEventTypes.stats, data: data, t: nil)
                    r.announceLock.lock()
                    let rec: VitalsCollector.Recorded? = {
                        // Round-7, W7-M5 — the side effect of binding to the REQUESTED
                        // announcement, stated where it bites: a snapshot requested before this
                        // player had been announced at all (`requested == nil`) is refused, even
                        // if an announcement landed while `snapshot()` was running. Reading
                        // `r.announcedIn` here instead would have recorded it. That is the
                        // conservative direction and it is deliberate — the measurements describe
                        // a stretch of playback that predates the announcement they would be
                        // filed under — and it costs at most one 20-second sample per player,
                        // whose dropped-frame delta is left OWED and folded into the next tick.
                        guard let requested, requested.collector === c,
                              self.registry.isLive(r.token), r.announcedIn === requested else { return nil }
                        return requested.collector.recordPlayerEventDeferred(entry, expectedSessionId: requested.sessionId)
                    }()
                    r.announceLock.unlock()
                    guard let rec else { return false }
                    rec.fireRotate()
                    return rec.accepted
                }
            }
        }
    }

    /// Two-phase (Android round-1, Important 2/3). nil = SHUTDOWN refusal (transient — the
    /// runtime re-selects); an inert handle = INTEGRATION refusal (final). (Round-8, #3.)
    func trackPlayer(_ integration: PlayerIntegration, name: String?) -> PlayerHandle? {
        guard let r = withLock({ isShutdown ? nil : registry.reserve(integration, name: name) }) else { return nil }

        let attached = dispatch("VitalsController.attach") { integration.attach(Ctx(self, r)) } ?? false
        if !attached { return inertHandle(integration) }

        let announceIn: VitalsCollector?? = withLock {
            if isShutdown { return nil }
            registry.publish(r)
            return .some(collector)
        }
        guard let announceIn else {
            // Round-2, #4 — a SHUTDOWN refusal is transient: the runtime retries this same
            // integration against the next controller, so this is an attachment rollback, not a
            // disposal. `detach()` would drop declaration-time resources `attach()` never
            // reinstalls (the AVPlayer release hook and its sentinel), and the retried
            // registration would live on with no release detection at all.
            dispatch("PlayerIntegration.detach") {
                if let r = integration as? AttachRollback { r.rollbackAttach() } else { integration.detach() }
            }
            return nil
        }
        if let c = announceIn { announce(c, r) }
        return Handle(controller: self, reg: r)
    }

    /// The controller is held STRONGLY here (Kotlin semantics): a handle outliving its
    /// controller keeps a small dead object alive whose registry is already cleared, so
    /// `track`/`detach` degrade to no-ops. The cycle a strong `Ctx` would close —
    /// controller → registry → registration → integration → ctx — does not exist for a
    /// handle, which the registry never holds.
    private final class Handle: PlayerHandle {
        private let controller: VitalsController
        private let reg: PlayerRegistry.Registration
        init(controller: VitalsController, reg: PlayerRegistry.Registration) { self.controller = controller; self.reg = reg }
        var id: String { reg.id }
        /// Liveness decision + record are one announceLock section (round-4, #6); the entry is BUILT outside it.
        func track(_ name: String, data: Any?) {
            dispatch("PlayerHandle.track") {
                let entry = controller.buildCustomEntry(name: name, data: data, playerId: reg.id)
                reg.announceLock.lock()
                let rec: VitalsCollector.Recorded? = controller.registry.isLive(reg.token)
                    ? reg.announcedIn.map { $0.collector.recordCustomDeferred(entry, expectedSessionId: $0.sessionId) } : nil
                reg.announceLock.unlock()
                rec?.fireRotate()
            }
        }
        func detach() {
            dispatch("PlayerHandle.detach") {
                guard let removed = controller.registry.unregister(reg.token) else { return }
                controller.detachAndMark(removed) {}
            }
        }
    }

    /// Runs an integration's teardown and emits its player_detach marker exactly once, WHEN THE
    /// TEARDOWN HAS FINISHED (round-3, Important 6), then runs `then`. A never-announced
    /// registration gets no marker; `detached` is set in the same critical section regardless.
    ///
    /// A teardown that never calls back is covered by `shutdown()`'s drain timeout — there is
    /// no completion-forcing probe here: draining the internal failure ring to detect one would
    /// erase the degradedReason evidence the next envelope is owed.
    fileprivate func detachAndMark(_ r: PlayerRegistry.Registration, then: @escaping () -> Void) {
        let marker = buildPlayerEvent(playerId: r.id, type: VitalsPlayerEventTypes.playerDetach, data: nil, t: nil)
        let fired = Locked(false)
        let complete: () -> Void = {
            var first = false
            fired.mutate { if !$0 { $0 = true; first = true } }
            guard first else { return }
            defer { dispatch("VitalsController.playerDetachDrain") { then() } }
            dispatch("VitalsController.playerDetach") {
                r.announceLock.lock()
                r.detached = true
                let rec = r.announcedIn.map { $0.collector.recordPlayerEventDeferred(marker, expectedSessionId: $0.sessionId) }
                r.announceLock.unlock()
                rec?.fireRotate()
            }
        }
        dispatch("PlayerIntegration.detach") { r.integration.detach(onComplete: complete) }
    }

    private func inertHandle(_ integration: PlayerIntegration) -> PlayerHandle {
        dispatch("PlayerIntegration.detach") { integration.detach() }
        return Inert()
    }
    private final class Inert: PlayerHandle { let id = ""; func track(_ name: String, data: Any?) {}; func detach() {} }

    func trackVitals(_ name: String, data: Any?, playerId: String?) {
        dispatch("VitalsController.trackVitals") {
            guard let c = withLock({ collector }) else { return }
            c.recordCustom(buildCustomEntry(name: name, data: data, playerId: playerId))
        }
    }

    fileprivate func buildCustomEntry(name: String, data: Any?, playerId: String?) -> VitalsCustomEntry {
        let bounded = boundJson(data == nil ? nil : JsonCoerce.toJSON(data))
        // UTF-16 units, not graphemes (round-1, #11): the protocol's zod `.max()` counts what
        // JavaScript's String.length counts, and an over-long name makes ingest reject the
        // whole chunk — every unrelated sample in it included.
        let cut = VitalsText.cut(name, toUTF16: VitalsLimits.maxCustomNameLength)
        return VitalsCustomEntry(t: deps.now(), name: cut.isEmpty ? "unnamed" : cut, data: bounded.data,
                                 truncated: bounded.truncated ? true : nil,
                                 playerId: playerId.map { VitalsText.cut($0, toUTF16: VitalsLimits.maxPlayerIdLength) })
    }

    /// One timed lock acquisition inside the collector stamps the id and the ring together.
    func currentStamp() -> VitalsStamp? { withLock { collector }?.stamp() }

    /// Only the state swap and the registry snapshot happen under `lock`; every detach() and
    /// stop() runs after it is released. Waits (bounded) for asynchronous teardowns so their
    /// closing spans and markers reach the collector being drained before it stops.
    func shutdown() {
        dispatch("VitalsController.shutdown") {
            var regs: [PlayerRegistry.Registration] = []
            var c: VitalsCollector?, s: ResourceSampler?, l: VitalsLifecycleHandle?, k: VitalsSink?
            var stillFinishing: [VitalsSink] = []
            let alreadyDown: Bool = withLock {
                if isShutdown { return true }
                isShutdown = true
                generation += 1
                regs = registry.clear()
                c = collector; s = sampler; l = lifecycle; k = sink
                collector = nil; sampler = nil; lifecycle = nil; sink = nil
                stillFinishing = finishingSinks; finishingSinks.removeAll()
                return false
            }
            if alreadyDown { return }
            let group = DispatchGroup()
            for r in regs { group.enter(); detachAndMark(r) { group.leave() } }
            if !regs.isEmpty, group.wait(timeout: .now() + .milliseconds(Int(Self.detachDrainTimeoutMs))) == .timedOut {
                InternalLogger.recordSafeWrapFailure(label: "VitalsController.shutdown.detachDrain", error: DetachDrainTimeout())
            }
            dispatch("VitalsController.shutdown.lifecycle") { l?.uninstall() }
            dispatch("VitalsController.shutdown.sampler") { s?.stop() }
            dispatch("VitalsController.shutdown.collector") { c?.stop() }
            dispatch("VitalsController.shutdown.sink") { k?.close() }
            // Round-2, #5 — a kill() that lands during a server disable's 5 s grace window must
            // cancel what is still on the wire; `sink` is already nil by then, so the finishing
            // ones are the only reference left. `close()` is idempotent.
            // `f !== k` because a test seam (and only a test seam) can hand two collectors the
            // same sink object; production builds one per collector.
            for f in stillFinishing where f !== k { dispatch("VitalsController.shutdown.finishingSink") { f.close() } }
        }
    }
}
