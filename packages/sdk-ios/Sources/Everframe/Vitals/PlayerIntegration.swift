// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

public protocol PlayerIntegrationContext: AnyObject {
    /// `type` must be in VitalsPlayerEventTypes.all; `data` is JSON-coercible and bounded before the wire.
    /// RETURNS whether the collector admitted the entry (Android round-5, #9): an integration that
    /// spends a budget on an emission charges it only against `true`.
    ///
    /// `t` is the TRANSITION TIME: epoch milliseconds on the same clock as `now()`, for events
    /// that happened before this call (a queued emission delivered late). `nil` means "now", and
    /// the entry is stamped on arrival — which is what an integration emitting inline should
    /// pass. Anything else is a different clock: seconds, media time, or a monotonic reading are
    /// all wrong here, and none of them is merely imprecise. An explicitly stamped event that
    /// PREDATES the session it would land in is DROPPED (codex round-4, #3), so a `t` on the
    /// wrong base has every stamped event silently refused.
    @discardableResult func emit(_ type: String, data: [String: Any?]?, t: Int64?) -> Bool
    func now() -> Int64
}

public struct PlayerSnapshot: Sendable, Equatable {
    public var bufferAheadMs: Int64?
    public var bandwidthEstimate: Int64?
    public var bitrate: Int?
    public var width: Int?
    public var height: Int?
    public var droppedFramesDelta: Int

    public init(bufferAheadMs: Int64? = nil, bandwidthEstimate: Int64? = nil, bitrate: Int? = nil, width: Int? = nil, height: Int? = nil, droppedFramesDelta: Int = 0) {
        self.bufferAheadMs = bufferAheadMs
        self.bandwidthEstimate = bandwidthEstimate
        self.bitrate = bitrate
        self.width = width
        self.height = height
        self.droppedFramesDelta = droppedFramesDelta
    }
}

public struct StartupTimings: Sendable, Equatable {
    public var manifestMs: Int64?
    public var licenseMs: Int64?
    public var firstFragmentMs: Int64?

    public init(manifestMs: Int64? = nil, licenseMs: Int64? = nil, firstFragmentMs: Int64? = nil) {
        self.manifestMs = manifestMs
        self.licenseMs = licenseMs
        self.firstFragmentMs = firstFragmentMs
    }
}

