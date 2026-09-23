// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The slice of AVPlayer the integration touches, as a seam (twin of
// Media3PlayerFacade). Tests drive a fake; production wraps a real AVPlayer
// held WEAKLY. Callbacks arrive on whatever thread AVFoundation delivers KVO
// and notifications on — the integration serialises them under its own lock.
//
// Release detection: AVFoundation has no "released" callback. `observeRelease`
// attaches a sentinel object to the player via objc_setAssociatedObject; the
// sentinel's deinit runs when the player deallocates and fires the closure.
import AVFoundation
import Foundation
import ObjectiveC

enum TimeControl: Equatable { case paused, waitingToPlay(toMinimizeStalls: Bool), playing }
enum ItemStatus: Equatable { case unknown, readyToPlay, failed(domain: String, code: Int, message: String) }

/// WHAT THE PLAYER'S CURRENT ITEM IS, as far as source identity goes (codex round-7, W7-I3).
///
/// `nil` means there is NO current item. A non-nil value whose `url` is nil is an item the Everframe SDK
/// cannot name — an `AVPlayerItem` built on an `AVMutableComposition` or any non-`AVURLAsset`
/// asset — which is a very different thing, and the two used to be indistinguishable here: both
/// arrived as a bare `url: nil` and the integration read that as "playlist end", so a
/// composition-backed replacement kept the PREVIOUS item's source identity and the next
/// rotation re-announced the old URL as the new item's. Android already carries the two apart
/// (`Media3Integration.onItem`'s `item == null` return, versus `sanitizeSource(null)` →
/// `unknown` for an item with no URI).
struct ItemIdentity: Equatable {
    var url: URL?
}

struct PlayerState: Equatable {
    var item: ItemIdentity?
    var isFairPlay: Bool
    var preferredPeakBitRate: Double
    var timeControl: TimeControl
    var rate: Float
    var itemStatus: ItemStatus
    var presentationWidth: Int
    var presentationHeight: Int
    var currentTimeMs: Int64
    var loadedRangesMs: [(start: Int64, end: Int64)]
    static func == (l: PlayerState, r: PlayerState) -> Bool {
        l.item == r.item && l.isFairPlay == r.isFairPlay && l.preferredPeakBitRate == r.preferredPeakBitRate && l.timeControl == r.timeControl
            && l.rate == r.rate && l.itemStatus == r.itemStatus && l.presentationWidth == r.presentationWidth && l.presentationHeight == r.presentationHeight
            && l.currentTimeMs == r.currentTimeMs && l.loadedRangesMs.map(\.start) == r.loadedRangesMs.map(\.start) && l.loadedRangesMs.map(\.end) == r.loadedRangesMs.map(\.end)
    }
}

struct AccessLogSnapshot: Equatable {
    var indicatedBitrate: Double
    var observedBitrate: Double
    /// Sum of numberOfDroppedVideoFrames over every access-log event so far (cumulative).
    var droppedFramesTotal: Int
    var playbackType: String?     // "LIVE" | "VOD" | "FILE"
    var startupTimeMs: Int64?
    /// The item's bit-rate cap AS OF THIS READ (codex round-3, #8). Cached only at attachment and
    /// item changes, it went stale the moment the host app set `preferredPeakBitRate` on the
    /// item it is already playing — the sample app's own Throttle button — and every later
    /// bitrate change was still classified `reason: "abr"`. Reading it with the log entry is the
    /// snapshot shape the facade already has; 0 means no cap, which is AVFoundation's own default.
    var preferredPeakBitRate: Double
    /// The ITEM registration this snapshot was read for — see `PlayerFacade.currentItemGeneration`
    /// (codex round-2, #6). Every value above is per-item, so the integration drops the whole
    /// snapshot when this no longer matches the item its own state belongs to.
    ///
    /// NO DEFAULT, deliberately (round-3, #2): it used to default to `0`, so a construction site
    /// that forgot it silently claimed the FIRST item's generation and every access-log entry
    /// after the first source change was dropped, with nothing to see at compile time.
    var itemGeneration: UInt64
}

struct ErrorLogSnapshot: Equatable {
    var errorStatusCode: Int
    var errorDomain: String
    var errorComment: String?
    var uriHost: String?
}

