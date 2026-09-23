// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Server-authoritative network-body capture gate (network-body-capture spec).
// Composes three independent signals into a single `isActive` bit:
//
//   1. Server block: `NetworkBodiesConfigWire.captureBodies == true`. A nil
//      block (feature off / malformed config degraded to nil upstream) is
//      fail-closed — capture stays OFF.
//   2. Local gate (`locallyDisabled`, computed by `locallyDisabled(for:)`
//      below): the OR of two client-side preconditions, per spec §3 —
//      `capture.network != true` (metadata capture itself was never opted
//      into; NOT structural, see that method's doc comment) and
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
// NSLock-guarded state (mirrors BreadcrumbRingBuffer / NetworkBodyRingBuffer
// discipline) — `@unchecked Sendable`, not an actor, so `isActive` /
// `bodyByteCap` / `bodyContentTypes` / `mintReqId()` stay synchronous.
import Foundation

public final class NetworkBodyCaptureGate: @unchecked Sendable {
    public static let shared = NetworkBodyCaptureGate()

    /// Byte-cap default (spec default) — applied when the server block omits
    /// `bodyByteCap` or hasn't been supplied yet.
    public static let defaultBodyByteCap = 8192
    /// Content-type allowlist default (spec default) — applied when the
    /// server block omits `bodyContentTypes` or hasn't been supplied yet.
    public static let defaultBodyContentTypes = ["application/json", "text/*"]

    private let lock = NSLock()

    /// nil = never drawn yet; drawn lazily on the first `applyConfig` call
    /// where `wire?.captureBodies == true`, then sticky for the process.
    private var sampleDraw: Bool?
    private var active = false
    private var _bodyByteCap = NetworkBodyCaptureGate.defaultBodyByteCap
    private var _bodyContentTypes = NetworkBodyCaptureGate.defaultBodyContentTypes
    private var reqIdCounter = 0

    /// Round-7 review Finding F34: monotonically increasing per-process
    /// generation, bumped whenever `applyConfig` CHANGES the effective
    /// `active` bit (either direction — the "at minimum" transition-to-
    /// inactive case the finding calls out is a subset of this) and,
    /// unconditionally, by `reset()` (which `kill()` calls). A caller that
    /// captures `(active, generation)` together at decision time — BEFORE
    /// building a body entry, which can take real wall-clock time
    /// (redaction, bounded reads) — can later hand the captured generation
    /// to `NetworkBodyRingBuffer.append(_:guard:)`, which re-validates
    /// `isActive(forGeneration:)` INSIDE its own lock, atomically with the
    /// insert. This is what makes a remote `captureBodies: false` landing
    /// mid-flight authoritative at the actual sink boundary, not just at the
    /// start of body processing — see `NetworkCaptureProtocol.swift`'s call
    /// site for the full fix.
    private var generation = 0

    public init() {}

    /// Combined client-side "locally disabled" precondition (spec §3,
    /// `2026-08-01-network-body-capture-native-design.md`):
    ///
    ///     captureBodies = serverConfig.captureBodies
    ///                   && capture.network == true
    ///                   && capture.networkBodies != false
    ///                   && sampledIn
    ///
    /// This function computes the right-hand OR of the two client
    /// preconditions above (negated) — the single place both are combined so
    /// they cannot drift apart across call sites.
    ///
    /// Round-5 review Finding F22: `capture.network == true` is NOT a
    /// structural precondition, despite the spec's original §3.1 assumption.
    /// `networkCaptureConfiguration()` attaches `EFNetworkCaptureProtocol`
    /// unconditionally — it never reads `capture.network` — so a host that
    /// wires network capture without ever setting `capture.network = true`
    /// still gets metadata capture, and (pre-fix) still got BODY capture
    /// whenever the server block was ON, defeating the intended opt-in. This
    /// gate must therefore evaluate the flag explicitly rather than assume
    /// metadata-capture attachment implies it.
    ///
    /// `config == nil` (pre-`start()`, or a torn-down session) fails closed:
    /// there is no confirmed client opt-in yet, so bodies stay off.
    public static func locallyDisabled(for config: EverframeConfig?) -> Bool {
        guard let config else { return true }
        return config.capture.network != true || config.capture.networkBodies == false
    }