public protocol PlayerIntegration: AnyObject {
    /// Player library name (≤ 32 chars).
    var library: String { get }
    /// Optional player library version.
    var version: String? { get }
    /// Subscribe. Return false when the instance is not what this integration expects — the
    /// registration is refused, the caller gets an INERT handle (empty id) and `detach()` is
    /// called once, best-effort, in case a partial subscription happened. Called on the caller's
    /// thread, with no controller lock held. It may subscribe to the player and it SHOULD seed
    /// from the player's current state (an already-playing player must open its `play` span, or
    /// the session reports zero playtime until the next transition); the controller drops anything
    /// emitted before this player's own `player_attach` is in the timeline, so emitting early is
    /// harmless, never wrong.
    func attach(_ ctx: PlayerIntegrationContext) -> Bool
    /// Called on the sampler tick. Deliver on any thread, synchronously or later; null means
    /// "idle, no stats this tick". Must never throw. A result delivered after this player was
    /// detached, or after the collector that asked for it was replaced, is dropped — delivering
    /// late is safe, it just may not be recorded.
    ///
    /// `onResult` RETURNS whether the controller actually recorded the snapshot. An integration
    /// reporting a DELTA — dropped frames, say — must not commit that delta until it comes back
    /// `true`, or a snapshot rejected for landing after a detach (or against a replaced collector)
    /// silently swallows it. A null result is never recorded and always answers `false`.
    func snapshot(_ onResult: @escaping (PlayerSnapshot?) -> Bool)
    /// Returns startup timings if available.
    func startupTimings() -> StartupTimings?
    /// Rotation reseed: re-emit cached identity (source_change, drm) AND re-open whatever
    /// spans are currently ongoing (play, buffer_start), so chunk 0 of a new session is
    /// self-describing and its summary does not undercount playback. The controller re-emits
    /// player_attach itself.
    ///
    /// Say TOO MUCH rather than too little. A `play` this player has already opened in the
    /// target session is a no-op at the accumulator, whose union spans track which players are
    /// inside them rather than counting opens; an ongoing span left unstated is lost until the
    /// player's next transition, which for uninterrupted playback never comes.
    func describe(_ ctx: PlayerIntegrationContext)
    /// MAY be called on an integration that NEVER ATTACHED. A pending registration revoked by a
    /// `kill()`, one cancelled through its deferred handle before the drain reached it, and one
    /// whose `attach()` was refused all reach here without an announcement ever existing. It must
    /// then be a safe no-op APART FROM RELEASING DECLARATION-TIME RESOURCES, and it must emit
    /// nothing — there is no timeline to emit into.
    func detach()
    /// The ASYNCHRONOUS completion form. An integration whose teardown has to hop to the player's
    /// own thread cannot close its open `buffer_end`/`pause` spans before `detach()` returns.
    /// Implement this instead of `detach` when teardown is asynchronous, and invoke `onComplete`
    /// EXACTLY ONCE, on whatever thread finishes the teardown, after the last event this
    /// integration will ever emit. The controller emits `player_detach` from that callback, and
    /// `shutdown()` waits (briefly, bounded) for it before it stops the collector.
    ///
    /// The default implementation is the synchronous one, so an existing integration that only
    /// overrides `detach` keeps working unchanged.
    ///
    /// WHERE THE WAIT LANDS (whole-branch review O3 — documented, deliberately not moved off
    /// the caller's thread): `Everframe.kill()` and a superseding `Everframe.start()` run this
    /// teardown for every registration ON THE CALLING THREAD and then wait, once, for the
    /// completions — bounded by `VitalsController.detachDrainTimeoutMs` (250 ms). An
    /// implementation that completes on the caller's thread costs nothing; one that completes
    /// elsewhere can make `kill()` block for up to that 250 ms plus however long the teardown
    /// itself takes to reach `onComplete`. That includes the Everframe SDK's own AVPlayer integration on
    /// the contended path: since codex round-2, #3 its completion is an ordered barrier in the
    /// emission outbox, so when another thread owns the drain the completion is run by that
    /// thread, after the emissions queued ahead of it — the 250 ms window is load-bearing for the
    /// built-in integration too, not only for a customer's. The wait exists so an integration's
    /// closing `buffer_end`/`pause` and its `player_detach` marker reach the collector before it
    /// stops — dropping it would lose them.
    func detach(onComplete: @escaping () -> Void)
}

public extension PlayerIntegration {
    func detach(onComplete: @escaping () -> Void) {
        defer { onComplete() }
        detach()
    }
}

/// Codex round-2, #4 — the difference between a TERMINAL disposal and a transient ATTACHMENT
/// ROLLBACK.
///
/// `VitalsController.trackPlayer` runs `attach()` before it publishes the registration, and the
/// publication can still be refused when that controller shut down in between. That refusal is
/// transient: `VitalsRuntime` retries THE SAME INTEGRATION against the next controller. The
/// rollback was a plain `detach()`, which for the Everframe SDK's own AVPlayer integration also clears the
/// `onReleased` hook (round-1, #5) and drops the declaration-time release sentinel (round-8, #1)
/// — neither of which `attach()` reinstalls. A registration that lost the race therefore lost
/// release detection permanently: the player could deallocate with no one left to unregister it,
/// and `snapshot()`'s fallback `fireReleased()` had no hook to call either.
///
/// Deliberately NOT on the public `PlayerIntegration` protocol. Only an integration that
/// installs resources at DECLARATION time — before `attach()`, in `TrackPlayer.swift`'s wiring —
/// can tell the two apart, and the Everframe SDK's own is the only one that does. A customer integration
/// installs everything in `attach()`, for which the terminal `detach()` is already right; the
/// default below keeps that behaviour for every integration that does not opt in.
protocol AttachRollback: AnyObject {
    /// Undo `attach()`, but keep what was installed before it. A terminal `detach()` still
    /// follows on every path that ends the registration for good (revocation, cancellation, a
    /// later `kill()`), so nothing is left subscribed if the retry never happens.
    func rollbackAttach()
}

public protocol PlayerHandle: AnyObject {
    var id: String { get }
    func track(_ name: String, data: Any?)
    func detach()
}