/// EVERY per-item callback carries the generation of the item registration it was READ FOR
/// (codex round-3, #2). The integration used to label an item change with the facade's CURRENT
/// generation, so a stalled `onItemChanged(A)` delivered after `onItemChanged(B)` relabelled A's
/// source and A's reset per-item state as B's — and B's own access logs then validated against
/// state describing A. A generation the callback carries cannot be relabelled by a newer one,
/// and it removes the integration → facade lock edge the re-read took on the hottest path.
///
/// The two callbacks that DO NOT carry one are the error callbacks, deliberately: an error is
/// not per-item state, it is emitted rather than cached, and gating it would DROP a real
/// playback fault whose only sin is arriving just after a source change. The player-level
/// `status` observer is not an item-scoped registration at all.
///
/// Codex round-7, W7-I1 — `onPeriodicTime` USED to be in that second list, on the reasoning
/// that a player-level time observer is not item-scoped. The registration is not; the POSITION
/// it reports is. A tick carrying item A's 60 000 ms, stalled behind the integration lock while
/// A was replaced, seeded B's playhead at 60 000 — so B's first `timeJumped(0)` emitted a
/// fabricated `seek { fromMs: 60000, toMs: 0 }` and the stats in between measured B's buffer
/// ahead from A's position. It now carries a generation like every other per-item value, and
/// the position it carries is READ WITH that generation rather than captured beforehand.
final class PlayerFacadeEvents {
    /// `nil` = the player has NO current item; a non-nil `ItemIdentity` with a nil `url` is an
    /// item whose asset carries no URL (round-7, W7-I3). See `ItemIdentity`.
    var onItemChanged: ((_ item: ItemIdentity?, _ isFairPlay: Bool, _ preferredPeakBitRate: Double, _ itemGeneration: UInt64) -> Void)?
    var onTimeControlChanged: ((TimeControl) -> Void)?
    var onRateChanged: ((Float) -> Void)?
    /// `itemGeneration` is nil when the change came from the PLAYER-level `status` observer,
    /// which is not item-scoped and only ever reports `.failed`.
    var onItemStatusChanged: ((ItemStatus, _ itemGeneration: UInt64?) -> Void)?
    /// Carries the item generation for the same reason `AccessLogSnapshot` does: `onItem` resets
    /// the cached width/height, so a size from the previous item would be adopted as the new one's.
    var onPresentationSizeChanged: ((Int, Int, _ itemGeneration: UInt64) -> Void)?
    var onLoadedRangesChanged: (([(start: Int64, end: Int64)], _ itemGeneration: UInt64) -> Void)?
    var onAccessLogEntry: ((AccessLogSnapshot) -> Void)?
    var onErrorLogEntry: ((ErrorLogSnapshot) -> Void)?
    var onTimeJumped: ((_ toMs: Int64, _ itemGeneration: UInt64) -> Void)?
    var onFailedToPlayToEnd: ((_ domain: String, _ code: Int, _ message: String) -> Void)?
    /// A TICK, not a delivery: `ms` is the position of the item named by `itemGeneration`, read
    /// together with it (round-7, W7-I1). Not fired at all when there is no such item.
    var onPeriodicTime: ((_ ms: Int64, _ itemGeneration: UInt64) -> Void)?
}