    /// Round-6 review Finding F28: a body is meaningless without its
    /// correlating SHIPPED network breadcrumb — `EnvelopeBuilder` drops any
    /// `payload.networkBodies[]` entry whose `ref` has no matching network
    /// crumb `data.reqId` (spec §7/§11.8's every-ref-matches-one-crumb
    /// invariant). Before this fix `networkBodiesConfig.captureBodies` was
    /// independently toggleable from `breadcrumbsConfig` — an operator could
    /// turn bodies ON while breadcrumbs were OFF (or `kinds` omitted
    /// `network`), and every captured body was then silently dropped at
    /// encode time with no diagnostic anywhere. This function lets the
    /// CAPTURE GATE itself (not just the encode-time filter) stay off in
    /// that case, which also saves the memory/CPU of capturing bodies that
    /// can never ship.
    ///
    /// `cfg == nil` mirrors `BreadcrumbRingBuffer.applyConfig(nil)`'s own
    /// default — enabled, all 7 kinds including `network` — so an
    /// UNCONFIGURED breadcrumbs block must NOT disable bodies; only an
    /// explicit disabled-breadcrumbs or network-excluding block does.
    public static func breadcrumbsExcludeNetwork(_ cfg: BreadcrumbsConfigWire?) -> Bool {
        guard let cfg else { return false }
        return !cfg.enabled || !cfg.kinds.contains("network")
    }

    /// Fail-closed composition of server config + client veto + one-shot
    /// sampling. `wire == nil` (feature off / decode-degraded upstream)
    /// always yields `isActive == false`, independent of veto/sampling.
    /// The sampling draw happens at most once per process — see file header.
    ///
    /// Round-8 review Finding F39: `` `guard` ``, when non-nil, is evaluated
    /// INSIDE `lock` — the very first thing done after acquiring it, before
    /// any mutation — mirroring the guard-inside-the-lock discipline
    /// `NetworkBodyRingBuffer.append(_:guard:)`'s `guard` parameter (F34)
    /// already established on iOS, and
    /// `NetworkBodyCaptureState.applyConfig`'s `guard` parameter (F26)
    /// already established on Android for this EXACT method. The production
    /// call site (`ReplaySession.refreshConfigNow()`) passes a closure
    /// comparing `Everframe.shared.currentStartEpoch` against the epoch it
    /// captured at construction: `Everframe.start()`/`kill()` are synchronous,
    /// non-actor-isolated methods that may run on a background thread while
    /// this `@MainActor` session's refresh is mid-flight, so an EARLIER,
    /// one-off check of that epoch (taken before this call) can pass and
    /// still leave a real window — between that check and this mutation —
    /// for a superseding `start()`/`kill()` to land. Evaluating the guard
    /// freshly, atomically with the mutation, closes that window regardless
    /// of how much real time elapses between the caller's own earlier check
    /// and this call. `nil` (the default) skips the check entirely, so every
    /// existing call site (including every test in this file) is unaffected.
    public func applyConfig(
        _ wire: NetworkBodiesConfigWire?,
        samplingRate: Double,
        locallyDisabled: Bool,
        random: () -> Double = { Double.random(in: 0..<1) },
        `guard`: (() -> Bool)? = nil
    ) {
        lock.lock()
        defer { lock.unlock() }
        if let `guard`, !`guard`() { return }

        let serverOn = wire?.captureBodies == true
        if serverOn, sampleDraw == nil {
            sampleDraw = random() < samplingRate
        }

        _bodyByteCap = wire?.bodyByteCap ?? Self.defaultBodyByteCap
        _bodyContentTypes = wire?.bodyContentTypes ?? Self.defaultBodyContentTypes

        let newActive = serverOn && !locallyDisabled && sampleDraw == true
        // F34 — bump on ANY change to the effective active bit, not just
        // OFF transitions; a superset of the finding's "at minimum" bar and
        // simpler to reason about (every observably different `active`
        // value gets its own generation).
        if newActive != active { generation += 1 }
        active = newActive
    }