protocol PlayerFacade: AnyObject {
    var isAlive: Bool { get }
    /// Codex round-2, #6 — bumped by every ITEM registration (`observeItem`), so a callback read
    /// for one item can be told from the item that is current when it is finally delivered.
    /// `AVPlayerItem` notifications are `queue: nil` and KVO arrives on whatever thread
    /// AVFoundation chose, so an access-log callback for item A can read A's cumulative counters,
    /// stall, and deliver after the player switched to B and the integration reset its per-item
    /// baseline — adding A's total against B's zero baseline and restoring A's bitrate and
    /// bandwidth. The observation generation added for round-1 #8 protects observer REBUILDING
    /// across attachments; it says nothing about deliveries across item changes.
    ///
    /// Round-3, #2 — this is read ONCE, by `attach()`, to label the state it seeds from the item
    /// registration `observe()` just made. Every later per-item callback CARRIES its own
    /// generation instead of re-reading this one, so a stalled callback can never be relabelled
    /// with a newer item's generation, and no callback path takes a facade lock.
    ///
    /// Round-7 added two PULLS that also report a generation — `readAccessLog()` and the
    /// periodic `readTick()` — but neither is a re-read of this property: each reads the value
    /// it stamps in the same critical section as the state it stamps it on, which is the whole
    /// point. The one integration-lock → facade-lock edge either creates is in `attach()`,
    /// beside the `observe()` and `readState()` calls already there; `snapshot()`'s pull happens
    /// with no integration lock held.
    var currentItemGeneration: UInt64 { get }
    /// The CURRENT item's access log, read on demand and tagged with the generation naming that
    /// item (codex round-7, W7-I2). `nil` when there is no player, no current item, no
    /// registration for it, or no log entry yet.
    ///
    /// `AVPlayerItemNewAccessLogEntry` fires when a new ENTRY is APPENDED, not when the entry
    /// already at the end accumulates more measurement — and `numberOfDroppedVideoFrames` is one
    /// of the accumulating ones. Steady playback within a single entry therefore dropped frames
    /// the notification never reported, so every 20-second `stats` sample kept saying zero. This
    /// is the pull that makes the stats path see them, and the read that lets `attach()`
    /// establish the baseline an item ALREADY has when we join it.
    func readAccessLog() -> AccessLogSnapshot?
    /// nil when the player is gone.
    func readState() -> PlayerState?
    /// false = player gone / cannot subscribe.
    func observe(_ events: PlayerFacadeEvents) -> Bool
    func unobserve()
    /// deinit sentinel; false = player gone.
    func observeRelease(_ onRelease: @escaping () -> Void) -> Bool
    /// Drop the release sentinel installed by `observeRelease`. Called on EVERY
    /// teardown path (Media3 round-8 #1 parity), including on an integration
    /// that never attached — a registration revoked, cancelled or refused before
    /// the drain reached it still owns a subscription on the customer's player.
    /// It must never fire `onRelease`: the player is alive, only our interest in
    /// it has ended. Idempotent.
    func unobserveRelease()
}

/// Fires `onDeinit` when it deallocates — which, associated to an `AVPlayer`,
/// is when that player deallocates.
///
/// `armed` exists because `unobserveRelease` drops the association, and dropping
/// it deallocates the sentinel THERE AND THEN. A `deinit` that still fired on
/// that path would report a release for a player that is very much alive, which
/// is the exact false positive the sentinel exists to avoid.
private final class DeinitSentinel {
    private let armed = Locked(true)
    private let onDeinit: () -> Void
    init(_ onDeinit: @escaping () -> Void) { self.onDeinit = onDeinit }
    func disarm() { armed.mutate { $0 = false } }
    deinit { if armed.value { onDeinit() } }
}

final class AVPlayerFacade: PlayerFacade, @unchecked Sendable {
    private weak var player: AVPlayer?
    private let queue: DispatchQueue
    private let lock = NSLock()
    private var playerObservations: [NSKeyValueObservation] = []
    private var itemObservations: [NSKeyValueObservation] = []
    private var notificationTokens: [NSObjectProtocol] = []
    private var timeObserver: Any?
    private var events: PlayerFacadeEvents?
    /// Bumped by every `observe()` and every `unobserve()`, read under `lock`. KVO callbacks
    /// carry the generation they were installed for, so one that entered before an `unobserve()`
    /// and resumes after it cannot rebuild this facade's observers — see `itemDidChange`.
    private var observationGeneration: UInt64 = 0
    /// Bumped by every `observeItem` — i.e. by `observe()` and by each `currentItem` change.
    /// See `PlayerFacade.currentItemGeneration` for what it is for (round-2, #6).
    private var itemGeneration: UInt64 = 0
    /// The item `observeItem` last registered for, i.e. the one `itemGeneration` names. WEAK —
    /// this facade holds its player weakly and must not be the thing keeping an item alive.
    /// Read by `readTick()` (round-7, W7-I1) to prove that the position it is about to read
    /// belongs to the generation it is about to stamp on it.
    private weak var observedItem: AVPlayerItem?
    /// WEAK, and it must stay weak. The association is the sentinel's only owner:
    /// hold it strongly here and a facade that outlives its player — the normal
    /// case, since the integration owns the facade — keeps the sentinel alive past
    /// the player's dealloc, its `deinit` never runs, and the release is never
    /// reported at all. The weak reference is valid for exactly as long as the
    /// association is, which is exactly when `unobserveRelease` has anything to do.
    private weak var sentinel: DeinitSentinel?
    /// The associated-object key, UNIQUE PER FACADE. A single shared key would
    /// make a second `observeRelease` on the same `AVPlayer` — two Everframe SDK
    /// registrations for one player, or a re-registration after a detach —
    /// REPLACE the first facade's association, deallocating its sentinel and
    /// reporting a release for a player that is still alive and still tracked.
    /// The address is the identity; the byte itself is never read or written.
    private let sentinelKey = UnsafeMutableRawPointer.allocate(byteCount: 1, alignment: 1)

    init(player: AVPlayer, queue: DispatchQueue = VitalsQueue.shared) { self.player = player; self.queue = queue }

    /// Dropping the association BEFORE freeing the key matters: the allocator can
    /// hand the same address to the next facade, and an association still keyed on
    /// it would then be clobbered by that facade's own `observeRelease` — the very
    /// collision the per-instance key exists to prevent.
    /// Round-1, O9 — `unobserve()` too: a facade deallocated without a prior `detach()` would
    /// otherwise leave a periodic time observer on a live player, which AVFoundation documents
    /// as undefined behaviour. Every current path detaches first; this is defence in depth.
    deinit {
        unobserve()
        unobserveRelease()
        sentinelKey.deallocate()
    }

    /// `events` is written under `lock` by `observe`/`unobserve` and read from
    /// every KVO and notification callback, each arriving on whatever thread
    /// AVFoundation chose. Reading it bare raced `unobserve`'s clear.
    private var currentEvents: PlayerFacadeEvents? { lock.lock(); defer { lock.unlock() }; return events }

    var isAlive: Bool { player != nil }
    var currentItemGeneration: UInt64 { lock.lock(); defer { lock.unlock() }; return itemGeneration }

    private static func ms(_ t: CMTime) -> Int64 { t.isNumeric ? Int64((CMTimeGetSeconds(t) * 1000).rounded()) : 0 }
    private static func timeControl(_ p: AVPlayer) -> TimeControl {
        switch p.timeControlStatus {
        case .paused: return .paused
        case .waitingToPlayAtSpecifiedRate: return .waitingToPlay(toMinimizeStalls: p.reasonForWaitingToPlay == .toMinimizeStalls)
        case .playing: return .playing
        @unknown default: return .paused
        }
    }
    private static func itemStatus(_ item: AVPlayerItem?) -> ItemStatus {
        guard let item else { return .unknown }
        switch item.status {
        case .readyToPlay: return .readyToPlay
        case .failed:
            let e = item.error as NSError?
            return .failed(domain: e?.domain ?? "AVFoundation", code: e?.code ?? 0, message: e?.localizedDescription ?? "failed")
        default: return .unknown
        }
    }
    /// `AVPlayerItem.asset` is `@MainActor`-isolated in the Xcode 26 Everframe SDK for one
    /// reason: `AVAsset` is not `Sendable`. The only asset this facade ever wants
    /// is `AVURLAsset`, which IS `Sendable` — and every caller here runs on
    /// whatever thread AVFoundation delivered a KVO change or a notification on,
    /// never reliably the main actor, so `assumeIsolated` would trap and a hop
    /// would reorder the callback against the state the integration is deriving
    /// from it. KVC is `nonisolated`, `asset` is a plain readonly ObjC property,
    /// and the cast throws away everything that is not the Sendable subclass.
    private static func urlAsset(_ item: AVPlayerItem?) -> AVURLAsset? {
        item?.value(forKey: "asset") as? AVURLAsset
    }