    public var isActive: Bool {
        lock.lock(); defer { lock.unlock() }
        return active
    }

    /// F34 — `(active, generation)` captured together, under one lock
    /// acquisition, so a caller has a single consistent token: `active`
    /// answers "should I start building a body entry right now", and
    /// `generation` is what to hand `NetworkBodyRingBuffer.append(_:guard:)`
    /// so the buffer can re-validate this exact decision — not a
    /// possibly-different later one — atomically with the insert.
    public func snapshotActive() -> (active: Bool, generation: Int) {
        lock.lock(); defer { lock.unlock() }
        return (active, generation)
    }

    /// F34 — true iff the gate is CURRENTLY active AND its generation still
    /// matches `expected`. Called by `NetworkBodyRingBuffer.append(_:guard:)`
    /// from INSIDE the buffer's own lock, immediately before the insert —
    /// this is the authoritative check the append boundary relies on: a
    /// `captureBodies: false` refresh that runs (and bumps `generation`,
    /// per `applyConfig` above) between a caller's `snapshotActive()` and
    /// the eventual `append` call is caught here even though nothing else
    /// on the append path re-validates it.
    public func isActive(forGeneration expected: Int) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return active && generation == expected
    }

    public var bodyByteCap: Int {
        lock.lock(); defer { lock.unlock() }
        return _bodyByteCap
    }

    public var bodyContentTypes: [String] {
        lock.lock(); defer { lock.unlock() }
        return _bodyContentTypes
    }

    /// 1-based monotonic per-process request id, used to correlate a
    /// request's captured body with its metadata entry.
    public func mintReqId() -> Int {
        lock.lock(); defer { lock.unlock() }
        reqIdCounter += 1
        return reqIdCounter
    }

    /// Production reset — called from `Everframe.kill()` (final-review Finding
    /// 3: process-lifetime sampling) AND, synchronously, from the START of
    /// `Everframe.start()` (round-5 review Finding F23: `start(A) -> start(B)`
    /// is not a safe session boundary — see that method's doc comment).
    /// Deactivates the gate and restores boot-time defaults, INCLUDING
    /// clearing the one-shot `sampleDraw` — a kill()/start() cycle, or a
    /// bare superseding start(), is, from the gate's point of view, a new
    /// session that may see a new config/samplingRate on its next
    /// `applyConfig`, so the sticky draw must not survive across it (only
    /// sticky WITHIN a single session's lifetime, per the file-header
    /// contract).
    ///
    /// `reqIdCounter` is reset to 0 rather than kept monotonic: request ids
    /// only need to be unique within the body ring buffer's current live
    /// window (which `kill()` also zeroizes via `NetworkBodyRingBuffer
    /// .clear()`), so restarting the counter at session boundaries is safe
    /// and keeps ids small/readable across a long process lifetime that
    /// kills and restarts many times.
    public func reset() {
        lock.lock(); defer { lock.unlock() }
        sampleDraw = nil
        active = false
        _bodyByteCap = Self.defaultBodyByteCap
        _bodyContentTypes = Self.defaultBodyContentTypes
        reqIdCounter = 0
        // F34 — unconditional bump (unlike applyConfig's change-triggered
        // one): reset()/kill() is itself a session boundary, so any token
        // captured before it must be invalidated even if `active` happened
        // to already be false (e.g. a decision made, then killed, before
        // ever reaching an `applyConfig` that would have flipped `active`).
        generation += 1
    }

    /// Test-only alias for `reset()` — restores boot-time defaults, including
    /// the one-shot sampling draw (so a fresh test can re-draw). Production
    /// code calls `reset()` directly (from `kill()`); this name stays for
    /// existing test call sites and readability at test call sites.
    public func resetForTesting() {
        reset()
    }
}