    /// KNOWN LIMITATION (codex round-1, O1 — documented, not detected). This recognises
    /// FairPlay only through the asset's resource-loader delegate, the classic
    /// `AVAssetResourceLoader` key-delivery route. Content protected through an
    /// `AVContentKeySession` reports `keySystem: "none"`: AVFoundation exposes no public way to
    /// ask an asset which content-key sessions it has been added to, and the Everframe SDK never sees the
    /// app's session object. Spec §3's mapping table and the docs page both say so; if
    /// AVFoundation ever exposes the recipient list, this is the one place that has to change.
    private static func isFairPlay(_ item: AVPlayerItem?) -> Bool {
        guard let asset = urlAsset(item) else { return false }
        return asset.resourceLoader.delegate != nil
    }
    private static func ranges(_ item: AVPlayerItem?) -> [(start: Int64, end: Int64)] {
        (item?.loadedTimeRanges ?? []).map { $0.timeRangeValue }.map { (start: ms($0.start), end: ms(CMTimeAdd($0.start, $0.duration))) }
    }

    /// The item's cumulative counters as they stand, under the generation the caller names.
    /// Shared by the new-entry notification and by `readAccessLog()`'s pull, so the two can
    /// never disagree about what a snapshot of this item contains.
    private static func accessLogSnapshot(_ item: AVPlayerItem, itemGeneration: UInt64) -> AccessLogSnapshot? {
        guard let log = item.accessLog(), let last = log.events.last else { return nil }
        let dropped = log.events.reduce(0) { $0 + max(0, $1.numberOfDroppedVideoFrames) }
        return AccessLogSnapshot(indicatedBitrate: last.indicatedBitrate, observedBitrate: last.observedBitrate, droppedFramesTotal: dropped,
                                 playbackType: last.playbackType, startupTimeMs: last.startupTime >= 0 ? Int64((last.startupTime * 1000).rounded()) : nil,
                                 preferredPeakBitRate: item.preferredPeakBitRate, itemGeneration: itemGeneration)
    }

    /// See `PlayerFacade.readAccessLog`. Same registration binding as `readTick()`: the counters
    /// and the generation stamped on them are read in ONE critical section, and an item this
    /// facade has no registration for reports nothing rather than borrowing its predecessor's
    /// generation. No callback is made from here, so the lock is never held into the integration.
    func readAccessLog() -> AccessLogSnapshot? {
        lock.lock(); defer { lock.unlock() }
        guard let item = player?.currentItem, item === observedItem else { return nil }
        return Self.accessLogSnapshot(item, itemGeneration: itemGeneration)
    }

    func readState() -> PlayerState? {
        guard let p = player else { return nil }
        let item = p.currentItem
        let size = item?.presentationSize ?? .zero
        return PlayerState(item: item.map { ItemIdentity(url: Self.urlAsset($0)?.url) }, isFairPlay: Self.isFairPlay(item), preferredPeakBitRate: item?.preferredPeakBitRate ?? 0,
                           timeControl: Self.timeControl(p), rate: p.rate, itemStatus: Self.itemStatus(item),
                           presentationWidth: Int(size.width), presentationHeight: Int(size.height),
                           currentTimeMs: Self.ms(p.currentTime()), loadedRangesMs: Self.ranges(item))
    }

    func observe(_ events: PlayerFacadeEvents) -> Bool {
        guard let p = player else { return false }
        lock.lock(); defer { lock.unlock() }
        self.events = events
        observationGeneration &+= 1
        let gen = observationGeneration
        playerObservations = [
            p.observe(\.currentItem, options: [.new]) { [weak self] p, _ in self?.itemDidChange(p.currentItem, gen: gen) },
            p.observe(\.timeControlStatus, options: [.new]) { [weak self] p, _ in self?.currentEvents?.onTimeControlChanged?(Self.timeControl(p)) },
            p.observe(\.rate, options: [.new]) { [weak self] p, _ in self?.currentEvents?.onRateChanged?(p.rate) },
            // PLAYER-level, not item-scoped: it reports only `.failed`, and it carries no item
            // generation because there is no item registration behind it (round-3, #2).
            p.observe(\.status, options: [.new]) { [weak self] p, _ in
                if p.status == .failed { let e = p.error as NSError?; self?.currentEvents?.onItemStatusChanged?(.failed(domain: e?.domain ?? "AVFoundation", code: e?.code ?? 0, message: e?.localizedDescription ?? "failed"), nil) }
            },
        ]
        // Round-2, M6 — `attach()`'s double-attach guard means this is unreachable today, but
        // overwriting `timeObserver` without removing the previous one leaks it on a live player,
        // which AVFoundation documents as undefined behaviour on the player's own teardown. The
        // `NSKeyValueObservation` arrays above are safe (assigning invalidates the old ones);
        // only this one needs saying. Same defence in depth as O9's `deinit`.
        if let previous = timeObserver { p.removeTimeObserver(previous); timeObserver = nil }
        // Round-7, W7-I1 — the delivered `CMTime` is DISCARDED. It is the position as of whenever
        // AVFoundation scheduled this block, with nothing tying it to an item; a tick that queued
        // behind an item change reported the OLD item's position for the new one. `readTick()`
        // re-reads the position from the item that is current now, with the generation naming it,
        // in one critical section — and reports nothing when there is no such item, which costs
        // at most one second's tick.
        timeObserver = p.addPeriodicTimeObserver(forInterval: CMTime(seconds: 1, preferredTimescale: 600), queue: queue) { [weak self] _ in
            guard let self, let tick = self.readTick() else { return }
            self.currentEvents?.onPeriodicTime?(tick.ms, tick.gen)
        }
        _ = observeItem(p.currentItem)
        return true
    }

    /// Codex round-1, #8 — an item-change callback that entered before `unobserve()` and
    /// resumed after it used to call `observeItem` unconditionally, installing fresh KVO and
    /// notification registrations on a facade that is already dead: the integration's later
    /// detach skips `unobserve()` (it is not attached any more), so those observers outlived
    /// the attachment for as long as the handle kept the facade alive. Liveness AND the
    /// observation generation are checked in the same critical section that rebuilds them, so
    /// a callback from an earlier attachment cannot mutate a later one either.
    /// Private: production reaches it through the `currentItem` KVO registration in `observe()`.
    /// `AVPlayerFacadeReleaseTests` replays a resumed-after-unobserve callback through the thin
    /// `__replayItemDidChangeForTesting` wrapper below rather than through this one, so the only
    /// MUTATING entry point the module can reach is named for what it is (round-2, M5).
    ///
    /// Codex round-4, #1 — the observation generation identifies the ATTACHMENT, not the item
    /// change, so on its own it cannot tell a stalled callback from a current one WITHIN one
    /// attachment. Callback A reads `p.currentItem` as A at the KVO block above and stalls before
    /// taking this lock; callback B installs B's observers and delivers its change; A resumes,
    /// passes the same observation-generation check, and rebuilds the observers for A under a
    /// NEWER item generation — which the integration adopts (`gen > itemGeneration`), so B's
    /// access-log, loaded-range, size and status observations are gone and every later callback
    /// for B is dropped, until some further item replacement happens to rebuild them.
    ///
    /// The item the callback captured is therefore checked against the player's CURRENT item, in
    /// the same critical section that rebuilds the observers — an item that is no longer current
    /// is not one this facade should be observing, whatever generation the callback carries. The
    /// item that IS current has its own `currentItem` KVO callback either in flight or already
    /// applied, so nothing is left unobserved.
    private func itemDidChange(_ item: AVPlayerItem?, gen: UInt64) {
        lock.lock()
        let live = gen == observationGeneration && events != nil && item === player?.currentItem
        // The generation THIS change installed, carried to the integration rather than re-read
        // from the facade when the callback is finally processed (round-3, #2).
        let itemGen: UInt64? = live ? observeItem(item) : nil
        lock.unlock()
        guard live, let itemGen else { return }
        currentEvents?.onItemChanged?(item.map { ItemIdentity(url: Self.urlAsset($0)?.url) }, Self.isFairPlay(item), item?.preferredPeakBitRate ?? 0, itemGen)
        seedReplacementState(item, itemGen: itemGen)
    }

    /// Codex round-5, W5-I6 — the replacement item's state as it ALREADY IS.
    ///
    /// `observeItem` registers with `options: [.new]`, so nothing above fires until a value
    /// CHANGES. Attachment does not care, because `attach()` seeds itself from `readState()`;
    /// a replacement had no equivalent. Hand an already-prepared item to `replaceCurrentItem`
    /// — a paused, fully buffered item whose resolution and loaded ranges are settled — and
    /// `onItem` cleared those caches (round-4, W4-I5) while nothing ever refilled them: `stats`
    /// reported zero buffer ahead and no dimensions for as long as that item stayed unchanged,
    /// and its established readiness was never reported at all.
    ///
    /// Delivered OUTSIDE the facade lock, and as ordinary generation-tagged callbacks, which is
    /// what keeps this a seed rather than a new lock edge: adding `.initial` to the observations
    /// would fire them synchronously from inside `observeItem` — under this lock, into customer
    /// code — which is exactly the edge three waves have been removing. Each value is delivered
    /// only when it says something (`.unknown` status, a zero size, no ranges say nothing), so
    /// an ordinary empty replacement is silent and the KVO callbacks that follow are unchanged.
    private func seedReplacementState(_ item: AVPlayerItem?, itemGen: UInt64) {
        guard let item, let events = currentEvents else { return }
        // Codex round-6, W6-M11 — this fires for `.failed` too, and that is DELIBERATE. A
        // `.failed` reaches `onFatal`, which is not generation-gated, so replacing into an
        // already-failed item now emits an `error` event where nothing was emitted before: the
        // status observer registers with `options: [.new]`, so an item that had already failed
        // when it was handed to `replaceCurrentItem` never fired one and the failure was silent.
        // Reporting it is the honest answer, and it cannot duplicate — the `.new` observer will
        // not re-fire a status that does not change. Recorded in the changelog as a behaviour
        // change rather than gated away.
        let status = Self.itemStatus(item)
        if status != .unknown { events.onItemStatusChanged?(status, itemGen) }
        let size = item.presentationSize
        if size.width > 0 || size.height > 0 { events.onPresentationSizeChanged?(Int(size.width), Int(size.height), itemGen) }
        let loaded = Self.ranges(item)
        if !loaded.isEmpty { events.onLoadedRangesChanged?(loaded, itemGen) }
    }

    /// Called with `lock` held. Re-registers item observers for the new item, under a fresh
    /// item generation that every per-item callback below carries with it (round-2, #6). The
    /// bump happens for a nil item too: a playlist end ends the previous item's state as surely
    /// as a replacement does, and a late callback from it must not be adopted either.
    @discardableResult
    private func observeItem(_ item: AVPlayerItem?) -> UInt64 {
        itemObservations.forEach { $0.invalidate() }; itemObservations = []
        notificationTokens.forEach { NotificationCenter.default.removeObserver($0) }; notificationTokens = []
        itemGeneration &+= 1
        let itemGen = itemGeneration
        observedItem = item
        guard let item else { return itemGen }
        itemObservations = [
            item.observe(\.status, options: [.new]) { [weak self] item, _ in self?.currentEvents?.onItemStatusChanged?(Self.itemStatus(item), itemGen) },
            item.observe(\.presentationSize, options: [.new]) { [weak self] item, _ in self?.currentEvents?.onPresentationSizeChanged?(Int(item.presentationSize.width), Int(item.presentationSize.height), itemGen) },
            item.observe(\.loadedTimeRanges, options: [.new]) { [weak self] item, _ in self?.currentEvents?.onLoadedRangesChanged?(Self.ranges(item), itemGen) },
        ]
        let nc = NotificationCenter.default
        notificationTokens = [
            nc.addObserver(forName: .AVPlayerItemNewAccessLogEntry, object: item, queue: nil) { [weak self, weak item] _ in
                guard let item, let s = Self.accessLogSnapshot(item, itemGeneration: itemGen) else { return }
                self?.currentEvents?.onAccessLogEntry?(s)
            },
            nc.addObserver(forName: .AVPlayerItemNewErrorLogEntry, object: item, queue: nil) { [weak self, weak item] _ in
                guard let last = item?.errorLog()?.events.last else { return }
                self?.currentEvents?.onErrorLogEntry?(ErrorLogSnapshot(errorStatusCode: last.errorStatusCode, errorDomain: last.errorDomain, errorComment: last.errorComment,
                                                               uriHost: last.uri.flatMap { URL(string: $0)?.host }))
            },
            nc.addObserver(forName: AVPlayerItem.timeJumpedNotification, object: item, queue: nil) { [weak self, weak item] _ in
                guard let item else { return }
                self?.currentEvents?.onTimeJumped?(Self.ms(item.currentTime()), itemGen)
            },
            nc.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: nil) { [weak self] n in
                let e = n.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? NSError
                self?.currentEvents?.onFailedToPlayToEnd?(e?.domain ?? "AVFoundation", e?.code ?? 0, e?.localizedDescription ?? "failed to play to end")
            },
        ]
        return itemGen
    }

    /// The current item's position AND the generation that names it, read in one critical
    /// section (round-7, W7-I1). `nil` when there is nothing to report: no player, no current
    /// item, or a current item this facade has not registered for yet — in that last case
    /// `itemGeneration` still names the PREVIOUS item, so stamping it on this item's position
    /// would be the very mislabelling the tick is being fixed to avoid. The `currentItem` KVO
    /// callback for it is already in flight, and the next tick a second later lands normally.
    ///
    /// No callback is made from here, so the lock is never held into the integration.
    private func readTick() -> (ms: Int64, gen: UInt64)? {
        lock.lock(); defer { lock.unlock() }
        guard let item = player?.currentItem, item === observedItem else { return nil }
        return (Self.ms(item.currentTime()), itemGeneration)
    }

    func unobserve() {
        lock.lock()
        observationGeneration &+= 1      // every outstanding callback is now stale (#8)
        playerObservations.forEach { $0.invalidate() }; playerObservations = []
        itemObservations.forEach { $0.invalidate() }; itemObservations = []
        notificationTokens.forEach { NotificationCenter.default.removeObserver($0) }; notificationTokens = []
        observedItem = nil
        if let t = timeObserver, let p = player { p.removeTimeObserver(t) }
        timeObserver = nil
        events = nil
        lock.unlock()
    }

    /// Test seams for round-1, #8: the generation an in-flight callback would be carrying, and
    /// how many observer registrations this facade is currently holding. Both read-only.
    var observationGenerationForTesting: UInt64 { lock.lock(); defer { lock.unlock() }; return observationGeneration }
    var installedObserverCountForTesting: Int {
        lock.lock(); defer { lock.unlock() }
        return playerObservations.count + itemObservations.count + notificationTokens.count + (timeObserver != nil ? 1 : 0)
    }
    /// The one MUTATING seam, named for it (round-2, M5): replays the `currentItem` KVO callback
    /// an `unobserve()` interrupted. Production never calls this.
    func __replayItemDidChangeForTesting(_ item: AVPlayerItem?, gen: UInt64) { itemDidChange(item, gen: gen) }
    /// Read-only seam for round-7, W7-I1: what the periodic observer would report right now.
    /// Pins that the tick is bound to the REGISTERED item — nil when there is none.
    func __readTickForTesting() -> (ms: Int64, gen: UInt64)? { readTick() }

    /// Round-1, O10 — publishing `sentinel` and installing the association are ONE critical
    /// section. Split, an `unobserveRelease()` interleaved between them disarmed a sentinel that
    /// was then installed anyway, and a real release afterwards reported nothing at all.
    ///
    /// Taking `lock` across `objc_setAssociatedObject` is safe, though not for the narrow reason
    /// round 1 gave: setting the association here releases whatever was under this facade's key
    /// (its own previous sentinel), and CLEARING one in `unobserveRelease` can equally run
    /// ANOTHER facade's sentinel deinit on the same player. Neither is a hazard because no
    /// sentinel callback takes a lock inline any more — round-1's Critical 2 moved the release
    /// processing onto `releaseQueue` — and a sentinel dropped by its owner is disarmed first.
    func observeRelease(_ onRelease: @escaping () -> Void) -> Bool {
        guard let p = player else { return false }
        let s = DeinitSentinel(onRelease)
        lock.lock()
        sentinel = s
        objc_setAssociatedObject(p, sentinelKey, s, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        lock.unlock()
        return true
    }

    func unobserveRelease() {
        lock.lock()
        let s = sentinel; sentinel = nil
        // Disarm FIRST: niling the association releases the last strong reference,
        // so the sentinel's deinit runs inside the very next statement. A nil `s`
        // means the player already went away and the sentinel already fired.
        s?.disarm()
        // Inside the lock for O10's other direction: dropping the association after releasing
        // the lock could clobber an association a concurrent `observeRelease` had just installed.
        if let p = player { objc_setAssociatedObject(p, sentinelKey, nil, .OBJC_ASSOCIATION_RETAIN_NONATOMIC) }
        lock.unlock()
    }
}
